import { z } from 'zod';

export const updateSecuritySchema = z
  .object({
    twoFactorPolicy: z.enum(['off', 'optional', 'required']).optional(),
    ssoOnly: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.twoFactorPolicy !== undefined || v.ssoOnly !== undefined, {
    message: 'Provide at least one setting to update',
  });

export type UpdateSecurityInput = z.infer<typeof updateSecuritySchema>;
