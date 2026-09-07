import { z } from 'zod';

const customFieldsSchema = z.record(z.string(), z.unknown()).default({});

const forecastCategorySchema = z.enum(['pipeline', 'best_case', 'commit']);

const isoCurrency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code');

export const createDealSchema = z
  .object({
    pipelineId: z.string().uuid().optional(),
    stageId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    ownerId: z.string().uuid().optional(),
    competitorId: z.string().uuid().optional(),
    name: z.string().trim().min(1, 'Name is required').max(200),
    amount: z.number().finite().min(0).max(9999999999999.99),
    currency: isoCurrency.default('USD'),
    probability: z.number().int().min(0).max(100).optional(),
    forecastCategory: forecastCategorySchema.default('pipeline'),
    expectedCloseDate: z.string().datetime({ offset: true }).optional(),
    lossReason: z.string().trim().max(500).optional(),
    customFields: customFieldsSchema,
  })
  .strict();

export const updateDealSchema = z
  .object({
    accountId: z.string().uuid().nullable().optional(),
    contactId: z.string().uuid().nullable().optional(),
    ownerId: z.string().uuid().nullable().optional(),
    competitorId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    amount: z.number().finite().min(0).max(9999999999999.99).optional(),
    currency: isoCurrency.optional(),
    probability: z.number().int().min(0).max(100).nullable().optional(),
    forecastCategory: forecastCategorySchema.optional(),
    expectedCloseDate: z.string().datetime({ offset: true }).nullable().optional(),
    customFields: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export const listDealsQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    pipelineId: z.string().uuid().optional(),
    stageId: z.string().uuid().optional(),
    ownerId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    status: z.enum(['open', 'won', 'lost']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict();

export const stalledDealsQuerySchema = z
  .object({
    daysInactive: z.coerce.number().int().min(0).max(365).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export const addLineItemSchema = z
  .object({
    productId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    quantity: z.number().finite().positive().max(999999999),
    unitPrice: z.number().finite().min(0).max(9999999999999.99).optional(),
    discountRate: z.number().finite().min(0).max(1).default(0),
    taxRate: z.number().finite().min(0).max(1).optional(),
    currency: isoCurrency.optional(),
  })
  .strict();

export type CreateDealInput = z.infer<typeof createDealSchema>;
export type UpdateDealInput = z.infer<typeof updateDealSchema>;
export type ListDealsQuery = z.infer<typeof listDealsQuerySchema>;
export type StalledDealsQuery = z.infer<typeof stalledDealsQuerySchema>;
export type AddLineItemInput = z.infer<typeof addLineItemSchema>;
