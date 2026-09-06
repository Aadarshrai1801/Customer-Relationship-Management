import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { auditLogEntries, type NewAuditLogEntry } from '@nexus/db';
import { IdentityDb, TenantDb, type NexusDb } from '../database/tenant-db.service';
import { requestMetadata } from '../common/request-context';

export interface AuditEntryInput {
  orgId: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditListFilter {
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

/** Shallow diff of two flat snapshots for update entries. */
export function diffObjects(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { oldValues: Record<string, unknown>; newValues: Record<string, unknown> } {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = JSON.stringify(before[key] ?? null);
    const right = JSON.stringify(after[key] ?? null);
    if (left !== right) {
      oldValues[key] = before[key] ?? null;
      newValues[key] = after[key] ?? null;
    }
  }
  return { oldValues, newValues };
}

const MIN_RETENTION_DAYS = 365;

export function effectiveRetentionDays(configured?: number): number {
  if (!configured || !Number.isFinite(configured) || configured <= 0) return MIN_RETENTION_DAYS;
  return Math.max(MIN_RETENTION_DAYS, Math.floor(configured));
}

function parseCursor(cursor: string): { time: Date; id: number } | null {
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const time = new Date(cursor.slice(0, sep));
  const id = Number(cursor.slice(sep + 1));
  if (Number.isNaN(time.getTime()) || !Number.isInteger(id)) return null;
  return { time, id };
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(IdentityDb) private readonly identityDb: IdentityDb,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
  ) {}

  /**
   * Records an entry. Pass the in-flight tenant transaction db to make the
   * audit row atomic with the mutation; otherwise a tenant-scoped transaction
   * is opened for the entry's org (RLS WITH CHECK still applies).
   */
  async record(db: NexusDb, entry: AuditEntryInput): Promise<void>;
  async record(entry: AuditEntryInput): Promise<void>;
  async record(dbOrEntry: NexusDb | AuditEntryInput, entry?: AuditEntryInput): Promise<void> {
    const input = (entry ?? dbOrEntry) as AuditEntryInput;
    const meta = requestMetadata();
    const row: NewAuditLogEntry = {
      orgId: input.orgId,
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      oldValues: input.oldValues ?? null,
      newValues: input.newValues ?? null,
      ipAddress: input.ipAddress ?? meta.ipAddress ?? null,
      userAgent: input.userAgent ?? meta.userAgent ?? null,
    };
    if (entry === undefined) {
      await this.tenantDb.tx(input.orgId, (db) => db.insert(auditLogEntries).values(row));
    } else {
      await (dbOrEntry as NexusDb).insert(auditLogEntries).values(row);
    }
  }

  async list(
    orgId: string,
    filter: AuditListFilter,
  ): Promise<{ entries: (typeof auditLogEntries.$inferSelect)[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    return this.tenantDb.tx(orgId, async (db) => {
      const conditions = [eq(auditLogEntries.orgId, orgId)];
      if (filter.entityType) conditions.push(eq(auditLogEntries.entityType, filter.entityType));
      if (filter.entityId) conditions.push(eq(auditLogEntries.entityId, filter.entityId));
      if (filter.actorUserId) conditions.push(eq(auditLogEntries.actorUserId, filter.actorUserId));
      if (filter.action) conditions.push(eq(auditLogEntries.action, filter.action));
      if (filter.from) conditions.push(sql`${auditLogEntries.createdAt} >= ${filter.from}`);
      if (filter.to) conditions.push(sql`${auditLogEntries.createdAt} <= ${filter.to}`);
      if (filter.cursor) {
        const parsed = parseCursor(filter.cursor);
        if (!parsed) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
        conditions.push(
          sql`(${auditLogEntries.createdAt}, ${auditLogEntries.id}) < (${parsed.time}, ${parsed.id})`,
        );
      }
      const rows = await db
        .select()
        .from(auditLogEntries)
        .where(and(...conditions))
        .orderBy(desc(auditLogEntries.createdAt), desc(auditLogEntries.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const nextCursor =
        rows.length > limit
          ? `${page[page.length - 1]!.createdAt.toISOString()}|${page[page.length - 1]!.id}`
          : null;
      return { entries: page, nextCursor };
    });
  }

  /**
   * Deletes entries older than the retention window (minimum 12 months,
   * per PRD 4.12). Scheduling is wired in PR7 (pg-boss); until then nothing
   * is ever deleted, which trivially satisfies the minimum.
   */
  async purge(configuredDays?: number): Promise<{ deleted: number; retentionDays: number }> {
    const retentionDays = effectiveRetentionDays(configuredDays);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const stale = await this.identityDb.db
      .select({ id: auditLogEntries.id, orgId: auditLogEntries.orgId })
      .from(auditLogEntries)
      .where(lt(auditLogEntries.createdAt, cutoff));
    for (const row of stale) {
      await this.identityDb.db.delete(auditLogEntries).where(eq(auditLogEntries.id, row.id));
    }
    return { deleted: stale.length, retentionDays };
  }
}
