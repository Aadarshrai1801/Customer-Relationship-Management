import { z } from 'zod';

export const TASK_STATUSES = ['open', 'completed', 'cancelled'] as const;
export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export const ACTIVITY_TYPES = ['call', 'meeting', 'email', 'task'] as const;

const recurrenceSchema = z
  .object({
    frequency: z.enum(['daily', 'weekly', 'monthly']),
    interval: z.number().int().min(1).max(12).default(1),
  })
  .strict();

const isoDateTime = z.string().datetime({ offset: true });

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    description: z.string().trim().max(5000).optional(),
    status: z.enum(TASK_STATUSES).default('open'),
    priority: z.enum(TASK_PRIORITIES).default('normal'),
    dueAt: isoDateTime.optional(),
    remindAt: isoDateTime.optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    ownerId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
  })
  .strict();

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    dueAt: isoDateTime.nullable().optional(),
    remindAt: isoDateTime.nullable().optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    ownerId: z.string().uuid().nullable().optional(),
    contactId: z.string().uuid().nullable().optional(),
    accountId: z.string().uuid().nullable().optional(),
    dealId: z.string().uuid().nullable().optional(),
  })
  .strict();

const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

export const listTasksQuerySchema = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
    ownerId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    overdue: boolString,
    remindersDue: boolString,
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const createActivitySchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES),
    subject: z.string().trim().max(200).optional(),
    body: z.string().trim().max(10000).optional(),
    occurredAt: isoDateTime.optional(),
    durationSeconds: z.number().int().min(0).max(86400).optional(),
    ownerId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
  })
  .strict();

export const listActivitiesQuerySchema = z
  .object({
    type: z.enum(ACTIVITY_TYPES).optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    ownerId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const updateActivitySchema = z
  .object({
    subject: z.string().trim().max(200).nullable().optional(),
    body: z.string().trim().max(10000).nullable().optional(),
    occurredAt: isoDateTime.optional(),
  })
  .strict();

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type ListActivitiesQuery = z.infer<typeof listActivitiesQuerySchema>;
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
