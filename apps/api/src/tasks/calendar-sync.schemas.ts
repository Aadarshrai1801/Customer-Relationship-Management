import { z } from 'zod';

const isoDateTime = z.string().datetime({ offset: true });

/**
 * Simulated provider webhook payload. Real Google/Outlook OAuth is out of
 * scope for this environment, so providers push here (same test-console
 * pattern as web-to-lead ingestion). Field semantics mirror the PRD
 * acceptance criteria: attendee matching, cancel-not-delete, most-recent-
 * wins with conflict flagging.
 */
export const syncEventSchema = z
  .object({
    provider: z.enum(['google', 'outlook']),
    externalId: z.string().trim().min(1).max(300),
    externalUpdatedAt: isoDateTime,
    subject: z.string().trim().max(200).optional(),
    body: z.string().trim().max(10000).optional(),
    occurredAt: isoDateTime.optional(),
    attendeeEmails: z.array(z.string().trim().email().max(320)).max(50).default([]),
    status: z.enum(['active', 'cancelled']).default('active'),
  })
  .strict();

export type SyncEventInput = z.infer<typeof syncEventSchema>;
