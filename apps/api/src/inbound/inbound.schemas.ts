import { z } from 'zod';

export const inboundEventSchema = z
  .object({
    event: z.enum(['activity.logged', 'contact.upserted']),
    externalId: z.string().trim().min(1).max(300).optional(),
    activity: z
      .object({
        type: z.enum(['call', 'meeting', 'email', 'note']),
        subject: z.string().trim().max(200).optional(),
        body: z.string().trim().max(10000).optional(),
        occurredAt: z.string().datetime({ offset: true }).optional(),
        email: z.string().trim().email().max(320).optional(),
      })
      .optional(),
    contact: z
      .object({
        name: z.string().trim().min(1).max(200).optional(),
        email: z.string().trim().email().max(320).optional(),
        phone: z.string().trim().max(50).optional(),
        company: z.string().trim().max(200).optional(),
      })
      .optional(),
  })
  .strict();

export type InboundEventInput = z.infer<typeof inboundEventSchema>;
