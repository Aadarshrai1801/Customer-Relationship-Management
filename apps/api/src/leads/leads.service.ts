import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, gte, ilike, lt, or, sql } from 'drizzle-orm';
import {
  leads,
  notifications,
  users,
  type Lead,
} from '@nexus/db';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth-context';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import {
  computeFormulas,
  validateCustomFields,
} from '../custom-fields/field-validation';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import { MailService } from '../mail/mail.service';
import { LeadRoutingService } from '../lead-routing/lead-routing.service';
import type { ReassignLeadInput } from '../lead-routing/lead-routing.schemas';
import type {
  CreateLeadInput,
  ListLeadsQuery,
  UpdateLeadInput,
} from './leads.schemas';

export interface SerializedLead {
  id: string;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  company: string | null;
  title: string | null;
  status: string;
  source: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrerUrl: string | null;
  notes: string | null;
  customFields: Record<string, unknown>;
  computedFields: Record<string, unknown>;
  convertedAt: Date | null;
  convertedContactId: string | null;
  convertedAccountId: string | null;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}

interface JoinedLead {
  lead: Lead;
  owner: { id: string; name: string } | null;
}

function validationFailed(errors: Array<{ path: string; message: string }>): never {
  throw new BadRequestException({
    message: 'Validation failed',
    code: 'VALIDATION_ERROR',
    errors,
  });
}

function recordForbidden(): never {
  throw new ForbiddenException({
    message: 'Not allowed to access this record',
    code: 'RECORD_FORBIDDEN',
  });
}

function parseCursor(cursor: string): { time: Date; id: string } | null {
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const time = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(time.getTime()) || !id) return null;
  return { time, id };
}

@Injectable()
export class LeadsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CustomFieldsService) private readonly fields: CustomFieldsService,
    @Inject(LeadRoutingService) private readonly routing: LeadRoutingService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async create(
    auth: AuthContext,
    input: CreateLeadInput,
  ): Promise<{ lead: SerializedLead; deduplicated: boolean }> {
    const result = await this.tenantDb.tx(auth.org.id, async (db) => {
      const lowerEmail = input.email.toLowerCase().trim();

      // 5-minute idempotency / de-duplication window
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const [recent] = await db
        .select({
          lead: leads,
          owner: { id: users.id, name: users.name },
        })
        .from(leads)
        .leftJoin(users, eq(leads.ownerId, users.id))
        .where(
          and(
            eq(leads.orgId, auth.org.id),
            eq(sql`lower(${leads.email})`, lowerEmail),
            gte(leads.createdAt, fiveMinutesAgo),
          ),
        )
        .orderBy(desc(leads.createdAt))
        .limit(1);

      if (recent) {
        // If notes were passed in duplicate submission, append them gracefully
        if (input.notes && input.notes.trim()) {
          const updatedNotes = recent.lead.notes
            ? `${recent.lead.notes}\n---\n${input.notes.trim()}`
            : input.notes.trim();
          await db
            .update(leads)
            .set({ notes: updatedNotes, updatedAt: new Date() })
            .where(eq(leads.id, recent.lead.id));
          recent.lead.notes = updatedNotes;
        }
        const serialized = await this.serializeOne(db, auth, recent);
        return { lead: serialized, deduplicated: true };
      }

      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'lead');
      const ownerId = await this.resolveOwnerForCreate(db, auth, input.ownerId);
      const { values: customFields, issues } = validateCustomFields(defs, input.customFields);
      if (issues.length > 0) {
        validationFailed(
          issues.map((i) => ({ path: `customFields.${i.key}`, message: `${i.key}: ${i.message}` })),
        );
      }

      const computedName =
        input.name?.trim() ||
        [input.firstName?.trim(), input.lastName?.trim()].filter(Boolean).join(' ') ||
        input.email.split('@')[0]!;

      const [created] = await db
        .insert(leads)
        .values({
          orgId: auth.org.id,
          ownerId,
          name: computedName,
          firstName: input.firstName?.trim() || null,
          lastName: input.lastName?.trim() || null,
          email: lowerEmail,
          phone: input.phone?.trim() || null,
          company: input.company?.trim() || null,
          title: input.title?.trim() || null,
          status: input.status ?? 'new',
          source: input.source ?? 'website',
          utmSource: input.utmSource?.trim() || null,
          utmMedium: input.utmMedium?.trim() || null,
          utmCampaign: input.utmCampaign?.trim() || null,
          utmTerm: input.utmTerm?.trim() || null,
          utmContent: input.utmContent?.trim() || null,
          referrerUrl: input.referrerUrl?.trim() || null,
          notes: input.notes?.trim() || null,
          customFields,
        })
        .returning();

      if (!created) throw new Error('Failed to create lead');

      const isRealUser = auth.user?.id && auth.user.id.length === 36 && auth.user.id !== '00000000-0000-0000-0000-000000000000';
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: isRealUser ? auth.user.id : null,
        actorEmail: auth.user?.email || null,
        action: 'lead.created',
        entityType: 'lead',
        entityId: created.id,
        newValues: {
          name: created.name,
          email: created.email,
          company: created.company,
          status: created.status,
          source: created.source,
          ownerId: created.ownerId,
        },
      });

      if (!ownerId) {
        const assigned = await this.routing.assignLead(db, auth.org.id, created.id);
        if (assigned.assignedToUserId) {
          created.ownerId = assigned.assignedToUserId;
        }
      }

      if (created.ownerId) {
        const leadTitle = created.name || created.company || created.email;
        await db.insert(notifications).values({
          orgId: auth.org.id,
          userId: created.ownerId,
          type: 'lead_assigned',
          title: `New Lead Assigned: ${leadTitle}`,
          body: `Lead ${leadTitle}${created.company ? ` (${created.company})` : ''} was assigned to you.`,
          link: `/leads/${created.id}`,
        });
      }

      const finalOwnerId = created.ownerId;
      const owner = finalOwnerId
        ? (await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, finalOwnerId)))[0] ?? null
        : null;

      const serialized = await this.serializeOne(db, auth, { lead: created, owner });
      return { lead: serialized, deduplicated: false };
    });

    if (result.lead.ownerId && !result.deduplicated) {
      try {
        const [assignedUser] = await this.tenantDb.tx(auth.org.id, (db) =>
          db.select({ email: users.email }).from(users).where(eq(users.id, result.lead.ownerId!)),
        );
        if (assignedUser?.email) {
          await this.mail.sendLeadAssignedNotification(
            assignedUser.email,
            auth.org.name,
            {
              id: result.lead.id,
              name: result.lead.name,
              company: result.lead.company,
              email: result.lead.email,
            },
          );
        }
      } catch (mailErr) {
        // Mail delivery is non-blocking
      }
    }

    return result;
  }

  async list(
    auth: AuthContext,
    query: ListLeadsQuery,
  ): Promise<{ items: SerializedLead[]; nextCursor: string | null; total: number }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const scope = this.recordScope(auth);
      const conditions = [eq(leads.orgId, auth.org.id)];

      if (scope === 'own') {
        conditions.push(eq(leads.ownerId, auth.user.id));
      } else if (query.ownerId) {
        conditions.push(eq(leads.ownerId, query.ownerId));
      }

      if (query.status) {
        conditions.push(eq(leads.status, query.status));
      }

      if (query.source) {
        conditions.push(eq(leads.source, query.source));
      }

      if (query.q) {
        const pattern = `%${query.q.trim()}%`;
        conditions.push(
          or(
            ilike(leads.name, pattern),
            ilike(leads.email, pattern),
            ilike(leads.company, pattern),
          )!,
        );
      }

      const countRes = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(leads)
        .where(and(...conditions));
      const total = countRes[0]?.count ?? 0;

      const limit = query.limit ?? 50;
      if (query.cursor) {
        const parsed = parseCursor(query.cursor);
        if (parsed) {
          conditions.push(
            or(
              lt(leads.createdAt, parsed.time),
              and(eq(leads.createdAt, parsed.time), lt(leads.id, parsed.id)),
            )!,
          );
        }
      }

      const rows = await db
        .select({
          lead: leads,
          owner: { id: users.id, name: users.name },
        })
        .from(leads)
        .leftJoin(users, eq(leads.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(leads.createdAt), desc(leads.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && last
          ? `${last.lead.createdAt.toISOString()}|${last.lead.id}`
          : null;

      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'lead');
      const items = pageRows.map((r) => this.applyFieldRules(auth, this.format(r, defs)));

      return { items, nextCursor, total };
    });
  }

  async get(auth: AuthContext, id: string): Promise<SerializedLead> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.findJoined(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'Lead not found', code: 'LEAD_NOT_FOUND' });
      }

      const scope = this.recordScope(auth);
      if (scope === 'own' && row.lead.ownerId !== auth.user.id) {
        recordForbidden();
      }

      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'lead');
      return this.applyFieldRules(auth, this.format(row, defs));
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    input: UpdateLeadInput,
  ): Promise<SerializedLead> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const existing = await this.findJoined(db, auth.org.id, id);
      if (!existing) {
        throw new NotFoundException({ message: 'Lead not found', code: 'LEAD_NOT_FOUND' });
      }

      const scope = this.recordScope(auth);
      if (scope === 'own' && existing.lead.ownerId !== auth.user.id) {
        recordForbidden();
      }

      this.assertWritableFields(auth, input);

      const patch: Partial<typeof leads.$inferInsert> = { updatedAt: new Date() };

      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.firstName !== undefined) patch.firstName = input.firstName?.trim() || null;
      if (input.lastName !== undefined) patch.lastName = input.lastName?.trim() || null;
      if (input.email !== undefined) patch.email = input.email.toLowerCase().trim();
      if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
      if (input.company !== undefined) patch.company = input.company?.trim() || null;
      if (input.title !== undefined) patch.title = input.title?.trim() || null;
      if (input.status !== undefined) patch.status = input.status;
      if (input.source !== undefined) patch.source = input.source;
      if (input.utmSource !== undefined) patch.utmSource = input.utmSource?.trim() || null;
      if (input.utmMedium !== undefined) patch.utmMedium = input.utmMedium?.trim() || null;
      if (input.utmCampaign !== undefined) patch.utmCampaign = input.utmCampaign?.trim() || null;
      if (input.utmTerm !== undefined) patch.utmTerm = input.utmTerm?.trim() || null;
      if (input.utmContent !== undefined) patch.utmContent = input.utmContent?.trim() || null;
      if (input.referrerUrl !== undefined) patch.referrerUrl = input.referrerUrl?.trim() || null;
      if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

      if (input.ownerId !== undefined) {
        patch.ownerId = input.ownerId
          ? await this.resolveOwnerForUpdate(db, auth, input.ownerId)
          : null;
      }

      if (input.customFields !== undefined) {
        const defs = await this.fields.loadDefinitions(db, auth.org.id, 'lead');
        const merged = { ...existing.lead.customFields, ...(input.customFields ?? {}) };
        const { values, issues } = validateCustomFields(defs, merged);
        if (issues.length > 0) {
          validationFailed(
            issues.map((i) => ({ path: `customFields.${i.key}`, message: `${i.key}: ${i.message}` })),
          );
        }
        patch.customFields = values;
      }

      const [updated] = await db
        .update(leads)
        .set(patch)
        .where(eq(leads.id, id))
        .returning();

      if (!updated) throw new Error('Failed to update lead');

      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'lead.updated',
        entityType: 'lead',
        entityId: updated.id,
        newValues: patch as Record<string, unknown>,
        oldValues: {
          name: existing.lead.name,
          email: existing.lead.email,
          status: existing.lead.status,
          ownerId: existing.lead.ownerId,
        },
      });

      const joined = await this.findJoined(db, auth.org.id, id);
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'lead');
      return this.applyFieldRules(auth, this.format(joined!, defs));
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const existing = await this.findJoined(db, auth.org.id, id);
      if (!existing) {
        throw new NotFoundException({ message: 'Lead not found', code: 'LEAD_NOT_FOUND' });
      }

      const scope = this.recordScope(auth);
      if (scope === 'own' && existing.lead.ownerId !== auth.user.id) {
        recordForbidden();
      }

      await db.delete(leads).where(eq(leads.id, id));

      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'lead.deleted',
        entityType: 'lead',
        entityId: id,
        oldValues: {
          name: existing.lead.name,
          email: existing.lead.email,
          status: existing.lead.status,
          ownerId: existing.lead.ownerId,
        },
      });

      return { ok: true as const };
    });
  }

  async reassign(
    auth: AuthContext,
    id: string,
    input: ReassignLeadInput,
  ): Promise<{ ok: true; leadId: string; assignedToUserId: string }> {
    return this.routing.reassignLead(auth, id, input);
  }

  async getAssignmentHistory(auth: AuthContext, id: string) {
    return this.routing.getAssignmentHistory(auth, id);
  }

  private recordScope(auth: AuthContext): 'all' | 'own' {
    return auth.role.permissions.recordAccess?.['lead'] ?? 'all';
  }

  private assertWritableFields(auth: AuthContext, input: UpdateLeadInput): void {
    const fields = auth.role.permissions.fields ?? {};
    for (const key of Object.keys(input)) {
      const rule = fields[key];
      if (rule === 'none' || rule === 'read') {
        throw new ForbiddenException({
          message: `Not allowed to edit field: ${key}`,
          code: 'FIELD_FORBIDDEN',
        });
      }
    }
  }

  private applyFieldRules(auth: AuthContext, lead: SerializedLead): SerializedLead {
    const fields = auth.role.permissions.fields ?? {};
    const out = { ...lead };
    for (const [key, rule] of Object.entries(fields)) {
      if (rule === 'none' && key in out) {
        out[key] = null;
      }
    }
    return out;
  }

  private format(
    row: JoinedLead,
    defs: Array<{ key: string; label: string; type: any; required: boolean; options: Record<string, unknown> }>,
  ): SerializedLead {
    const { computed: computedFields } = computeFormulas(defs, row.lead.customFields);
    return {
      id: row.lead.id,
      ownerId: row.lead.ownerId,
      owner: row.owner,
      name: row.lead.name,
      firstName: row.lead.firstName,
      lastName: row.lead.lastName,
      email: row.lead.email,
      phone: row.lead.phone,
      company: row.lead.company,
      title: row.lead.title,
      status: row.lead.status,
      source: row.lead.source,
      utmSource: row.lead.utmSource,
      utmMedium: row.lead.utmMedium,
      utmCampaign: row.lead.utmCampaign,
      utmTerm: row.lead.utmTerm,
      utmContent: row.lead.utmContent,
      referrerUrl: row.lead.referrerUrl,
      notes: row.lead.notes,
      customFields: row.lead.customFields,
      computedFields,
      convertedAt: row.lead.convertedAt,
      convertedContactId: row.lead.convertedContactId,
      convertedAccountId: row.lead.convertedAccountId,
      createdAt: row.lead.createdAt,
      updatedAt: row.lead.updatedAt,
    };
  }

  private async serializeOne(
    db: NexusDb,
    auth: AuthContext,
    row: JoinedLead,
  ): Promise<SerializedLead> {
    const defs = await this.fields.loadDefinitions(db, auth.org.id, 'lead');
    return this.applyFieldRules(auth, this.format(row, defs));
  }

  private async findJoined(
    db: NexusDb,
    orgId: string,
    id: string,
  ): Promise<JoinedLead | null> {
    const [row] = await db
      .select({
        lead: leads,
        owner: { id: users.id, name: users.name },
      })
      .from(leads)
      .leftJoin(users, eq(leads.ownerId, users.id))
      .where(and(eq(leads.id, id), eq(leads.orgId, orgId)));
    return row ?? null;
  }

  private async resolveOwnerForCreate(
    db: NexusDb,
    auth: AuthContext,
    requestedOwnerId?: string,
  ): Promise<string | null> {
    const scope = this.recordScope(auth);
    if (scope === 'own') return auth.user.id;
    if (!requestedOwnerId) return null;
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, requestedOwnerId), eq(users.orgId, auth.org.id)));
    if (!target) {
      throw new BadRequestException({ message: 'Owner user not found', code: 'OWNER_NOT_FOUND' });
    }
    return target.id;
  }

  private async resolveOwnerForUpdate(
    db: NexusDb,
    auth: AuthContext,
    requestedOwnerId: string,
  ): Promise<string> {
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, requestedOwnerId), eq(users.orgId, auth.org.id)));
    if (!target) {
      throw new BadRequestException({ message: 'Owner user not found', code: 'OWNER_NOT_FOUND' });
    }
    return target.id;
  }
}
