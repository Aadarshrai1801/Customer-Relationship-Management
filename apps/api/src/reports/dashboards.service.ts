import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { dashboards, users, type Dashboard } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { checkRecordAccess } from '../rbac/permissions';
import type { CreateDashboardInput, UpdateDashboardInput } from './dashboards.schemas';

export interface SerializedDashboard {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  name: string;
  isDefault: boolean;
  layout: Array<Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
}

function parseCursor(cursor: string): { time: Date; id: string } | null {
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const time = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(time.getTime()) || !id) return null;
  return { time, id };
}

function recordForbidden(): never {
  throw new ForbiddenException({
    message: 'Not allowed to access this record',
    code: 'RECORD_FORBIDDEN',
  });
}

@Injectable()
export class DashboardsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(
    auth: AuthContext,
    input: CreateDashboardInput,
  ): Promise<{ dashboard: SerializedDashboard }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      this.assertWidgetKeysUnique(input.layout);
      const [created] = await db
        .insert(dashboards)
        .values({
          orgId: auth.org.id,
          ownerId: auth.user.id,
          name: input.name,
          isDefault: input.isDefault,
          layout: input.layout,
        })
        .returning();
      if (!created) throw new Error('Dashboard insert returned no row');
      if (input.isDefault) {
        await this.clearOtherDefaults(db, auth.org.id, auth.user.id, created.id);
      }
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'dashboard.created',
        entityType: 'dashboard',
        entityId: created.id,
        newValues: { name: created.name, widgets: input.layout.length },
      });
      return { dashboard: await this.serializeById(db, auth, created.id) };
    });
  }

  async list(
    auth: AuthContext,
    query: { limit?: number; cursor?: string },
  ): Promise<{ dashboards: SerializedDashboard[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [eq(dashboards.orgId, auth.org.id), isNull(dashboards.deletedAt)];
      const canSeeAll = this.recordScope(auth) === 'all';
      if (!canSeeAll) {
        conditions.push(eq(dashboards.ownerId, auth.user.id));
      }
      if (query.cursor) {
        const parsed = parseCursor(query.cursor);
        if (!parsed) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
        conditions.push(
          sql`(${dashboards.createdAt}, ${dashboards.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ dashboard: dashboards, owner: users })
        .from(dashboards)
        .leftJoin(users, eq(dashboards.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(asc(dashboards.createdAt), asc(dashboards.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const serialized = page.map((row) => this.serialize(row.dashboard, row.owner));
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? `${last.dashboard.createdAt.toISOString()}|${last.dashboard.id}`
          : null;
      return { dashboards: serialized, nextCursor };
    });
  }

  async getById(auth: AuthContext, id: string): Promise<SerializedDashboard> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return this.serializeById(db, auth, id);
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    patch: UpdateDashboardInput,
  ): Promise<{ dashboard: SerializedDashboard }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveDashboard(db, auth.org.id, id);
      this.assertDashboardReadable(auth, row.ownerId);
      if (patch.layout) this.assertWidgetKeysUnique(patch.layout);
      const [updated] = await db
        .update(dashboards)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
          ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
          updatedAt: new Date(),
        })
        .where(eq(dashboards.id, row.id))
        .returning();
      if (!updated) throw new Error('Dashboard update returned no row');
      if (patch.isDefault) {
        await this.clearOtherDefaults(db, auth.org.id, row.ownerId, updated.id);
      }
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'dashboard.updated',
        entityType: 'dashboard',
        entityId: updated.id,
        oldValues: { name: row.name },
        newValues: { name: updated.name },
      });
      return { dashboard: await this.serializeById(db, auth, updated.id) };
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveDashboard(db, auth.org.id, id);
      this.assertDashboardReadable(auth, row.ownerId);
      await db.update(dashboards).set({ deletedAt: new Date() }).where(eq(dashboards.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'dashboard.deleted',
        entityType: 'dashboard',
        entityId: row.id,
        oldValues: { name: row.name },
      });
      return { ok: true as const };
    });
  }

  private recordScope(auth: AuthContext): 'all' | 'own' {
    return auth.role.permissions?.recordAccess?.['dashboard'] ?? 'own';
  }

  private assertDashboardReadable(auth: AuthContext, ownerId: string | null): void {
    try {
      checkRecordAccess(auth.role.permissions, 'dashboard', ownerId ?? '', auth.user.id);
    } catch {
      recordForbidden();
    }
  }

  private assertWidgetKeysUnique(layout: Array<{ key: string }>): void {
    const keys = layout.map((w) => w.key);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException({
        message: 'Widget keys must be unique within a dashboard',
        code: 'DUPLICATE_WIDGET_KEY',
      });
    }
  }

  private async clearOtherDefaults(
    db: NexusDb,
    orgId: string,
    ownerId: string | null,
    exceptId: string,
  ): Promise<void> {
    if (!ownerId) return;
    await db
      .update(dashboards)
      .set({ isDefault: false })
      .where(
        and(
          eq(dashboards.orgId, orgId),
          eq(dashboards.ownerId, ownerId),
          isNull(dashboards.deletedAt),
          sql`${dashboards.id} != ${exceptId}::uuid`,
        ),
      );
  }

  private async requireLiveDashboard(db: NexusDb, orgId: string, id: string): Promise<Dashboard> {
    const [row] = await db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.id, id), eq(dashboards.orgId, orgId), isNull(dashboards.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Dashboard not found', code: 'DASHBOARD_NOT_FOUND' });
    }
    return row;
  }

  private async serializeById(
    db: NexusDb,
    auth: AuthContext,
    id: string,
  ): Promise<SerializedDashboard> {
    const [row] = await db
      .select({ dashboard: dashboards, owner: users })
      .from(dashboards)
      .leftJoin(users, eq(dashboards.ownerId, users.id))
      .where(
        and(eq(dashboards.id, id), eq(dashboards.orgId, auth.org.id), isNull(dashboards.deletedAt)),
      );
    if (!row) {
      throw new NotFoundException({ message: 'Dashboard not found', code: 'DASHBOARD_NOT_FOUND' });
    }
    this.assertDashboardReadable(auth, row.dashboard.ownerId);
    return this.serialize(row.dashboard, row.owner);
  }

  private serialize(
    dashboard: Dashboard,
    owner: { id: string; name: string } | null,
  ): SerializedDashboard {
    return {
      id: dashboard.id,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      ownerId: dashboard.ownerId,
      name: dashboard.name,
      isDefault: dashboard.isDefault,
      layout: (dashboard.layout ?? []) as Array<Record<string, unknown>>,
      createdAt: dashboard.createdAt,
      updatedAt: dashboard.updatedAt,
    };
  }
}
