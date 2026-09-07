import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  accounts,
  activities,
  contacts,
  deals,
  notifications,
  tasks,
  users,
  type Activity,
  type Task,
} from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService, diffObjects } from '../audit/audit.service';
import { ContactsService } from '../contacts/contacts.service';
import { MailService } from '../mail/mail.service';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { WorkflowEngine } from '../workflows/workflow-engine.service';
import { checkRecordAccess, hasScope } from '../rbac/permissions';
import type {
  CreateActivityInput,
  CreateTaskInput,
  ListActivitiesQuery,
  ListTasksQuery,
  UpdateActivityInput,
  UpdateTaskInput,
} from './tasks.schemas';

export interface SerializedTask {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  contact: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  title: string;
  description: string | null;
  status: 'open' | 'completed' | 'cancelled';
  priority: 'low' | 'normal' | 'high';
  dueAt: Date | null;
  remindAt: Date | null;
  reminderSentAt: Date | null;
  completedAt: Date | null;
  recurrence: { frequency: string; interval: number } | null;
  overdue: boolean;
  reminderDue: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SerializedActivity {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  contact: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  taskId: string | null;
  type: 'call' | 'meeting' | 'email' | 'task';
  subject: string | null;
  body: string | null;
  occurredAt: Date;
  provider: string | null;
  externalId: string | null;
  syncStatus: string;
  conflictFlag: boolean;
  direction: string;
  senderEmail: string | null;
  recipientEmails: string[];
  durationSeconds: number | null;
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

/**
 * Next-occurrence shift for recurring tasks (PRD 4.4 P1). Monthly shifts
 * clamp to month-end (Jan 31 + 1 month = Feb 28/29), matching calendar UX.
 */
export function shiftRecurrence(from: Date, rule: { frequency: string; interval: number }): Date {
  const next = new Date(from.getTime());
  if (rule.frequency === 'daily') {
    next.setUTCDate(next.getUTCDate() + rule.interval);
    return next;
  }
  if (rule.frequency === 'weekly') {
    next.setUTCDate(next.getUTCDate() + 7 * rule.interval);
    return next;
  }
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + rule.interval);
  const monthDays = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(day, monthDays));
  return next;
}

function parseRecurrence(value: unknown): { frequency: string; interval: number } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const rule = value as Record<string, unknown>;
  const frequency = rule['frequency'];
  if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') return null;
  const interval = rule['interval'];
  return {
    frequency,
    interval:
      typeof interval === 'number' && Number.isInteger(interval) && interval >= 1 ? interval : 1,
  };
}

function isOverdue(status: string, dueAt: Date | null, now: Date): boolean {
  return status === 'open' && dueAt !== null && dueAt.getTime() < now.getTime();
}

function isReminderDue(
  status: string,
  remindAt: Date | null,
  reminderSentAt: Date | null,
  now: Date,
): boolean {
  return (
    status === 'open' &&
    remindAt !== null &&
    remindAt.getTime() <= now.getTime() &&
    reminderSentAt === null
  );
}

@Injectable()
export class TasksService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(WorkflowEngine) private readonly workflows: WorkflowEngine,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(NotificationPreferencesService)
    private readonly preferences: NotificationPreferencesService,
  ) {}

  async create(auth: AuthContext, input: CreateTaskInput): Promise<{ task: SerializedTask }> {
    const result = await this.tenantDb.tx(auth.org.id, async (db) => {
      const ownerId = await this.resolveOwnerForCreate(db, auth, input.ownerId);
      const links = await this.resolveLinks(db, auth.org.id, input);
      const [created] = await db
        .insert(tasks)
        .values({
          orgId: auth.org.id,
          ownerId,
          contactId: links.contactId,
          accountId: links.accountId,
          dealId: links.dealId,
          title: input.title,
          description: input.description ?? null,
          status: input.status,
          priority: input.priority,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          remindAt: input.remindAt ? new Date(input.remindAt) : null,
          completedAt: input.status === 'completed' ? new Date() : null,
          recurrence: input.recurrence ?? null,
        })
        .returning();
      if (!created) throw new Error('Task insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'task.created',
        entityType: 'task',
        entityId: created.id,
        newValues: { title: created.title, status: created.status },
      });
      return { task: await this.serializeById(db, auth, created.id) };
    });
    this.workflows.handle({
      orgId: auth.org.id,
      kind: 'record.created',
      entity: 'task',
      recordId: result.task.id,
      record: result.task as unknown as Record<string, unknown>,
      actorUserId: auth.user.id,
    });
    return result;
  }

  async list(
    auth: AuthContext,
    query: ListTasksQuery,
  ): Promise<{ tasks: SerializedTask[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const now = new Date();
      const conditions = [eq(tasks.orgId, auth.org.id), isNull(tasks.deletedAt)];
      const canSeeAll = this.recordScope(auth) === 'all';
      if (!canSeeAll) {
        conditions.push(eq(tasks.ownerId, auth.user.id));
      }
      if (query.status) conditions.push(eq(tasks.status, query.status));
      if (query.ownerId) {
        if (!canSeeAll && query.ownerId !== auth.user.id) {
          return { tasks: [], nextCursor: null };
        }
        conditions.push(eq(tasks.ownerId, query.ownerId));
      }
      if (query.contactId) conditions.push(eq(tasks.contactId, query.contactId));
      if (query.accountId) conditions.push(eq(tasks.accountId, query.accountId));
      if (query.dealId) conditions.push(eq(tasks.dealId, query.dealId));
      if (query.overdue) {
        conditions.push(eq(tasks.status, 'open'), lt(tasks.dueAt, now));
      }
      if (query.remindersDue) {
        conditions.push(
          eq(tasks.status, 'open'),
          lt(tasks.remindAt, now),
          isNull(tasks.reminderSentAt),
        );
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
          sql`(${tasks.createdAt}, ${tasks.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ task: tasks, owner: users })
        .from(tasks)
        .leftJoin(users, eq(tasks.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const serialized = await Promise.all(
        page.map((row) => this.serializeJoined(db, row.task, row.owner)),
      );
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last ? `${last.task.createdAt.toISOString()}|${last.task.id}` : null;
      return { tasks: serialized, nextCursor };
    });
  }

  async getById(auth: AuthContext, id: string): Promise<SerializedTask> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return this.serializeById(db, auth, id);
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    patch: UpdateTaskInput,
  ): Promise<{ task: SerializedTask }> {
    let emitChanges: Array<{ field: string; old: unknown; new: unknown }> = [];
    const result = await this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveTask(db, auth.org.id, id);
      this.assertTaskReadable(auth, row.ownerId);

      let ownerId = row.ownerId;
      if (patch.ownerId !== undefined) {
        if (!patch.ownerId) {
          ownerId = null;
        } else if (patch.ownerId === auth.user.id) {
          ownerId = auth.user.id;
        } else {
          if (!hasScope(auth.role.permissions, 'users:manage')) {
            throw new ForbiddenException({
              message: 'Missing required scope: users:manage',
              code: 'SCOPE_FORBIDDEN',
            });
          }
          ownerId = await this.requireMember(db, auth.org.id, patch.ownerId);
        }
      }
      const links = await this.resolveLinks(db, auth.org.id, {
        contactId: patch.contactId === null ? undefined : (patch.contactId ?? undefined),
        accountId: patch.accountId === null ? undefined : (patch.accountId ?? undefined),
        dealId: patch.dealId === null ? undefined : (patch.dealId ?? undefined),
      });

      const status = patch.status ?? (row.status as SerializedTask['status']);
      const wasCompleted = row.status === 'completed';
      const nowCompleted = status === 'completed';
      const [updated] = await db
        .update(tasks)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
          ...(patch.dueAt !== undefined
            ? { dueAt: patch.dueAt ? new Date(patch.dueAt) : null }
            : {}),
          ...(patch.remindAt !== undefined
            ? {
                remindAt: patch.remindAt ? new Date(patch.remindAt) : null,
                ...(patch.remindAt ? { reminderSentAt: null } : {}),
              }
            : {}),
          ...(patch.ownerId !== undefined ? { ownerId } : {}),
          ...(patch.contactId !== undefined
            ? { contactId: patch.contactId ? links.contactId : null }
            : {}),
          ...(patch.accountId !== undefined
            ? { accountId: patch.accountId ? links.accountId : null }
            : {}),
          ...(patch.dealId !== undefined ? { dealId: patch.dealId ? links.dealId : null } : {}),
          ...(patch.recurrence !== undefined ? { recurrence: patch.recurrence } : {}),
          ...(!wasCompleted && nowCompleted ? { completedAt: new Date() } : {}),
          ...(wasCompleted && !nowCompleted ? { completedAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, row.id))
        .returning();
      if (!updated) throw new Error('Task update returned no row');
      const { oldValues } = diffObjects(
        { title: row.title, status: row.status },
        { title: updated.title, status: updated.status },
      );
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'task.updated',
        entityType: 'task',
        entityId: updated.id,
        oldValues,
        newValues: { title: updated.title, status: updated.status },
      });
      if (!wasCompleted && nowCompleted) {
        await this.logCompletionActivity(db, auth, updated.id, updated);
        await this.spawnNextOccurrence(db, auth, updated);
      }
      const beforeScalars: Record<string, unknown> = {
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        ownerId: row.ownerId,
      };
      const afterScalars: Record<string, unknown> = {
        title: updated.title,
        description: updated.description,
        status: updated.status,
        priority: updated.priority,
        ownerId: updated.ownerId,
      };
      emitChanges = Object.keys(afterScalars)
        .filter((field) => (beforeScalars[field] ?? null) !== (afterScalars[field] ?? null))
        .map((field) => ({
          field,
          old: beforeScalars[field] ?? null,
          new: afterScalars[field] ?? null,
        }));
      return { task: await this.serializeById(db, auth, updated.id) };
    });
    if (emitChanges.length > 0) {
      this.workflows.handle({
        orgId: auth.org.id,
        kind: 'field.changed',
        entity: 'task',
        recordId: result.task.id,
        record: result.task as unknown as Record<string, unknown>,
        changes: emitChanges,
        actorUserId: auth.user.id,
      });
    }
    return result;
  }

  /**
   * Explicit completion with an auto-logged task activity for the timeline.
   * Idempotent: completing an already-completed task reports changed=false
   * and does not duplicate the activity entry. Recurring tasks spawn their
   * next independent occurrence (same rule, shifted dates).
   */
  async complete(
    auth: AuthContext,
    id: string,
  ): Promise<{ task: SerializedTask; changed: boolean; nextTaskId: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveTask(db, auth.org.id, id);
      this.assertTaskReadable(auth, row.ownerId);
      if (row.status === 'completed') {
        return {
          task: await this.serializeById(db, auth, row.id),
          changed: false,
          nextTaskId: null,
        };
      }
      const [updated] = await db
        .update(tasks)
        .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
        .where(eq(tasks.id, row.id))
        .returning();
      if (!updated) throw new Error('Task complete returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'task.completed',
        entityType: 'task',
        entityId: updated.id,
        oldValues: { status: row.status },
        newValues: { status: 'completed' },
      });
      await this.logCompletionActivity(db, auth, updated.id, updated);
      let nextTaskId: string | null = null;
      nextTaskId = await this.spawnNextOccurrence(db, auth, updated);
      return { task: await this.serializeById(db, auth, updated.id), changed: true, nextTaskId };
    });
  }

  /**
   * Spawns the next independent occurrence of a recurring task. Returns
   * the new id, or null when the task does not recur. Shared by explicit
   * completion and PATCH-to-completed so both paths behave identically.
   */
  private async spawnNextOccurrence(
    db: NexusDb,
    auth: AuthContext,
    updated: typeof tasks.$inferSelect,
  ): Promise<string | null> {
    const rule = parseRecurrence(updated.recurrence);
    if (!rule) return null;
    const anchor = updated.dueAt ?? new Date();
    const shiftedDue = shiftRecurrence(anchor, rule);
    const dueDeltaMs = shiftedDue.getTime() - anchor.getTime();
    const [next] = await db
      .insert(tasks)
      .values({
        orgId: auth.org.id,
        ownerId: updated.ownerId,
        contactId: updated.contactId,
        accountId: updated.accountId,
        dealId: updated.dealId,
        title: updated.title,
        description: updated.description,
        status: 'open',
        priority: updated.priority,
        dueAt: shiftedDue,
        remindAt: updated.remindAt ? new Date(updated.remindAt.getTime() + dueDeltaMs) : null,
        recurrence: updated.recurrence,
      })
      .returning();
    if (!next) throw new Error('Recurrence insert returned no row');
    await this.audit.record(db, {
      orgId: auth.org.id,
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'task.created',
      entityType: 'task',
      entityId: next.id,
      newValues: { title: next.title, status: next.status, recurringFrom: updated.id },
    });
    return next.id;
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveTask(db, auth.org.id, id);
      this.assertTaskReadable(auth, row.ownerId);
      await db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'task.deleted',
        entityType: 'task',
        entityId: row.id,
        oldValues: { title: row.title },
      });
      return { ok: true as const };
    });
  }

  /**
   * Batched reminder digest (PRD 4.4 anti-spam rule): first alerts fire for
   * reminders coming due, then same-day repeats collapse into one
   * notification per owner. Overdue tasks join the digest when they have no
   * alert stamped today. Notifications are inserted in-transaction with the
   * reminderSentAt stamps so a crash cannot double-alert.
   */
  async dispatchReminderDigests(
    auth: AuthContext,
    nowInput?: Date,
  ): Promise<{ ownersNotified: number; tasksIncluded: number }> {
    const result = await this.tenantDb.tx(auth.org.id, async (db) => {
      return this.dispatchDigestsForOrg(db, auth.org.id, nowInput ?? new Date(), auth);
    });
    await this.sendDigestEmails(result.emailTargets);
    return { ownersNotified: result.ownersNotified, tasksIncluded: result.tasksIncluded };
  }

  /** Best-effort post-commit digest emails (skipped silently on failure). */
  async sendDigestEmails(
    targets: Array<{ email: string; name: string; lines: string[]; count: number }>,
  ): Promise<void> {
    for (const target of targets) {
      try {
        await this.mail.sendEmail({
          to: target.email,
          subject: `[Nexus] Daily task digest: ${target.count} task${target.count === 1 ? '' : 's'}`,
          text: `Hi ${target.name},\n\nTasks needing attention:\n${target.lines.join('\n')}\n\nEmpty digests are never sent — this email means something is due.`,
        });
      } catch {
        // Advisory only.
      }
    }
  }

  /** Worker entry point: same digest without a requesting user. */
  async dispatchDigestsForOrg(
    db: NexusDb,
    orgId: string,
    now: Date,
    auth?: AuthContext,
  ): Promise<{
    ownersNotified: number;
    tasksIncluded: number;
    emailTargets: Array<{ email: string; name: string; lines: string[]; count: number }>;
  }> {
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const rows = await db
      .select({ task: tasks, owner: users })
      .from(tasks)
      .leftJoin(users, eq(tasks.ownerId, users.id))
      .where(
        and(
          eq(tasks.orgId, orgId),
          isNull(tasks.deletedAt),
          eq(tasks.status, 'open'),
          isNotNull(tasks.ownerId),
          or(
            and(lte(tasks.remindAt, now), isNull(tasks.reminderSentAt)),
            and(
              lt(tasks.dueAt, now),
              or(isNull(tasks.reminderSentAt), lt(tasks.reminderSentAt, todayStart)),
            ),
          ),
        ),
      )
      .orderBy(desc(tasks.dueAt));
    const byOwner = new Map<string, { name: string; email: string | null; items: Task[] }>();
    for (const row of rows) {
      const ownerId = row.task.ownerId as string;
      const group = byOwner.get(ownerId) ?? {
        name: row.owner?.name ?? 'there',
        email: row.owner?.email ?? null,
        items: [],
      };
      group.items.push(row.task);
      byOwner.set(ownerId, group);
    }
    // Digest emails (PRD 4.16 P1) go out post-commit, best-effort.
    const emailTargets: Array<{ email: string; name: string; lines: string[]; count: number }> = [];
    for (const [ownerId, group] of byOwner) {
      const lines = group.items.map((t) => {
        const due = t.dueAt ? `due ${t.dueAt.toISOString().slice(0, 10)}` : 'reminder due';
        return `• ${t.title} (${due})`;
      });
      const title = `Task digest: ${group.items.length} task${group.items.length === 1 ? '' : 's'} need${group.items.length === 1 ? 's' : ''} attention`;
      const body = `Hi ${group.name},\n${lines.join('\n')}`;
      if (await this.preferences.wantsChannel(db, orgId, ownerId, 'task_digest', 'inapp')) {
        await db.insert(notifications).values({
          orgId,
          userId: ownerId,
          type: 'task_digest',
          title,
          body,
          link: '/tasks?remindersDue=true',
        });
      }
      if (
        group.email &&
        (await this.preferences.wantsChannel(db, orgId, ownerId, 'task_digest', 'email'))
      ) {
        emailTargets.push({
          email: group.email,
          name: group.name,
          lines,
          count: group.items.length,
        });
      }
      await db
        .update(tasks)
        .set({ reminderSentAt: now })
        .where(
          and(
            eq(tasks.orgId, orgId),
            sql`${tasks.id} IN (${sql.join(
              group.items.map((t) => sql`${t.id}`),
              sql`, `,
            )})`,
          ),
        );
      await this.audit.record(db, {
        orgId,
        actorUserId: auth?.user.id ?? null,
        actorEmail: auth?.user.email ?? null,
        action: 'task.digest_sent',
        entityType: 'user',
        entityId: ownerId,
        newValues: { taskCount: group.items.length },
      });
    }
    return {
      ownersNotified: byOwner.size,
      tasksIncluded: rows.length,
      emailTargets,
    };
  }

  private recordScope(auth: AuthContext): 'all' | 'own' {
    return auth.role.permissions?.recordAccess?.['task'] ?? 'own';
  }

  private assertTaskReadable(auth: AuthContext, ownerId: string | null): void {
    try {
      checkRecordAccess(auth.role.permissions, 'task', ownerId ?? '', auth.user.id);
    } catch {
      recordForbidden();
    }
  }

  private assertActivityReadable(auth: AuthContext, ownerId: string | null): void {
    try {
      checkRecordAccess(auth.role.permissions, 'activity', ownerId ?? '', auth.user.id);
    } catch {
      recordForbidden();
    }
  }

  private async resolveOwnerForCreate(
    db: NexusDb,
    auth: AuthContext,
    ownerId: string | undefined,
  ): Promise<string> {
    if (!ownerId || ownerId === auth.user.id) return auth.user.id;
    if (!hasScope(auth.role.permissions, 'users:manage')) {
      throw new ForbiddenException({
        message: 'Assigning another owner requires users:manage',
        code: 'SCOPE_FORBIDDEN',
      });
    }
    return this.requireMember(db, auth.org.id, ownerId);
  }

  private async requireMember(db: NexusDb, orgId: string, userId: string): Promise<string> {
    const [member] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)));
    if (!member) {
      throw new BadRequestException({
        message: 'Owner must be a workspace member',
        code: 'OWNER_NOT_MEMBER',
      });
    }
    return member.id;
  }

  /**
   * Validates linked records exist live in this org. Existence only — access
   * stays governed by task ownership so cross-owned associations work.
   */
  private async resolveLinks(
    db: NexusDb,
    orgId: string,
    input: { contactId?: string; accountId?: string; dealId?: string },
  ): Promise<{ contactId: string | null; accountId: string | null; dealId: string | null }> {
    let contactId: string | null = null;
    let accountId: string | null = null;
    let dealId: string | null = null;
    if (input.contactId) {
      const row = await this.contacts.requireLiveContact(db, orgId, input.contactId);
      contactId = row.contact.id;
    }
    if (input.accountId) {
      const [account] = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.accountId),
            eq(accounts.orgId, orgId),
            isNull(accounts.deletedAt),
          ),
        );
      if (!account) {
        throw new NotFoundException({ message: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
      }
      accountId = account.id;
    }
    if (input.dealId) {
      const [deal] = await db
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.id, input.dealId), eq(deals.orgId, orgId), isNull(deals.deletedAt)));
      if (!deal) {
        throw new NotFoundException({ message: 'Deal not found', code: 'DEAL_NOT_FOUND' });
      }
      dealId = deal.id;
    }
    return { contactId, accountId, dealId };
  }

  private async requireLiveTask(db: NexusDb, orgId: string, id: string): Promise<Task> {
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.orgId, orgId), isNull(tasks.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Task not found', code: 'TASK_NOT_FOUND' });
    }
    return row;
  }

  private async logCompletionActivity(
    db: NexusDb,
    auth: AuthContext,
    taskId: string,
    task: Task,
  ): Promise<void> {
    await db.insert(activities).values({
      orgId: auth.org.id,
      ownerId: task.ownerId,
      contactId: task.contactId,
      accountId: task.accountId,
      dealId: task.dealId,
      taskId,
      type: 'task',
      subject: `Completed: ${task.title}`,
      occurredAt: new Date(),
    });
    await this.audit.record(db, {
      orgId: auth.org.id,
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'activity.logged',
      entityType: 'task',
      entityId: taskId,
      newValues: { type: 'task', subject: `Completed: ${task.title}` },
    });
  }

  private async serializeById(db: NexusDb, auth: AuthContext, id: string): Promise<SerializedTask> {
    const [row] = await db
      .select({ task: tasks, owner: users })
      .from(tasks)
      .leftJoin(users, eq(tasks.ownerId, users.id))
      .where(and(eq(tasks.id, id), eq(tasks.orgId, auth.org.id), isNull(tasks.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Task not found', code: 'TASK_NOT_FOUND' });
    }
    this.assertTaskReadable(auth, row.task.ownerId);
    return this.serializeJoined(db, row.task, row.owner);
  }

  private async serializeJoined(
    db: NexusDb,
    task: Task,
    owner: { id: string; name: string } | null,
  ): Promise<SerializedTask> {
    const now = new Date();
    let contact: { id: string; name: string } | null = null;
    let account: { id: string; name: string } | null = null;
    let deal: { id: string; name: string } | null = null;
    if (task.contactId) {
      const [row] = await db
        .select({ id: contacts.id, name: contacts.name })
        .from(contacts)
        .where(eq(contacts.id, task.contactId));
      if (row) contact = row;
    }
    if (task.accountId) {
      const [row] = await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, task.accountId));
      if (row) account = row;
    }
    if (task.dealId) {
      const [row] = await db
        .select({ id: deals.id, name: deals.name })
        .from(deals)
        .where(eq(deals.id, task.dealId));
      if (row) deal = row;
    }
    return {
      id: task.id,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      ownerId: task.ownerId,
      contact,
      account,
      deal,
      title: task.title,
      description: task.description,
      status: task.status as SerializedTask['status'],
      priority: task.priority as SerializedTask['priority'],
      dueAt: task.dueAt,
      remindAt: task.remindAt,
      reminderSentAt: task.reminderSentAt,
      completedAt: task.completedAt,
      recurrence: parseRecurrence(task.recurrence),
      overdue: isOverdue(task.status, task.dueAt, now),
      reminderDue: isReminderDue(task.status, task.remindAt, task.reminderSentAt, now),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  async listActivities(
    auth: AuthContext,
    query: ListActivitiesQuery,
  ): Promise<{ activities: SerializedActivity[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [eq(activities.orgId, auth.org.id)];
      const canSeeAll = (auth.role.permissions?.recordAccess?.['activity'] ?? 'own') === 'all';
      if (!canSeeAll) {
        conditions.push(eq(activities.ownerId, auth.user.id));
      }
      if (query.type) conditions.push(eq(activities.type, query.type));
      if (query.direction) conditions.push(eq(activities.direction, query.direction));
      if (query.ownerId) {
        if (!canSeeAll && query.ownerId !== auth.user.id) {
          return { activities: [], nextCursor: null };
        }
        conditions.push(eq(activities.ownerId, query.ownerId));
      }
      if (query.contactId) conditions.push(eq(activities.contactId, query.contactId));
      if (query.accountId) conditions.push(eq(activities.accountId, query.accountId));
      if (query.dealId) conditions.push(eq(activities.dealId, query.dealId));
      if (query.taskId) conditions.push(eq(activities.taskId, query.taskId));
      if (query.cursor) {
        const parsed = parseCursor(query.cursor);
        if (!parsed) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
        conditions.push(
          sql`(${activities.occurredAt}, ${activities.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ activity: activities, owner: users })
        .from(activities)
        .leftJoin(users, eq(activities.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(activities.occurredAt), desc(activities.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const serialized = await Promise.all(
        page.map((row) => this.serializeActivity(db, row.activity, row.owner)),
      );
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? `${last.activity.occurredAt.toISOString()}|${last.activity.id}`
          : null;
      return { activities: serialized, nextCursor };
    });
  }

  async logActivity(
    auth: AuthContext,
    input: CreateActivityInput,
  ): Promise<{ activity: SerializedActivity }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const ownerId = await this.resolveOwnerForCreate(db, auth, input.ownerId);
      const links = await this.resolveLinks(db, auth.org.id, input);
      let taskId: string | null = null;
      if (input.taskId) {
        const task = await this.requireLiveTask(db, auth.org.id, input.taskId);
        this.assertTaskReadable(auth, task.ownerId);
        taskId = task.id;
      }
      const [created] = await db
        .insert(activities)
        .values({
          orgId: auth.org.id,
          ownerId,
          contactId: links.contactId,
          accountId: links.accountId,
          dealId: links.dealId,
          taskId,
          type: input.type,
          subject: input.subject ?? null,
          body: input.body ?? null,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
          durationSeconds: input.durationSeconds ?? null,
        })
        .returning();
      if (!created) throw new Error('Activity insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'activity.logged',
        entityType: input.taskId ? 'task' : 'contact',
        entityId: input.taskId ?? links.contactId ?? created.id,
        newValues: { type: created.type, subject: created.subject },
      });
      return { activity: await this.serializeActivityById(db, auth, created.id) };
    });
  }

  /** Same-transaction reader shared with the calendar-sync module. */
  async serializeActivityById(
    db: NexusDb,
    auth: AuthContext,
    id: string,
  ): Promise<SerializedActivity> {
    const [row] = await db
      .select({ activity: activities, owner: users })
      .from(activities)
      .leftJoin(users, eq(activities.ownerId, users.id))
      .where(and(eq(activities.id, id), eq(activities.orgId, auth.org.id)));
    if (!row) {
      throw new NotFoundException({ message: 'Activity not found', code: 'ACTIVITY_NOT_FOUND' });
    }
    this.assertActivityReadable(auth, row.activity.ownerId);
    return this.serializeActivity(db, row.activity, row.owner);
  }

  /** Shared with the calendar-sync module (re-reads inside its own tx). */
  async getActivityById(auth: AuthContext, id: string): Promise<SerializedActivity> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return this.serializeActivityById(db, auth, id);
    });
  }

  async updateActivity(
    auth: AuthContext,
    id: string,
    patch: UpdateActivityInput,
  ): Promise<{ activity: SerializedActivity }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const before = await this.serializeActivityById(db, auth, id);
      const [updated] = await db
        .update(activities)
        .set({
          ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.occurredAt !== undefined ? { occurredAt: new Date(patch.occurredAt) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(activities.id, id))
        .returning();
      if (!updated) throw new Error('Activity update returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'activity.updated',
        entityType: 'activity',
        entityId: id,
        oldValues: { subject: before.subject },
        newValues: { subject: updated.subject },
      });
      return { activity: await this.serializeActivityById(db, auth, id) };
    });
  }

  private async serializeActivity(
    db: NexusDb,
    activity: Activity,
    owner: { id: string; name: string } | null,
  ): Promise<SerializedActivity> {
    let contact: { id: string; name: string } | null = null;
    let account: { id: string; name: string } | null = null;
    let deal: { id: string; name: string } | null = null;
    if (activity.contactId) {
      const [row] = await db
        .select({ id: contacts.id, name: contacts.name })
        .from(contacts)
        .where(eq(contacts.id, activity.contactId));
      if (row) contact = row;
    }
    if (activity.accountId) {
      const [row] = await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, activity.accountId));
      if (row) account = row;
    }
    if (activity.dealId) {
      const [row] = await db
        .select({ id: deals.id, name: deals.name })
        .from(deals)
        .where(eq(deals.id, activity.dealId));
      if (row) deal = row;
    }
    return {
      id: activity.id,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      ownerId: activity.ownerId,
      contact,
      account,
      deal,
      taskId: activity.taskId,
      type: activity.type as SerializedActivity['type'],
      subject: activity.subject,
      body: activity.body,
      occurredAt: activity.occurredAt,
      provider: activity.provider,
      externalId: activity.externalId,
      syncStatus: activity.syncStatus,
      conflictFlag: activity.conflictFlag,
      direction: activity.direction,
      senderEmail: activity.senderEmail,
      recipientEmails: (activity.recipientEmails ?? []) as string[],
      durationSeconds: activity.durationSeconds,
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
    };
  }
}
