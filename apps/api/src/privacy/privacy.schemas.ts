import { z } from 'zod';

export const eraseSchema = z
  .object({
    password: z.string().min(1).max(200).optional(),
  })
  .strict();

export type EraseInput = z.infer<typeof eraseSchema>;
