import { z } from 'zod';
import { rolePermissionsSchema } from '../rbac/permissions';

const roleKeyPattern = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export const createRoleSchema = z
  .object({
    key: z.string().trim().toLowerCase().regex(roleKeyPattern, 'Invalid role key'),
    name: z.string().trim().min(1).max(100),
    permissions: rolePermissionsSchema,
  })
  .strict();

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    permissions: rolePermissionsSchema.optional(),
  })
  .strict();

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
