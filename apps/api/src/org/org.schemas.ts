import { z } from 'zod';

export const updateSecuritySchema = z
  .object({
    twoFactorPolicy: z.enum(['off', 'optional', 'required']),
  })
  .strict();

export type UpdateSecurityInput = z.infer<typeof updateSecuritySchema>;
