import { z } from 'zod';

const isoDateTime = z.string().datetime({ offset: true });
const emailString = z.string().trim().email().max(320);

/**
 * Simulated provider inbound payload (gmail / outlook webhooks and the
 * BCC fallback share this shape). externalId is the provider message-id;
 * dedup matches on message-id across providers so BCC copies collapse
 * into the natively synced row (PRD 4.5 edge case).
 */
export const syncInboundSchema = z
  .object({
    provider: z.enum(['gmail', 'outlook', 'bcc']),
    externalId: z.string().trim().min(1).max(300),
    from: emailString,
    to: z.array(emailString).max(50).default([]),
    subject: z.string().trim().max(200).optional(),
    body: z.string().trim().max(20000).optional(),
    occurredAt: isoDateTime.optional(),
  })
  .strict();

export const sendEmailSchema = z
  .object({
    to: emailString,
    subject: z.string().trim().max(200).optional(),
    body: z.string().trim().max(20000).optional(),
    templateId: z.string().uuid().optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
    contactId: z.string().uuid().optional(),
    dealId: z.string().uuid().optional(),
  })
  .strict();

export const createTemplateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    subject: z.string().trim().min(1, 'Subject is required').max(200),
    body: z.string().trim().min(1, 'Body is required').max(20000),
  })
  .strict();

export const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(20000).optional(),
  })
  .strict();

export const convertSuggestionSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    accountId: z.string().uuid().optional(),
  })
  .strict();

export const suggestionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export type SyncInboundInput = z.infer<typeof syncInboundSchema>;
export type SendEmailInput = z.infer<typeof sendEmailSchema>;
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;
export type ConvertSuggestionInput = z.infer<typeof convertSuggestionSchema>;
export type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>;
