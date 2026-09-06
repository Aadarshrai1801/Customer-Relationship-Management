import { z } from 'zod';

export const mergePreviewQuerySchema = z
  .object({
    loserId: z.string().uuid(),
  })
  .strict();

export const mergeBodySchema = z
  .object({
    loserId: z.string().uuid(),
    fieldChoices: z.record(z.string(), z.enum(['winner', 'loser'])).default({}),
  })
  .strict();

export type MergePreviewQuery = z.infer<typeof mergePreviewQuerySchema>;
export type MergeBody = z.infer<typeof mergeBodySchema>;
