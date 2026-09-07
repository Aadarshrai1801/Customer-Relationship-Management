import { z } from 'zod';

export const BILLING_PLANS = ['trial', 'starter', 'growth', 'enterprise'] as const;

export const previewSeatsSchema = z
  .object({
    seats: z.number().int().min(1).max(1000),
    plan: z.enum(BILLING_PLANS).optional(),
  })
  .strict();

export const applySeatsSchema = z
  .object({
    seats: z.number().int().min(1).max(1000),
    plan: z.enum(BILLING_PLANS).optional(),
  })
  .strict();

export type PreviewSeatsInput = z.infer<typeof previewSeatsSchema>;
export type ApplySeatsInput = z.infer<typeof applySeatsSchema>;
