import { z } from 'zod';

export const uploadQuerySchema = z
  .object({
    entityType: z.enum(['contact', 'account']).default('contact'),
    source: z.enum(['hubspot', 'pipedrive', 'salesforce']).optional(),
  })
  .strict();

export const mappingSchema = z
  .object({
    mapping: z.record(z.string(), z.string().trim().min(1).max(100)).default({}),
  })
  .strict();

export type UploadQuery = z.infer<typeof uploadQuerySchema>;
export type MappingInput = z.infer<typeof mappingSchema>;
