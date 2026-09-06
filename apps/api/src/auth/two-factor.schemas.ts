import { z } from 'zod';

const codeSchema = z.string().regex(/^\d{6}$/, 'Code must be 6 digits');

export const enableTwoFactorSchema = z
  .object({
    code: codeSchema,
  })
  .strict();

export const verifyTwoFactorSchema = z
  .object({
    code: codeSchema.optional(),
    backupCode: z.string().trim().min(8).max(16).optional(),
  })
  .strict()
  .refine((v) => v.code ?? v.backupCode, { message: 'Provide a code or a backup code' });

export const confirmPasswordSchema = z
  .object({
    password: z.string().min(1).max(200),
  })
  .strict();

export type EnableTwoFactorInput = z.infer<typeof enableTwoFactorSchema>;
export type VerifyTwoFactorInput = z.infer<typeof verifyTwoFactorSchema>;
export type ConfirmPasswordInput = z.infer<typeof confirmPasswordSchema>;
