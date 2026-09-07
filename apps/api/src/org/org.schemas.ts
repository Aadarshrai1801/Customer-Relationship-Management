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
    maxAttachmentBytes: z
      .number()
      .int()
      .min(1024)
      .max(100 * 1024 * 1024)
      .optional(),
    attachmentStorageCapBytes: z.number().int().min(1024).optional(),
    staleDealDays: z.number().int().min(0).max(365).optional(),
    emailTrackingEnabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.maxAttachmentBytes !== undefined ||
      v.attachmentStorageCapBytes !== undefined ||
      v.staleDealDays !== undefined ||
      v.emailTrackingEnabled !== undefined,
    {
      message: 'Provide at least one setting to update',
    },
  );

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
