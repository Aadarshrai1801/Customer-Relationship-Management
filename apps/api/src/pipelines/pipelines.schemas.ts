import { z } from 'zod';

export const createPipelineSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(200),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/, 'Slug must be lowercase alphanumeric with dashes')
      .optional(),
    description: z.string().trim().max(1000).optional(),
  })
  .strict();

export const updatePipelineSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'Provide at least one field to update',
  });

export const createStageSchema = z
  .object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/, 'Key must be lowercase alphanumeric with dashes'),
    name: z.string().trim().min(1, 'Name is required').max(200),
    position: z.number().int().min(1).max(100).optional(),
    probability: z.number().int().min(0).max(100),
    isClosedWon: z.boolean().optional(),
    isClosedLost: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !(v.isClosedWon && v.isClosedLost), {
    message: 'A stage cannot be both Closed Won and Closed Lost',
  });

export const updateStageSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    position: z.number().int().min(1).max(100).optional(),
    probability: z.number().int().min(0).max(100).optional(),
    isClosedWon: z.boolean().optional(),
    isClosedLost: z.boolean().optional(),
  })
  .strict();

export const deleteStageQuerySchema = z
  .object({
    migrateToStageId: z.string().uuid().optional(),
  })
  .strict();

export const forecastQuerySchema = z
  .object({
    pipelineId: z.string().uuid(),
    ownerId: z.string().uuid().optional(),
    status: z.enum(['open', 'won', 'lost', 'all']).optional(),
  })
  .strict();

export const transitionDealSchema = z
  .object({
    stageId: z.string().uuid(),
    lossReason: z.string().trim().max(500).optional(),
  })
  .strict();

export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;
export type UpdatePipelineInput = z.infer<typeof updatePipelineSchema>;
export type CreateStageInput = z.infer<typeof createStageSchema>;
export type UpdateStageInput = z.infer<typeof updateStageSchema>;
export type DeleteStageQuery = z.infer<typeof deleteStageQuerySchema>;
export type ForecastQuery = z.infer<typeof forecastQuerySchema>;
export type TransitionDealInput = z.infer<typeof transitionDealSchema>;
