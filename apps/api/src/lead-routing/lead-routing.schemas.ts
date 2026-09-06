import { z } from 'zod';

export const createRoutingRuleSchema = z
  .object({
    name: z.string().trim().min(1, 'Rule name is required').max(100),
    strategy: z.enum(['round_robin', 'manual']).default('round_robin'),
    isActive: z.boolean().default(true),
    fallbackUserId: z.string().uuid().optional(),
    memberUserIds: z.array(z.string().uuid()).default([]),
  })
  .strict();

export const updateRoutingRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    strategy: z.enum(['round_robin', 'manual']).optional(),
    isActive: z.boolean().optional(),
    fallbackUserId: z.string().uuid().nullable().optional(),
    memberUserIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

export const updateAvailabilitySchema = z
  .object({
    isAvailable: z.boolean(),
    oooReason: z.string().trim().max(200).nullable().optional(),
    returnAt: z.coerce.date().nullable().optional(),
  })
  .strict();

export const reassignLeadSchema = z
  .object({
    assignedToUserId: z.string().uuid(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export type CreateRoutingRuleInput = z.infer<typeof createRoutingRuleSchema>;
export type UpdateRoutingRuleInput = z.infer<typeof updateRoutingRuleSchema>;
export type UpdateAvailabilityInput = z.infer<typeof updateAvailabilitySchema>;
export type ReassignLeadInput = z.infer<typeof reassignLeadSchema>;
