import { z } from 'zod';

const tagsSchema = z
  .array(z.string().trim().min(1).max(50))
  .max(20)
  .default([])
  .transform((tags) =>
    [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0))].slice(0, 20),
  );

const domainsSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/, 'Invalid domain'),
  )
  .max(20)
  .default([])
  .transform((domains) => [...new Set(domains)].slice(0, 20));

const customFieldsSchema = z.record(z.string(), z.unknown()).default({});

export const createAccountSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    website: z.string().trim().max(500).optional(),
    domains: domainsSchema,
    phone: z.string().trim().max(50).optional(),
    industry: z.string().trim().max(100).optional(),
    parentId: z.string().uuid().optional(),
    ownerId: z.string().uuid().optional(),
    tags: tagsSchema,
    customFields: customFieldsSchema,
  })
  .strict();

export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    website: z.string().trim().max(500).nullable().optional(),
    domains: domainsSchema.optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    industry: z.string().trim().max(100).nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
    ownerId: z.string().uuid().nullable().optional(),
    tags: tagsSchema.optional(),
    customFields: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const listAccountsQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    parentId: z.string().uuid().optional(),
    ownerId: z.string().uuid().optional(),
    tag: z.string().trim().max(50).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;
