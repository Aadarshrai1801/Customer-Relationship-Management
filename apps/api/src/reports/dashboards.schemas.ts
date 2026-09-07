import { z } from 'zod';

export const DASHBOARD_WIDGET_TYPES = [
  'forecast-summary',
  'pipeline-funnel',
  'activity-chart',
  'conversion-funnel',
  'overdue-tasks',
  'recent-activities',
] as const;

const widgetSchema = z
  .object({
    key: z.string().trim().min(1).max(50),
    type: z.enum(DASHBOARD_WIDGET_TYPES),
    title: z.string().trim().max(100).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const createDashboardSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100),
    isDefault: z.boolean().default(false),
    layout: z.array(widgetSchema).max(20).default([]),
  })
  .strict();

export const updateDashboardSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    isDefault: z.boolean().optional(),
    layout: z.array(widgetSchema).max(20).optional(),
  })
  .strict();

export type CreateDashboardInput = z.infer<typeof createDashboardSchema>;
export type UpdateDashboardInput = z.infer<typeof updateDashboardSchema>;
export type DashboardWidget = z.infer<typeof widgetSchema>;
