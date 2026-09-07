import {
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  activities,
  auditLogEntries,
  comments,
  contactNotes,
  contacts,
  deals,
  leads,
  slaPolicies,
  tasks,
  type SlaPolicy,
} from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import type { CreateSlaPolicyInput, UpdateSlaPolicyInput } from './sla.schemas';

export interface SlaBreach {
  policyId: string;
  policyName: string;
  entity: string;
  recordId: string;
  recordName: string;
  hoursOverdue: number;
  ageHours: number;
}

/**
 * Module 14 (PRD 4.4 P2): SLA policies evaluated on demand (no schedule —
 * the endpoint doubles as the manager widget feed).
 * - first_response: first engagement after creation (activity, note,
 *   comment, email, or any status/field change for leads).
 * - resolution: converted leads, closed deals, completed/cancelled tasks.
 */
@Injectable()
export class SlaService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createPolicy(auth: AuthContext, input: CreateSlaPolicyInput) {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [created] = await db
        .insert(slaPolicies)
        .values({
          orgId: auth.org.id,
          name: input.name,
          entity: input.entity,
          metric: input.metric,
          hours: input.hours,
          isActive: input.isActive,
        })
        .returning();
      if (!created) throw new Error('SLA policy insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'sla_policy.created',
        entityType: 'sla_policy',
        entityId: created.id,
        newValues: { name: created.name, entity: created.entity, hours: created.hours },
      });
      return { policy: created };
    });
  }

  async listPolicies(auth: AuthContext) {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return db
        .select()
        .from(slaPolicies)
        .where(and(eq(slaPolicies.orgId, auth.org.id), isNull(slaPolicies.deletedAt)))
        .orderBy(desc(slaPolicies.createdAt));
    });
  }

  async updatePolicy(auth: AuthContext, id: string, patch: UpdateSlaPolicyInput) {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const policy = await this.requirePolicy(db, auth.org.id, id);
      const [updated] = await db
        .update(slaPolicies)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.hours !== undefined ? { hours: patch.hours } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(slaPolicies.id, policy.id))
        .returning();
      if (!updated) throw new Error('SLA policy update returned no row');
      return { policy: updated };
    });
  }

  async removePolicy(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const policy = await this.requirePolicy(db, auth.org.id, id);
      await db.update(slaPolicies).set({ deletedAt: new Date() }).where(eq(slaPolicies.id, policy.id));
      return { ok: true as const };
    });
  }

  async breaches(auth: AuthContext): Promise<{ breaches: SlaBreach[] }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const policies = await db
        .select()
        .from(slaPolicies)
        .where(
          and(
            eq(slaPolicies.orgId, auth.org.id),
            eq(slaPolicies.isActive, true),
            isNull(slaPolicies.deletedAt),
          ),
        );
      const breaches: SlaBreach[] = [];
      for (const policy of policies) {
        if (policy.entity === 'lead') breaches.push(...(await this.leadBreaches(db, auth, policy)));
        else if (policy.entity === 'deal') breaches.push(...(await this.dealBreaches(db, auth, policy)));
        else breaches.push(...(await this.taskBreaches(db, auth, policy)));
      }
      breaches.sort((a, b) => b.hoursOverdue - a.hoursOverdue);
      return { breaches };
    });
  }

  private async leadBreaches(db: NexusDb, auth: AuthContext, policy: SlaPolicy): Promise<SlaBreach[]> {
    const scopeAll = this.scopeAll(auth, 'lead');
    const rows = await db
      .select({ id: leads.id, name: leads.name, status: leads.status, createdAt: leads.createdAt, ownerId: leads.ownerId })
      .from(leads)
      .where(
        and(
          eq(leads.orgId, auth.org.id),
          ...(scopeAll ? [] : [eq(leads.ownerId, auth.user.id)]),
        ),
      )
      .limit(500);
    const out: SlaBreach[] = [];
    for (const row of rows) {
      if (policy.metric === 'resolution') {
        if (row.status === 'converted' || row.status === 'unqualified') continue;
      } else {
        if (row.status !== 'new') continue;
      }
      const ageHours = (Date.now() - row.createdAt.getTime()) / 3600000;
      if (ageHours > policy.hours) {
        out.push({
          policyId: policy.id,
          policyName: policy.name,
          entity: 'lead',
          recordId: row.id,
          recordName: row.name,
          hoursOverdue: Math.round((ageHours - policy.hours) * 10) / 10,
          ageHours: Math.round(ageHours * 10) / 10,
        });
      }
    }
    return out;
  }

  private async dealBreaches(db: NexusDb, auth: AuthContext, policy: SlaPolicy): Promise<SlaBreach[]> {
    const scopeAll = this.scopeAll(auth, 'deal');
    const rows = await db
      .select({ id: deals.id, name: deals.name, status: deals.status, createdAt: deals.createdAt, ownerId: deals.ownerId })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, auth.org.id),
          isNull(deals.deletedAt),
          ...(policy.metric === 'resolution' ? [eq(deals.status, 'open')] : []),
          ...(scopeAll ? [] : [eq(deals.ownerId, auth.user.id)]),
        ),
      )
      .limit(500);
    const out: SlaBreach[] = [];
    for (const row of rows) {
      let respondedAt: Date | null = null;
      if (policy.metric === 'first_response') {
        respondedAt = await this.firstEngagement(db, auth.org.id, 'deal', row.id, row.createdAt);
        if (respondedAt) continue;
      }
      const ageHours = (Date.now() - row.createdAt.getTime()) / 3600000;
      if (ageHours > policy.hours) {
        out.push({
          policyId: policy.id,
          policyName: policy.name,
          entity: 'deal',
          recordId: row.id,
          recordName: row.name,
          hoursOverdue: Math.round((ageHours - policy.hours) * 10) / 10,
          ageHours: Math.round(ageHours * 10) / 10,
        });
      }
    }
    return out;
  }

  private async taskBreaches(db: NexusDb, auth: AuthContext, policy: SlaPolicy): Promise<SlaBreach[]> {
    const scopeAll = this.scopeAll(auth, 'task');
    const rows = await db
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, createdAt: tasks.createdAt, ownerId: tasks.ownerId })
      .from(tasks)
      .where(
        and(
          eq(tasks.orgId, auth.org.id),
          isNull(tasks.deletedAt),
          ...(policy.metric === 'resolution' ? [eq(tasks.status, 'open')] : []),
          ...(scopeAll ? [] : [eq(tasks.ownerId, auth.user.id)]),
        ),
      )
      .limit(500);
    const out: SlaBreach[] = [];
    for (const row of rows) {
      if (policy.metric === 'first_response') {
        const respondedAt = await this.firstEngagement(db, auth.org.id, 'task', row.id, row.createdAt);
        if (respondedAt) continue;
      }
      const ageHours = (Date.now() - row.createdAt.getTime()) / 3600000;
      if (ageHours > policy.hours) {
        out.push({
          policyId: policy.id,
          policyName: policy.name,
          entity: 'task',
          recordId: row.id,
          recordName: row.title,
          hoursOverdue: Math.round((ageHours - policy.hours) * 10) / 10,
          ageHours: Math.round(ageHours * 10) / 10,
        });
      }
    }
    return out;
  }

  /** Earliest engagement strictly after creation (excludes create echoes). */
  private async firstEngagement(
    db: NexusDb,
    orgId: string,
    entity: 'deal' | 'task',
    recordId: string,
    createdAt: Date,
  ): Promise<Date | null> {
    const after = new Date(createdAt.getTime() + 1000);
    const [activity] = await db
      .select({ at: activities.occurredAt })
      .from(activities)
      .where(
        and(
          eq(activities.orgId, orgId),
          entity === 'deal' ? eq(activities.dealId, recordId) : eq(activities.taskId, recordId),
          sql`${activities.occurredAt} > ${after}`,
        ),
      )
      .orderBy(activities.occurredAt)
      .limit(1);
    const [comment] = await db
      .select({ at: comments.createdAt })
      .from(comments)
      .where(
        and(
          eq(comments.orgId, orgId),
          eq(comments.entityType, entity),
          eq(comments.entityId, recordId),
          sql`${comments.createdAt} > ${after}`,
        ),
      )
      .orderBy(comments.createdAt)
      .limit(1);
    const [note] =
      entity === 'deal'
        ? await db
            .select({ at: contactNotes.createdAt })
            .from(contactNotes)
            .innerJoin(contacts, eq(contactNotes.contactId, contacts.id))
            .innerJoin(deals, eq(contacts.accountId, deals.accountId))
            .where(
              and(
                eq(contactNotes.orgId, orgId),
                eq(deals.id, recordId),
                sql`${contactNotes.createdAt} > ${after}`,
              ),
            )
            .orderBy(contactNotes.createdAt)
            .limit(1)
        : [undefined];
    const [audit] = await db
      .select({ at: auditLogEntries.createdAt })
      .from(auditLogEntries)
      .where(
        and(
          eq(auditLogEntries.orgId, orgId),
          eq(auditLogEntries.entityType, entity),
          eq(auditLogEntries.entityId, recordId),
          sql`${auditLogEntries.createdAt} > ${after}`,
        ),
      )
      .orderBy(auditLogEntries.createdAt)
      .limit(1);
    const times = [activity?.at, comment?.at, note?.at, audit?.at]
      .filter((d): d is Date => d instanceof Date)
      .map((d) => d.getTime());
    return times.length > 0 ? new Date(Math.min(...times)) : null;
  }

  private scopeAll(auth: AuthContext, entity: string): boolean {
    return (auth.role.permissions?.recordAccess?.[entity] ?? 'own') === 'all';
  }

  private async requirePolicy(db: NexusDb, orgId: string, id: string): Promise<SlaPolicy> {
    const [row] = await db
      .select()
      .from(slaPolicies)
      .where(and(eq(slaPolicies.id, id), eq(slaPolicies.orgId, orgId), isNull(slaPolicies.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'SLA policy not found', code: 'SLA_NOT_FOUND' });
    }
    return row;
  }
}
