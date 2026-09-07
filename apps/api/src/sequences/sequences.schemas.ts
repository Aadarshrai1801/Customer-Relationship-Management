import { z } from 'zod';

const waitStep = z
  .object({
    kind: z.literal('wait'),
    days: z.number().int().min(1).max(365),
  })
  .strict();

const sendStep = z
  .object({
    kind: z.literal('send_email'),
    templateId: z.string().uuid().optional(),
    subject: z.string().trim().max(200).optional(),
    body: z.string().trim().max(20000).optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const sequenceStepSchema = z.discriminatedUnion('kind', [waitStep, sendStep]);

export const createSequenceSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    isActive: z.boolean().default(true),
    steps: z.array(sequenceStepSchema).min(1, 'At least one step is required').max(20),
  })
  .strict();

export const updateSequenceSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isActive: z.boolean().optional(),
    steps: z.array(sequenceStepSchema).min(1).max(20).optional(),
  })
  .strict();

export const enrollContactSchema = z.object({ contactId: z.string().uuid() }).strict();

export type CreateSequenceInput = z.infer<typeof createSequenceSchema>;
export type UpdateSequenceInput = z.infer<typeof updateSequenceSchema>;
export type SequenceStep = z.infer<typeof sequenceStepSchema>;
