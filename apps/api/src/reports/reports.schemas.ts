import { z } from 'zod';

const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

const dateRange = {
  from: z.string().date().optional(),
  to: z.string().date().optional(),
};

export const forecastReportQuerySchema = z
  .object({
    pipelineId: z.string().uuid().optional(),
    ownerId: z.string().uuid().optional(),
    refresh: boolString,
  })
  .strict();

export const pipelineReportQuerySchema = z
  .object({
    pipelineId: z.string().uuid().optional(),
    refresh: boolString,
  })
  .strict();

export const activityReportQuerySchema = z
  .object({
    ...dateRange,
    ownerId: z.string().uuid().optional(),
    refresh: boolString,
  })
  .strict();

export const conversionReportQuerySchema = z
  .object({
    ...dateRange,
    refresh: boolString,
  })
  .strict();

export type ForecastReportQuery = z.infer<typeof forecastReportQuerySchema>;
export type PipelineReportQuery = z.infer<typeof pipelineReportQuerySchema>;
export type ActivityReportQuery = z.infer<typeof activityReportQuerySchema>;
export type ConversionReportQuery = z.infer<typeof conversionReportQuerySchema>;
