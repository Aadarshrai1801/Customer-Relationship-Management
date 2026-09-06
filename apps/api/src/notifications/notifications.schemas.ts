import { z } from 'zod';

export const listNotificationsQuerySchema = z.object({
  unreadOnly: z
    .preprocess((val) => val === true || val === 'true', z.boolean())
    .optional()
    .default(false),
  limit: z
    .preprocess((val) => (val !== undefined ? Number(val) : 50), z.number().int().min(1).max(100))
    .optional()
    .default(50),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
