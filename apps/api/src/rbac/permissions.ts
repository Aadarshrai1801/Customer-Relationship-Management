import { z } from 'zod';
import type { RolePermissions } from '@nexus/db';

const scopePattern = /^(\*|[a-z_]+:[a-z_*]+)$/;
const fieldKeyPattern = /^[a-z]+\.[A-Za-z0-9_]+$/;

export const rolePermissionsSchema = z.object({
  version: z.literal(1),
  scopes: z.array(z.string().regex(scopePattern, 'Invalid scope format')).max(100),
  recordAccess: z.record(z.string(), z.enum(['all', 'own'])).default({}),
  fields: z
    .record(
      z.string().regex(fieldKeyPattern, 'Invalid field key (expected entity.field)'),
      z.enum(['edit', 'read', 'none']),
    )
    .default({}),
});

export type ValidatedRolePermissions = z.infer<typeof rolePermissionsSchema>;

export function parsePermissions(input: unknown): RolePermissions {
  return rolePermissionsSchema.parse(input) as RolePermissions;
}

/** True when the permission set grants `required` (exact match or `*` wildcard). */
export function hasScope(
  permissions: Pick<RolePermissions, 'scopes'> | null | undefined,
  required: string,
): boolean {
  const scopes = permissions?.scopes ?? [];
  return scopes.includes('*') || scopes.includes(required);
}

/**
 * Record-level check shared by all entity types. Unknown entities default to
 * `own` (fail-closed). Throws a plain Error carrying a code; services map it
 * to a 403 response.
 */
export function checkRecordAccess(
  permissions: Pick<RolePermissions, 'recordAccess'> | null | undefined,
  entity: string,
  ownerId: string,
  actorId: string,
): void {
  const scope = permissions?.recordAccess?.[entity] ?? 'own';
  if (scope === 'all') return;
  if (ownerId === actorId) return;
  const err = new Error(`Record access denied for ${entity}`);
  (err as Error & { code?: string }).code = 'RECORD_FORBIDDEN';
  throw err;
}

export type FieldRule = 'edit' | 'read' | 'none';

/** Field-level rule lookup with fail-open default for reads (`edit`). */
export function fieldRule(
  permissions: Pick<RolePermissions, 'fields'> | null | undefined,
  entity: string,
  field: string,
): FieldRule {
  return permissions?.fields?.[`${entity}.${field}`] ?? 'edit';
}

/** Strips `none` fields for read serialization. Never mutates the input. */
export function filterReadableFields<T extends Record<string, unknown>>(
  permissions: Pick<RolePermissions, 'fields'> | null | undefined,
  entity: string,
  record: T,
): Partial<T> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (fieldRule(permissions, entity, key) === 'none') continue;
    output[key] = value;
  }
  return output as Partial<T>;
}

/**
 * Returns the subset of `fields` the actor may write. Anything ruled `read`
 * or `none` is rejected explicitly (no silent drops).
 */
export function assertEditableFields(
  permissions: Pick<RolePermissions, 'fields'> | null | undefined,
  entity: string,
  fields: string[],
): void {
  const blocked = fields.filter((f) => fieldRule(permissions, entity, f) !== 'edit');
  if (blocked.length > 0) {
    const err = new Error(`Fields not editable: ${blocked.join(', ')}`);
    (err as Error & { code?: string; fields?: string[] }).code = 'FIELD_NOT_EDITABLE';
    (err as Error & { code?: string; fields?: string[] }).fields = blocked;
    throw err;
  }
}
