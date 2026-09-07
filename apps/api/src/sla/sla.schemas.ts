import { z } from 'zod';

export const createSlaPolicySchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    entity: z.enum(['lead', 'deal', 'task']),
    metric: z.enum(['first_response', 'resolution']),
    hours: z.number().int().min(1).max(24 * 90),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateSlaPolicySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    hours: z.number().int().min(1).max(24 * 90).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type CreateSlaPolicyInput = z.infer<typeof createSlaPolicySchema>;
export type UpdateSlaPolicyInput = z.infer<typeof updateSlaPolicySchema>;
