import { z } from 'zod';

export const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'declined', 'expired'] as const;

export const createQuoteSchema = z
  .object({
    dealId: z.string().uuid(),
    validUntilDays: z.number().int().min(1).max(365).default(30),
    discountRate: z.number().min(0).max(1).default(0),
    notes: z.string().trim().max(5000).optional(),
  })
  .strict();

export const acceptQuoteSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    email: z.string().trim().email().max(320).optional(),
  })
  .strict();

export const declineQuoteSchema = z
  .object({ reason: z.string().trim().max(1000).optional() })
  .strict();

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type AcceptQuoteInput = z.infer<typeof acceptQuoteSchema>;
export type DeclineQuoteInput = z.infer<typeof declineQuoteSchema>;
