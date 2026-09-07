import { z } from 'zod';

export const WORKFLOW_ENTITIES = ['deal', 'contact', 'task'] as const;

const triggerBase = z.object({
  kind: z.enum(['record.created', 'field.changed', 'stage.changed', 'time.elapsed']),
  entity: z.enum(WORKFLOW_ENTITIES),
});

export const triggerSchema = triggerBase
  .extend({
    /** field.changed: which changed field fires the rule. */
    field: z.string().trim().min(1).max(100).optional(),
    /** stage.changed on deals: only fire for moves into this stage key. */
    toStageKey: z.string().trim().min(1).max(100).optional(),
    /** time.elapsed: fire once per record this many hours after creation. */
    hoursAfter: z
      .number()
      .positive()
      .max(24 * 365)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.kind === 'field.changed' && !v.field) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'field is required for field.changed' });
    }
    if (v.kind === 'time.elapsed' && v.hoursAfter === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'hoursAfter is required for time.elapsed',
      });
    }
    if (v.kind === 'stage.changed' && v.entity !== 'deal') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'stage.changed only supports deals' });
    }
  });

export const conditionSchema = z
  .object({
    field: z.string().trim().min(1).max(100),
    operator: z.enum(['equals', 'not_equals', 'greater_than', 'less_than', 'contains']),
    value: z.unknown(),
  })
  .strict();

const updateFieldAction = z
  .object({
    type: z.literal('update_field'),
    entity: z.enum(WORKFLOW_ENTITIES),
    field: z.string().trim().min(1).max(100),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  })
  .strict();

const createTaskAction = z
  .object({
    type: z.literal('create_task'),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).optional(),
    dueInDays: z.number().int().min(0).max(365).optional(),
    priority: z.enum(['low', 'normal', 'high']).optional(),
  })
  .strict();

const sendEmailAction = z
  .object({
    type: z.literal('send_email'),
    /** Literal address or 'owner' for the triggering record's owner. */
    to: z.string().trim().min(1).max(320),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10000),
  })
  .strict();

const callWebhookAction = z
  .object({
    type: z.literal('call_webhook'),
    url: z.string().trim().url().max(500),
    method: z.enum(['GET', 'POST', 'PUT']).default('POST'),
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  })
  .strict();

export const actionSchema = z.discriminatedUnion('type', [
  updateFieldAction,
  createTaskAction,
  sendEmailAction,
  callWebhookAction,
]);

export const createWorkflowSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    isActive: z.boolean().default(true),
    trigger: triggerSchema,
    conditions: z.array(conditionSchema).max(10).default([]),
    actions: z.array(actionSchema).min(1, 'At least one action is required').max(10),
    maxRuns: z.number().int().min(1).max(20).default(5),
  })
  .strict();

export const updateWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
    trigger: triggerSchema.optional(),
    conditions: z.array(conditionSchema).max(10).optional(),
    actions: z.array(actionSchema).min(1).max(10).optional(),
    maxRuns: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export const listWorkflowsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const listRunsQuerySchema = z
  .object({
    status: z.enum(['success', 'failed', 'skipped']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type UpdateWorkflowInput = z.infer<typeof updateWorkflowSchema>;
export type WorkflowTrigger = z.infer<typeof triggerSchema>;
export type WorkflowCondition = z.infer<typeof conditionSchema>;
export type WorkflowAction = z.infer<typeof actionSchema>;
