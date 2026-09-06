import { z } from 'zod';

const keyPattern = /^[a-z][a-z0-9_]{1,49}$/;

const baseFields = {
  label: z.string().trim().min(1, 'Label is required').max(100),
  required: z.boolean().default(false),
};

export const createFieldSchema = z
  .object({
    entityType: z.enum(['contact', 'account']),
    key: z.string().trim().toLowerCase().regex(keyPattern, 'Key must be snake_case'),
    type: z.enum([
      'text',
      'number',
      'date',
      'picklist',
      'multi_select',
      'checkbox',
      'currency',
      'formula',
    ]),
    options: z.record(z.string(), z.unknown()).default({}),
    ...baseFields,
  })
  .strict()
  .superRefine((value, ctx) => {
    const options = value.options;
    if (value.type === 'picklist' || value.type === 'multi_select') {
      const list = options['options'];
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        !list.every((o): o is string => typeof o === 'string' && o.trim().length > 0)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: 'Picklist fields need a non-empty options list',
        });
      }
    }
    if (value.type === 'formula') {
      if (typeof options['expression'] !== 'string' || !options['expression'].trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: 'Formula fields need an expression',
        });
      }
    }
    if (value.type === 'currency' && options['currency'] !== undefined) {
      if (typeof options['currency'] !== 'string' || !/^[A-Z]{3}$/.test(options['currency'])) {
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: 'Currency must be a 3-letter ISO code',
        });
      }
    }
  });

export const updateFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    required: z.boolean().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => v.label !== undefined || v.required !== undefined || v.options !== undefined, {
    message: 'Provide at least one field to update',
  });

export type CreateFieldInput = z.infer<typeof createFieldSchema>;
export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;
