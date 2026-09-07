import { z } from 'zod';

export const territoryRuleSchema = z
  .object({
    field: z.enum(['company', 'email_domain', 'title', 'name']),
    operator: z.enum(['equals', 'not_equals', 'contains']),
    value: z.string().trim().min(1).max(200),
  })
  .strict();

export const createTerritorySchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    ownerId: z.string().uuid().optional(),
    rules: z.array(territoryRuleSchema).min(1, 'At least one rule is required').max(10),
  })
  .strict();

export const evaluateTerritorySchema = z
  .object({
    contactId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
  })
  .strict()
  .refine((v) => v.contactId ?? v.leadId, { message: 'contactId or leadId is required' });

export type CreateTerritoryInput = z.infer<typeof createTerritorySchema>;
export type TerritoryRule = z.infer<typeof territoryRuleSchema>;
