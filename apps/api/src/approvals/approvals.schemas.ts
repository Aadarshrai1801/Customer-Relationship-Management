import { z } from 'zod';

export const APPROVAL_ACTIONS = ['quote_discount', 'deal_exception', 'refund'] as const;

export const requestApprovalSchema = z
  .object({
    entityType: z.enum(['deal', 'quote', 'contact']),
    entityId: z.string().uuid(),
    action: z.enum(APPROVAL_ACTIONS),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const decideApprovalSchema = z
  .object({ reason: z.string().trim().max(1000).optional() })
  .strict();

export type RequestApprovalInput = z.infer<typeof requestApprovalSchema>;
