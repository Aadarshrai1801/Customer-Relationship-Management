import { z } from 'zod';

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    timezone: z.string().trim().min(1).max(50).optional(),
  })
  .strict();

export const changeRoleSchema = z
  .object({
    roleKey: z.string().trim().min(1).max(50),
  })
  .strict();

export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
