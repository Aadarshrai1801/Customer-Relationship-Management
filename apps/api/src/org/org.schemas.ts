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

export const updateSettingsSchema = z
  .object({
    maxAttachmentBytes: z.number().int().min(1024).max(100 * 1024 * 1024).optional(),
    attachmentStorageCapBytes: z.number().int().min(1024).optional(),
  })
  .strict()
  .refine((v) => v.maxAttachmentBytes !== undefined || v.attachmentStorageCapBytes !== undefined, {
    message: 'Provide at least one setting to update',
  });

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
