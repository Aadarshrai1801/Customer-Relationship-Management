import { z } from 'zod';
import { LEAD_SOURCES } from '@nexus/db';

export const webToLeadInputSchema = z.object({
  token: z.string().optional(),
  orgId: z.string().optional(),
  orgSlug: z.string().optional(),

  name: z.string().max(255).optional(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().email(),
  phone: z.string().max(50).optional(),
  company: z.string().max(255).optional(),
  title: z.string().max(100).optional(),
  notes: z.string().optional(),

  source: z.enum(LEAD_SOURCES).optional().default('website'),
  utmSource: z.string().max(255).optional(),
  utmMedium: z.string().max(255).optional(),
  utmCampaign: z.string().max(255).optional(),
  utmTerm: z.string().max(255).optional(),
  utmContent: z.string().max(255).optional(),
  referrerUrl: z.string().optional(),

  customFields: z.record(z.string(), z.unknown()).optional().default({}),

  _hp: z.string().optional(),
  hp: z.string().optional(),
  honeypot: z.string().optional(),
});

export type WebToLeadInput = z.infer<typeof webToLeadInputSchema>;
