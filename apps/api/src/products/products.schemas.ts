import { z } from 'zod';

const isoCurrency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code');

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    sku: z.string().trim().max(100).optional(),
    unitPrice: z.number().finite().min(0).max(9999999999999.99),
    currency: isoCurrency.default('USD'),
    taxRate: z.number().finite().min(0).max(1).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    sku: z.string().trim().max(100).nullable().optional(),
    unitPrice: z.number().finite().min(0).max(9999999999999.99).optional(),
    currency: isoCurrency.optional(),
    taxRate: z.number().finite().min(0).max(1).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
