import { z } from 'zod';

const slugPattern = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export const signupSchema = z.object({
  orgName: z.string().trim().min(2).max(100),
  slug: z.string().trim().toLowerCase().regex(slugPattern, 'Invalid slug').optional(),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(12).max(200),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  password: z.string().min(1).max(200),
  orgSlug: z.string().trim().toLowerCase().max(40).optional(),
});

export const requestResetSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
});

export const confirmResetSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(1).max(200),
});

export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  roleKey: z.string().trim().min(1).max(50),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(200),
});

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RequestResetInput = z.infer<typeof requestResetSchema>;
export type ConfirmResetInput = z.infer<typeof confirmResetSchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
