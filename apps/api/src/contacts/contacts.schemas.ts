import { z } from 'zod';
import { LIFECYCLE_STAGES } from '@nexus/db';

const tagsSchema = z
  .array(z.string().trim().min(1).max(50))
  .max(20)
  .default([])
  .transform((tags) =>
    [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))].slice(0, 20),
  );

const customFieldsSchema = z.record(z.string(), z.unknown()).default({});

export const createContactSchema = z
  .object({
    accountId: z.string().uuid().optional(),
    ownerId: z.string().uuid().optional(),
    name: z.string().trim().min(1, 'Name is required').max(200),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(255),
    phone: z.string().trim().max(50).optional(),
    title: z.string().trim().max(200).optional(),
    lifecycleStage: z.enum(LIFECYCLE_STAGES).default('lead'),
    tags: tagsSchema,
    customFields: customFieldsSchema,
  })
  .strict();

export const updateContactSchema = z
  .object({
    accountId: z.string().uuid().nullable().optional(),
    ownerId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    firstName: z.string().trim().max(100).nullable().optional(),
    lastName: z.string().trim().max(100).nullable().optional(),
    email: z.string().trim().toLowerCase().email().max(255).optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    title: z.string().trim().max(200).nullable().optional(),
    lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
    tags: tagsSchema.optional(),
    customFields: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const listContactsQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    accountId: z.string().uuid().optional(),
    ownerId: z.string().uuid().optional(),
    lifecycleStage: z.enum(LIFECYCLE_STAGES).optional(),
    tag: z.string().trim().max(50).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateContactInput = z.infer<typeof createContactSchema>;
export type UpdateContactInput = z.infer<typeof updateContactSchema>;
export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
