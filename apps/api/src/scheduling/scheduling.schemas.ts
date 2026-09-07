import { z } from 'zod';

const slugPattern = /^[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$/;

export const createLinkSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    slug: z.string().trim().toLowerCase().regex(slugPattern, 'Slug must be URL-safe').optional(),
    durationMinutes: z.number().int().min(15).max(480).default(30),
    description: z.string().trim().max(1000).optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateLinkSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    durationMinutes: z.number().int().min(15).max(480).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const bookSlotSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    name: z.string().trim().min(1, 'Name is required').max(200),
    email: z.string().trim().email().max(320),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

export type CreateLinkInput = z.infer<typeof createLinkSchema>;
export type UpdateLinkInput = z.infer<typeof updateLinkSchema>;
export type BookSlotInput = z.infer<typeof bookSlotSchema>;
