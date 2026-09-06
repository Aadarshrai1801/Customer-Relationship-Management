import { z } from 'zod';
import { LEAD_STATUSES, LEAD_SOURCES } from '@nexus/db';

const customFieldsSchema = z.record(z.string(), z.unknown()).default({});

export const createLeadSchema = z
  .object({
    ownerId: z.string().uuid().optional(),
    name: z.string().trim().max(200).optional(),
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(255),
    phone: z.string().trim().max(50).optional(),
    company: z.string().trim().max(200).optional(),
    title: z.string().trim().max(200).optional(),
    status: z.enum(LEAD_STATUSES).default('new'),
    source: z.enum(LEAD_SOURCES).default('website'),
    utmSource: z.string().trim().max(100).optional(),
    utmMedium: z.string().trim().max(100).optional(),
    utmCampaign: z.string().trim().max(100).optional(),
    utmTerm: z.string().trim().max(100).optional(),
    utmContent: z.string().trim().max(100).optional(),
    referrerUrl: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(5000).optional(),
    customFields: customFieldsSchema,
  })
  .strict();

export const updateLeadSchema = z
  .object({
    ownerId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    firstName: z.string().trim().max(100).nullable().optional(),
    lastName: z.string().trim().max(100).nullable().optional(),
    email: z.string().trim().toLowerCase().email().max(255).optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    company: z.string().trim().max(200).nullable().optional(),
    title: z.string().trim().max(200).nullable().optional(),
    status: z.enum(LEAD_STATUSES).optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    utmSource: z.string().trim().max(100).nullable().optional(),
    utmMedium: z.string().trim().max(100).nullable().optional(),
    utmCampaign: z.string().trim().max(100).nullable().optional(),
    utmTerm: z.string().trim().max(100).nullable().optional(),
    utmContent: z.string().trim().max(100).nullable().optional(),
    referrerUrl: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    customFields: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const listLeadsQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.enum(LEAD_STATUSES).optional(),
    source: z.enum(LEAD_SOURCES).optional(),
    ownerId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;
