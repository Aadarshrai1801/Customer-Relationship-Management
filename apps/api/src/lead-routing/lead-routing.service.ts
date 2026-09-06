import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  leadAssignmentLogs,
  leadRoutingMembers,
  leadRoutingRules,
  leads,
  notifications,
  repAvailability,
  users,
} from '@nexus/db';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth-context';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import { MailService } from '../mail/mail.service';
import type {
  CreateRoutingRuleInput,
  ReassignLeadInput,
  UpdateAvailabilityInput,
  UpdateRoutingRuleInput,
} from './lead-routing.schemas';

export interface SerializedRoutingMember {
  id: string;
  userId: string;
  user: { id: string; name: string; email: string } | null;
  orderIndex: number;
  isActive: boolean;
}

export interface SerializedRoutingRule {
  id: string;
  name: string;
  strategy: string;
  isActive: boolean;
  fallbackUserId: string | null;
  fallbackUser: { id: string; name: string; email: string } | null;
  lastAssignedIndex: number;
  members: SerializedRoutingMember[];
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class LeadRoutingService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async createRule(
    auth: AuthContext,
    input: CreateRoutingRuleInput,
  ): Promise<SerializedRoutingRule> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [rule] = await db
        .insert(leadRoutingRules)
        .values({
          orgId: auth.org.id,
          name: input.name.trim(),
          strategy: input.strategy ?? 'round_robin',
          isActive: input.isActive ?? true,
          fallbackUserId: input.fallbackUserId ?? null,
        })
        .returning();

      if (!rule) throw new Error('Failed to create routing rule');

      if (input.memberUserIds && input.memberUserIds.length > 0) {
        for (let i = 0; i < input.memberUserIds.length; i++) {
          const userId = input.memberUserIds[i]!;
          await db.insert(leadRoutingMembers).values({
            orgId: auth.org.id,
            ruleId: rule.id,
            userId,
            orderIndex: i,
            isActive: true,
          });
        }
      }

      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'lead_routing.rule_created',
        entityType: 'lead_routing_rule',
        entityId: rule.id,
        newValues: { name: rule.name, strategy: rule.strategy, memberCount: input.memberUserIds?.length ?? 0 },
      });

      return this.formatRule(db, auth.org.id, rule.id);
    });
  }

  async listRules(auth: AuthContext): Promise<SerializedRoutingRule[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rules = await db
        .select()
        .from(leadRoutingRules)
        .where(eq(leadRoutingRules.orgId, auth.org.id))
        .orderBy(desc(leadRoutingRules.createdAt));

      const out: SerializedRoutingRule[] = [];
      for (const r of rules) {
        out.push(await this.formatRule(db, auth.org.id, r.id));
      }
      return out;
    });
  }

  async getRule(auth: AuthContext, id: string): Promise<SerializedRoutingRule> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [rule] = await db
        .select()
        .from(leadRoutingRules)
        .where(and(eq(leadRoutingRules.id, id), eq(leadRoutingRules.orgId, auth.org.id)));

      if (!rule) {
        throw new NotFoundException({ message: 'Routing rule not found', code: 'RULE_NOT_FOUND' });
      }

      return this.formatRule(db, auth.org.id, rule.id);
    });
  }

  async updateRule(
    auth: AuthContext,
    id: string,
    input: UpdateRoutingRuleInput,
  ): Promise<SerializedRoutingRule> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [existing] = await db
        .select()
        .from(leadRoutingRules)
        .where(and(eq(leadRoutingRules.id, id), eq(leadRoutingRules.orgId, auth.org.id)));

      if (!existing) {
        throw new NotFoundException({ message: 'Routing rule not found', code: 'RULE_NOT_FOUND' });
      }

      const patch: Partial<typeof leadRoutingRules.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name.trim();
      if (input.strategy !== undefined) patch.strategy = input.strategy;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      if (input.fallbackUserId !== undefined) patch.fallbackUserId = input.fallbackUserId;

      await db.update(leadRoutingRules).set(patch).where(eq(leadRoutingRules.id, id));

      if (input.memberUserIds !== undefined) {
        await db.delete(leadRoutingMembers).where(eq(leadRoutingMembers.ruleId, id));
        for (let i = 0; i < input.memberUserIds.length; i++) {
          const userId = input.memberUserIds[i]!;
          await db.insert(leadRoutingMembers).values({
            orgId: auth.org.id,
            ruleId: id,
            userId,
            orderIndex: i,
            isActive: true,
          });
        }
      }

      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'lead_routing.rule_updated',
        entityType: 'lead_routing_rule',
        entityId: id,
        newValues: patch as Record<string, unknown>,
      });

      return this.formatRule(db, auth.org.id, id);
    });
  }

  async deleteRule(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [existing] = await db
        .select()
        .from(leadRoutingRules)
        .where(and(eq(leadRoutingRules.id, id), eq(leadRoutingRules.orgId, auth.org.id)));

      if (!existing) {
        throw new NotFoundException({ message: 'Routing rule not found', code: 'RULE_NOT_FOUND' });
      }

      await db.delete(leadRoutingRules).where(eq(leadRoutingRules.id, id));

      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'lead_routing.rule_deleted',
        entityType: 'lead_routing_rule',
        entityId: id,
      });

      return { ok: true as const };
    });
  }

  async getAvailability(
    auth: AuthContext,
    targetUserId?: string,
  ): Promise<{ userId: string; isAvailable: boolean; oooReason: string | null; returnAt: Date | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const userId = targetUserId ?? auth.user.id;
      const [row] = await db
        .select()
        .from(repAvailability)
        .where(and(eq(repAvailability.orgId, auth.org.id), eq(repAvailability.userId, userId)));

      if (!row) {
        return {
          userId,
          isAvailable: true,
          oooReason: null,
          returnAt: null,
        };
      }

      return {
        userId: row.userId,
        isAvailable: row.isAvailable,
        oooReason: row.oooReason,
        returnAt: row.returnAt,
      };
    });
  }

  async setAvailability(
    auth: AuthContext,
    input: UpdateAvailabilityInput,
    targetUserId?: string,
  ): Promise<{ userId: string; isAvailable: boolean; oooReason: string | null; returnAt: Date | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const userId = targetUserId ?? auth.user.id;

      // Non-managers can only change their own availability
      if (userId !== auth.user.id && !auth.role.permissions.scopes.includes('lead_routing:manage') && !auth.role.permissions.scopes.includes('*')) {
        throw new ForbiddenException({
          message: 'Cannot update availability for other reps',
          code: 'AVAILABILITY_FORBIDDEN',
        });
      }

      const [existing] = await db
        .select()
        .from(repAvailability)
        .where(and(eq(repAvailability.orgId, auth.org.id), eq(repAvailability.userId, userId)));

      if (existing) {
        const [updated] = await db
          .update(repAvailability)
          .set({
            isAvailable: input.isAvailable,
            oooReason: input.oooReason ?? null,
            returnAt: input.returnAt ?? null,
            updatedAt: new Date(),
          })
          .where(eq(repAvailability.id, existing.id))
          .returning();

        return {
          userId: updated!.userId,
          isAvailable: updated!.isAvailable,
          oooReason: updated!.oooReason,
          returnAt: updated!.returnAt,
        };
      }

      const [created] = await db
        .insert(repAvailability)
        .values({
          orgId: auth.org.id,
          userId,
          isAvailable: input.isAvailable,
          oooReason: input.oooReason ?? null,
          returnAt: input.returnAt ?? null,
        })
        .returning();

      return {
        userId: created!.userId,
        isAvailable: created!.isAvailable,
        oooReason: created!.oooReason,
        returnAt: created!.returnAt,
      };
    });
  }

  async assignLead(
    db: NexusDb,
    orgId: string,
    leadId: string,
    explicitRuleId?: string,
  ): Promise<{ assignedToUserId: string | null; isFallback: boolean }> {
    const ruleQuery = explicitRuleId
      ? and(eq(leadRoutingRules.id, explicitRuleId), eq(leadRoutingRules.orgId, orgId))
      : and(eq(leadRoutingRules.orgId, orgId), eq(leadRoutingRules.isActive, true));

    const [rule] = await db
      .select()
      .from(leadRoutingRules)
      .where(ruleQuery)
      .limit(1);

    if (!rule) {
      return { assignedToUserId: null, isFallback: false };
    }

    if (rule.strategy === 'manual') {
      return { assignedToUserId: null, isFallback: false };
    }

    const members = await db
      .select({
        id: leadRoutingMembers.id,
        userId: leadRoutingMembers.userId,
        orderIndex: leadRoutingMembers.orderIndex,
      })
      .from(leadRoutingMembers)
      .where(
        and(
          eq(leadRoutingMembers.ruleId, rule.id),
          eq(leadRoutingMembers.isActive, true),
        ),
      )
      .orderBy(leadRoutingMembers.orderIndex);

    const resolveFallbackUser = async (): Promise<string | null> => {
      if (rule.fallbackUserId) return rule.fallbackUserId;
      const [admin] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.orgId, orgId))
        .limit(1);
      return admin?.id ?? null;
    };

    if (members.length === 0) {
      const fallbackId = await resolveFallbackUser();
      if (fallbackId) {
        await db.update(leads).set({ ownerId: fallbackId, updatedAt: new Date() }).where(eq(leads.id, leadId));
        await db.insert(leadAssignmentLogs).values({
          orgId,
          leadId,
          assignedToUserId: fallbackId,
          ruleId: rule.id,
          strategy: 'fallback',
          reason: 'No active members configured in routing rule',
        });
      }
      return { assignedToUserId: fallbackId, isFallback: true };
    }

    // Check rep availability
    const availRows = await db
      .select()
      .from(repAvailability)
      .where(eq(repAvailability.orgId, orgId));

    const availMap = new Map(availRows.map((a) => [a.userId, a.isAvailable]));
    const availableMembers = members.filter((m) => availMap.get(m.userId) !== false);

    if (availableMembers.length === 0) {
      // All reps are unavailable/PTO! Route to fallback queue
      const fallbackId = await resolveFallbackUser();
      if (fallbackId) {
        await db.update(leads).set({ ownerId: fallbackId, updatedAt: new Date() }).where(eq(leads.id, leadId));
        await db.insert(leadAssignmentLogs).values({
          orgId,
          leadId,
          assignedToUserId: fallbackId,
          ruleId: rule.id,
          strategy: 'fallback',
          reason: 'All rotation reps are marked unavailable (PTO/OOO)',
        });
      }
      return { assignedToUserId: fallbackId, isFallback: true };
    }

    // Round-Robin distribution
    const nextIndex = (rule.lastAssignedIndex + 1) % availableMembers.length;
    const chosenMember = availableMembers[nextIndex]!;

    await db
      .update(leadRoutingRules)
      .set({ lastAssignedIndex: nextIndex, updatedAt: new Date() })
      .where(eq(leadRoutingRules.id, rule.id));

    await db
      .update(leads)
      .set({ ownerId: chosenMember.userId, updatedAt: new Date() })
      .where(eq(leads.id, leadId));

    await db.insert(leadAssignmentLogs).values({
      orgId,
      leadId,
      assignedToUserId: chosenMember.userId,
      ruleId: rule.id,
      strategy: 'round_robin',
      reason: 'Automated round-robin rotation',
    });

    return { assignedToUserId: chosenMember.userId, isFallback: false };
  }

  async reassignLead(
    auth: AuthContext,
    leadId: string,
    input: ReassignLeadInput,
  ): Promise<{ ok: true; leadId: string; assignedToUserId: string }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, leadId), eq(leads.orgId, auth.org.id)));

      if (!lead) {
        throw new NotFoundException({ message: 'Lead not found', code: 'LEAD_NOT_FOUND' });
      }

      const [targetUser] = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.id, input.assignedToUserId), eq(users.orgId, auth.org.id)));

      if (!targetUser) {
        throw new BadRequestException({ message: 'Target user not found', code: 'USER_NOT_FOUND' });
      }

      await db
        .update(leads)
        .set({ ownerId: targetUser.id, updatedAt: new Date() })
        .where(eq(leads.id, leadId));

      await db.insert(leadAssignmentLogs).values({
        orgId: auth.org.id,
        leadId,
        assignedToUserId: targetUser.id,
        assignedByUserId: auth.user.id,
        strategy: 'manual_override',
        reason: input.reason ?? 'Manual reassignment by admin',
      });

      const leadTitle = lead.name || lead.company || lead.email;
      await db.insert(notifications).values({
        orgId: auth.org.id,
        userId: targetUser.id,
        type: 'lead_assigned',
        title: `Lead Reassigned to You: ${leadTitle}`,
        body: `Lead ${leadTitle}${lead.company ? ` (${lead.company})` : ''} was reassigned to you by ${auth.user.name}.`,
        link: `/leads/${lead.id}`,
      });

      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'lead.reassigned',
        entityType: 'lead',
        entityId: leadId,
        newValues: { ownerId: targetUser.id, reason: input.reason },
        oldValues: { ownerId: lead.ownerId },
      });

      try {
        await this.mail.sendLeadAssignedNotification(
          targetUser.email,
          auth.org.name,
          {
            id: lead.id,
            name: lead.name,
            company: lead.company,
            email: lead.email,
          },
        );
      } catch (mailErr) {
        // Non-blocking mail delivery
      }

      return { ok: true as const, leadId, assignedToUserId: targetUser.id };
    });
  }

  async getAssignmentHistory(
    auth: AuthContext,
    leadId: string,
  ): Promise<
    Array<{
      id: string;
      assignedToUserId: string | null;
      assignedToUser: { id: string; name: string; email: string } | null;
      assignedByUserId: string | null;
      assignedByUser: { id: string; name: string; email: string } | null;
      strategy: string;
      reason: string | null;
      createdAt: Date;
    }>
  > {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [lead] = await db
        .select({ id: leads.id, ownerId: leads.ownerId })
        .from(leads)
        .where(and(eq(leads.id, leadId), eq(leads.orgId, auth.org.id)));

      if (!lead) {
        throw new NotFoundException({ message: 'Lead not found', code: 'LEAD_NOT_FOUND' });
      }

      if (auth.role.permissions.recordAccess?.['lead'] === 'own' && lead.ownerId !== auth.user.id) {
        throw new ForbiddenException({ message: 'Forbidden', code: 'RECORD_FORBIDDEN' });
      }

      const logs = await db
        .select()
        .from(leadAssignmentLogs)
        .where(and(eq(leadAssignmentLogs.orgId, auth.org.id), eq(leadAssignmentLogs.leadId, leadId)))
        .orderBy(desc(leadAssignmentLogs.createdAt));

      const userIds = [
        ...new Set(
          logs.flatMap((l) => [l.assignedToUserId, l.assignedByUserId]).filter((id): id is string => Boolean(id)),
        ),
      ];

      const userMap = new Map<string, { id: string; name: string; email: string }>();
      if (userIds.length > 0) {
        const uRows = await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(and(eq(users.orgId, auth.org.id), inArray(users.id, userIds)));
        for (const u of uRows) userMap.set(u.id, u);
      }

      return logs.map((l) => ({
        id: l.id,
        assignedToUserId: l.assignedToUserId,
        assignedToUser: l.assignedToUserId ? userMap.get(l.assignedToUserId) ?? null : null,
        assignedByUserId: l.assignedByUserId,
        assignedByUser: l.assignedByUserId ? userMap.get(l.assignedByUserId) ?? null : null,
        strategy: l.strategy,
        reason: l.reason,
        createdAt: l.createdAt,
      }));
    });
  }

  private async formatRule(
    db: NexusDb,
    orgId: string,
    ruleId: string,
  ): Promise<SerializedRoutingRule> {
    const [rule] = await db
      .select()
      .from(leadRoutingRules)
      .where(and(eq(leadRoutingRules.id, ruleId), eq(leadRoutingRules.orgId, orgId)));

    if (!rule) throw new NotFoundException({ message: 'Rule not found', code: 'RULE_NOT_FOUND' });

    const memberRows = await db
      .select({
        member: leadRoutingMembers,
        user: { id: users.id, name: users.name, email: users.email },
      })
      .from(leadRoutingMembers)
      .leftJoin(users, eq(leadRoutingMembers.userId, users.id))
      .where(and(eq(leadRoutingMembers.ruleId, ruleId), eq(leadRoutingMembers.orgId, orgId)))
      .orderBy(leadRoutingMembers.orderIndex);

    const fallbackUser = rule.fallbackUserId
      ? (await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, rule.fallbackUserId)))[0] ?? null
      : null;

    return {
      id: rule.id,
      name: rule.name,
      strategy: rule.strategy,
      isActive: rule.isActive,
      fallbackUserId: rule.fallbackUserId,
      fallbackUser,
      lastAssignedIndex: rule.lastAssignedIndex,
      members: memberRows.map((m) => ({
        id: m.member.id,
        userId: m.member.userId,
        user: m.user,
        orderIndex: m.member.orderIndex,
        isActive: m.member.isActive,
      })),
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    };
  }
}
