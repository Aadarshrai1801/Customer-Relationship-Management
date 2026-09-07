import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  activities,
  contacts,
  deals,
  organizations,
  tasks,
  users,
  workflowRuns,
  workflows,
  type Workflow,
} from '@nexus/db';
import { LIFECYCLE_STAGES } from '@nexus/db';
import { IdentityDb, TenantDb, type NexusDb } from '../database/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { QueueService } from '../queue/queue.service';
import type { WorkflowAction, WorkflowCondition } from './workflows.schemas';

export const WORKFLOWS_DUE_QUEUE = 'workflows-due-scan';

export type WorkflowEntity = 'deal' | 'contact' | 'task';
export type WorkflowEventKind =
  'record.created' | 'field.changed' | 'stage.changed' | 'time.elapsed';

export interface WorkflowEvent {
  orgId: string;
  kind: WorkflowEventKind;
  entity: WorkflowEntity;
  recordId: string;
  /** New state of the record (top-level fields addressable by conditions). */
  record: Record<string, unknown>;
  changes?: Array<{ field: string; old: unknown; new: unknown }>;
  /** Stage transition details for stage.changed events. */
  details?: Record<string, unknown>;
  actorUserId: string | null;
  depth?: number;
}

/** Scalar fields workflows may write (safe subset — no ownership/status). */
const UPDATABLE_FIELDS: Record<WorkflowEntity, Record<string, (value: unknown) => unknown>> = {
  deal: {
    probability: (v) => {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 100)
        throw new Error('probability must be an integer 0-100');
      return n;
    },
    forecastCategory: (v) => {
      if (v !== 'pipeline' && v !== 'best_case' && v !== 'commit') {
        throw new Error('forecastCategory must be pipeline, best_case, or commit');
      }
      return v;
    },
  },
  contact: {
    title: (v) => (v === null ? null : String(v).slice(0, 200)),
    phone: (v) => (v === null ? null : String(v).slice(0, 50)),
    lifecycleStage: (v) => {
      if (typeof v !== 'string' || !(LIFECYCLE_STAGES as readonly string[]).includes(v)) {
        throw new Error(
          `lifecycleStage must be one of ${(LIFECYCLE_STAGES as readonly string[]).join(', ')}`,
        );
      }
      return v;
    },
  },
  task: {
    priority: (v) => {
      if (v !== 'low' && v !== 'normal' && v !== 'high')
        throw new Error('priority must be low, normal, or high');
      return v;
    },
    status: (v) => {
      if (v !== 'open' && v !== 'completed' && v !== 'cancelled') {
        throw new Error('status must be open, completed, or cancelled');
      }
      return v;
    },
  },
};

function getPath(record: Record<string, unknown>, field: string): unknown {
  let current: unknown = record;
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compare(operator: string, actual: unknown, expected: unknown): boolean {
  if (operator === 'contains') {
    if (actual === null || actual === undefined) return false;
    return String(actual)
      .toLowerCase()
      .includes(String(expected ?? '').toLowerCase());
  }
  const aNum = typeof actual === 'number' ? actual : Number(actual);
  const eNum = typeof expected === 'number' ? expected : Number(expected);
  const bothNumeric =
    actual !== null &&
    actual !== undefined &&
    actual !== '' &&
    expected !== null &&
    expected !== undefined &&
    expected !== '' &&
    Number.isFinite(aNum) &&
    Number.isFinite(eNum);
  if (bothNumeric) {
    if (operator === 'equals') return aNum === eNum;
    if (operator === 'not_equals') return aNum !== eNum;
    if (operator === 'greater_than') return aNum > eNum;
    if (operator === 'less_than') return aNum < eNum;
    return false;
  }
  const a = actual === null || actual === undefined ? '' : String(actual);
  const e = expected === null || expected === undefined ? '' : String(expected);
  if (operator === 'equals') return a === e;
  if (operator === 'not_equals') return a !== e;
  if (operator === 'greater_than') return a > e;
  if (operator === 'less_than') return a < e;
  return false;
}

@Injectable()
export class WorkflowEngine {
  private readonly logger = new Logger(WorkflowEngine.name);

  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(IdentityDb) private readonly identity: IdentityDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(QueueService) private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    this.queues.registerWorker(WORKFLOWS_DUE_QUEUE, () => this.evaluateDue());
    this.queues.registerSchedule(WORKFLOWS_DUE_QUEUE, '0 * * * *');
  }

  /** Fire-and-forget entry called by domain services after commit. Never throws. */
  handle(event: WorkflowEvent): void {
    void this.evaluate(event).catch((err: unknown) => {
      this.logger.error(
        `Workflow evaluation failed for ${event.kind}/${event.entity}: ${String(err)}`,
      );
    });
  }

  /**
   * Hourly time.elapsed scan across orgs. Each rule fires once per record
   * (a prior run for the same workflow+record suppresses repeats).
   */
  async evaluateDue(): Promise<{ orgs: number; fired: number }> {
    const orgs = await this.identity.db.select({ id: organizations.id }).from(organizations);
    let fired = 0;
    for (const org of orgs) {
      try {
        fired += await this.tenantDb.tx(org.id, (db) => this.evaluateDueForOrg(db, org.id));
      } catch (err) {
        this.logger.error(`Workflow due-scan failed for org ${org.id}: ${String(err)}`);
      }
    }
    return { orgs: orgs.length, fired };
  }

  private async evaluate(event: WorkflowEvent): Promise<void> {
    const depth = event.depth ?? 0;
    await this.tenantDb.tx(event.orgId, async (db) => {
      const rules = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, event.orgId),
            eq(workflows.isActive, true),
            isNull(workflows.deletedAt),
          ),
        );
      for (const rule of rules) {
        const trigger = (rule.trigger ?? {}) as Record<string, unknown>;
        if (trigger['kind'] !== event.kind) continue;
        if ((trigger['entity'] as string) !== event.entity) continue;
        if (depth >= (rule.maxRuns ?? 5)) {
          await this.recordRun(db, event, rule, 'skipped', [], 'Max cascade depth reached');
          continue;
        }
        if (
          event.kind === 'field.changed' &&
          typeof trigger['field'] === 'string' &&
          !(event.changes ?? []).some((c) => c.field === trigger['field'])
        ) {
          continue;
        }
        if (
          event.kind === 'stage.changed' &&
          typeof trigger['toStageKey'] === 'string' &&
          (event.details?.['toStageKey'] as string | undefined) !== trigger['toStageKey']
        ) {
          continue;
        }
        const conditions = (rule.conditions ?? []) as WorkflowCondition[];
        if (
          !conditions.every((c) => compare(c.operator, getPath(event.record, c.field), c.value))
        ) {
          continue;
        }
        await this.execute(db, event, rule, depth);
      }
    });
  }

  private async execute(
    db: NexusDb,
    event: WorkflowEvent,
    rule: Workflow,
    depth: number,
  ): Promise<void> {
    const actions = (rule.actions ?? []) as WorkflowAction[];
    const results: Array<Record<string, unknown>> = [];
    try {
      for (const [index, action] of actions.entries()) {
        results.push({
          index,
          type: action.type,
          ...(await this.runAction(db, event, rule, action, depth)),
        });
      }
      await this.recordRun(db, event, rule, 'success', results, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordRun(db, event, rule, 'failed', results, message);
    }
  }

  private async runAction(
    db: NexusDb,
    event: WorkflowEvent,
    rule: Workflow,
    action: WorkflowAction,
    depth: number,
  ): Promise<Record<string, unknown>> {
    switch (action.type) {
      case 'update_field':
        return this.runUpdateField(db, event, rule, action, depth);
      case 'create_task':
        return this.runCreateTask(db, event, rule, action, depth);
      case 'send_email':
        return this.runSendEmail(db, event, rule, action);
      case 'call_webhook':
        return this.runWebhook(event, rule, action);
    }
  }

  private async runUpdateField(
    db: NexusDb,
    event: WorkflowEvent,
    rule: Workflow,
    action: Extract<WorkflowAction, { type: 'update_field' }>,
    depth: number,
  ): Promise<Record<string, unknown>> {
    if (action.entity !== event.entity) {
      throw new Error(`update_field targets ${action.entity} but the event is for ${event.entity}`);
    }
    const coercer = UPDATABLE_FIELDS[action.entity]?.[action.field];
    if (!coercer) {
      throw new Error(`Field ${action.entity}.${action.field} is not workflow-writable`);
    }
    const value = coercer(action.value);
    const before = (event.record[action.field] as unknown) ?? null;
    if (action.entity === 'deal') {
      await db
        .update(deals)
        .set({ [action.field]: value, updatedAt: new Date() })
        .where(eq(deals.id, event.recordId));
    } else if (action.entity === 'contact') {
      await db
        .update(contacts)
        .set({ [action.field]: value, updatedAt: new Date() })
        .where(eq(contacts.id, event.recordId));
    } else {
      await db
        .update(tasks)
        .set({ [action.field]: value, updatedAt: new Date() })
        .where(eq(tasks.id, event.recordId));
    }
    await this.audit.record(db, {
      orgId: event.orgId,
      actorUserId: null,
      actorEmail: null,
      action: `${action.entity}.updated`,
      entityType: action.entity,
      entityId: event.recordId,
      oldValues: { [action.field]: before },
      newValues: { [action.field]: value, workflowId: rule.id, workflow: rule.name },
    });
    const nextRecord = { ...event.record, [action.field]: value };
    // Cascade after the run commits: queue follow-up outside this tx.
    setImmediate(() => {
      this.handle({
        orgId: event.orgId,
        kind: 'field.changed',
        entity: event.entity,
        recordId: event.recordId,
        record: nextRecord,
        changes: [{ field: action.field, old: before, new: value }],
        actorUserId: event.actorUserId,
        depth: depth + 1,
      });
    });
    return { field: action.field, value };
  }

  private async runCreateTask(
    db: NexusDb,
    event: WorkflowEvent,
    rule: Workflow,
    action: Extract<WorkflowAction, { type: 'create_task' }>,
    depth: number,
  ): Promise<Record<string, unknown>> {
    const ownerId = event.actorUserId;
    const [created] = await db
      .insert(tasks)
      .values({
        orgId: event.orgId,
        ownerId,
        title: action.title,
        description: action.description ?? null,
        status: 'open',
        priority: action.priority ?? 'normal',
        dueAt: action.dueInDays ? new Date(Date.now() + action.dueInDays * 86400000) : null,
      })
      .returning();
    if (!created) throw new Error('Task insert returned no row');
    await this.audit.record(db, {
      orgId: event.orgId,
      actorUserId: event.actorUserId,
      actorEmail: null,
      action: 'task.created',
      entityType: 'task',
      entityId: created.id,
      newValues: { title: created.title, workflowId: rule.id },
    });
    const createdId = created.id;
    setImmediate(() => {
      this.handle({
        orgId: event.orgId,
        kind: 'record.created',
        entity: 'task',
        recordId: createdId,
        record: { id: createdId, title: action.title, status: 'open', ownerId },
        actorUserId: event.actorUserId,
        depth: depth + 1,
      });
    });
    return { taskId: createdId };
  }

  private async runSendEmail(
    db: NexusDb,
    event: WorkflowEvent,
    rule: Workflow,
    action: Extract<WorkflowAction, { type: 'send_email' }>,
  ): Promise<Record<string, unknown>> {
    let to = action.to;
    if (to === 'owner') {
      const ownerId = event.record['ownerId'] as string | null | undefined;
      if (!ownerId) throw new Error('Record has no owner to email');
      const [owner] = await db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.id, ownerId), eq(users.orgId, event.orgId)));
      if (!owner) throw new Error('Record owner not found');
      to = owner.email;
    }
    const transactionId = await this.mail.sendEmail({
      to,
      subject: action.subject,
      text: action.body,
    });
    await db.insert(activities).values({
      orgId: event.orgId,
      ownerId: event.actorUserId,
      type: 'email',
      subject: action.subject,
      body: action.body,
      occurredAt: new Date(),
      direction: 'outbound',
      senderEmail: null,
      recipientEmails: [to.toLowerCase()],
      provider: 'nexus-workflow',
      externalId: transactionId,
    });
    await this.audit.record(db, {
      orgId: event.orgId,
      actorUserId: event.actorUserId,
      actorEmail: null,
      action: 'email.sent',
      entityType: 'activity',
      entityId: event.recordId,
      newValues: { to, workflowId: rule.id, workflow: rule.name },
    });
    return { to, transactionId };
  }

  private async runWebhook(
    event: WorkflowEvent,
    rule: Workflow,
    action: Extract<WorkflowAction, { type: 'call_webhook' }>,
  ): Promise<Record<string, unknown>> {
    if (!action.url.startsWith('http://') && !action.url.startsWith('https://')) {
      throw new Error('Webhook URL must use http or https');
    }
    if (Object.keys(action.headers ?? {}).length > 20) {
      throw new Error('Too many webhook headers (max 20)');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), action.timeoutMs);
    try {
      const res = await fetch(action.url, {
        method: action.method,
        headers: { 'content-type': 'application/json', ...(action.headers ?? {}) },
        body:
          action.method === 'GET'
            ? undefined
            : JSON.stringify({
                event: { kind: event.kind, entity: event.entity, recordId: event.recordId },
                record: event.record,
                workflow: { id: rule.id, name: rule.name },
              }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
      return { status: res.status };
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error('Webhook timed out');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async evaluateDueForOrg(db: NexusDb, orgId: string): Promise<number> {
    const rules = await db
      .select()
      .from(workflows)
      .where(
        and(eq(workflows.orgId, orgId), eq(workflows.isActive, true), isNull(workflows.deletedAt)),
      );
    let fired = 0;
    for (const rule of rules) {
      const trigger = (rule.trigger ?? {}) as Record<string, unknown>;
      if (trigger['kind'] !== 'time.elapsed') continue;
      const entity = trigger['entity'] as WorkflowEntity | undefined;
      const hoursAfter = trigger['hoursAfter'] as number | undefined;
      if (!entity || typeof hoursAfter !== 'number') continue;
      const cutoff = new Date(Date.now() - hoursAfter * 3600000);
      const candidates = await this.dueCandidates(db, orgId, entity, cutoff);
      for (const row of candidates) {
        const recordId = row['id'] as string;
        const [already] = await db
          .select({ id: workflowRuns.id })
          .from(workflowRuns)
          .where(
            and(
              eq(workflowRuns.orgId, orgId),
              eq(workflowRuns.workflowId, rule.id),
              sql`${workflowRuns.triggerEvent}->>'recordId' = ${recordId}`,
            ),
          )
          .limit(1);
        if (already) continue;
        const conditions = (rule.conditions ?? []) as WorkflowCondition[];
        if (!conditions.every((c) => compare(c.operator, getPath(row, c.field), c.value))) {
          continue;
        }
        await this.executeDirect(db, rule, {
          orgId,
          kind: 'time.elapsed',
          entity,
          recordId,
          record: row,
          actorUserId: null,
          depth: 0,
        });
        fired += 1;
      }
    }
    return fired;
  }

  private async dueCandidates(
    db: NexusDb,
    orgId: string,
    entity: WorkflowEntity,
    cutoff: Date,
  ): Promise<Array<Record<string, unknown>>> {
    if (entity === 'deal') {
      const rows = await db
        .select()
        .from(deals)
        .where(and(eq(deals.orgId, orgId), lte(deals.createdAt, cutoff), isNull(deals.deletedAt)))
        .orderBy(deals.createdAt)
        .limit(100);
      return rows as Array<Record<string, unknown>>;
    }
    if (entity === 'contact') {
      const rows = await db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, orgId),
            lte(contacts.createdAt, cutoff),
            isNull(contacts.deletedAt),
          ),
        )
        .orderBy(contacts.createdAt)
        .limit(100);
      return rows as Array<Record<string, unknown>>;
    }
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.orgId, orgId), lte(tasks.createdAt, cutoff), isNull(tasks.deletedAt)))
      .orderBy(tasks.createdAt)
      .limit(100);
    return rows as Array<Record<string, unknown>>;
  }

  /** Time-based path: executes without re-listing rules (avoids double evaluation). */
  private async executeDirect(db: NexusDb, rule: Workflow, event: WorkflowEvent): Promise<void> {
    await this.execute(db, event, rule, 0);
  }

  private async recordRun(
    db: NexusDb,
    event: WorkflowEvent,
    rule: Workflow,
    status: 'success' | 'failed' | 'skipped',
    actionResults: Array<Record<string, unknown>>,
    error: string | null,
  ): Promise<void> {
    await db.insert(workflowRuns).values({
      orgId: event.orgId,
      workflowId: rule.id,
      triggerEvent: {
        kind: event.kind,
        entity: event.entity,
        recordId: event.recordId,
        depth: event.depth ?? 0,
        details: event.details ?? null,
      },
      status,
      actionResults,
      error,
    });
  }
}
