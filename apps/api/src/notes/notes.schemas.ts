import { z } from 'zod';

export const createNoteSchema = z
  .object({
    body: z.string().trim().min(1, 'Note cannot be empty').max(10000),
  })
  .strict();

export const updateNoteSchema = z
  .object({
    body: z.string().trim().min(1, 'Note cannot be empty').max(10000),
  })
  .strict();

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
