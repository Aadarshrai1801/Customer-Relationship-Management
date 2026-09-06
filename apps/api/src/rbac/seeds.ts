import type { RolePermissions } from '@nexus/db';

function perms(
  scopes: string[],
  recordAccess: RolePermissions['recordAccess'] = {},
  fields: RolePermissions['fields'] = {},
): RolePermissions {
  return { version: 1, scopes, recordAccess, fields };
}

/**
 * System roles seeded for every new organization. Owner and admin are
 * identical in effect for module-1 entities; the distinction materializes
 * with org-level operations (billing, deletion) in later modules.
 */
export const SYSTEM_ROLE_SEEDS: Array<{ key: string; name: string; permissions: RolePermissions }> =
  [
    {
      key: 'owner',
      name: 'Owner',
      permissions: perms(['*'], { user: 'all' }),
    },
    {
      key: 'admin',
      name: 'Admin',
      permissions: perms(
        [
          'users:read',
          'users:invite',
          'users:manage',
          'roles:read',
          'roles:manage',
          'org:read',
          'org:manage',
          'audit:read',
          'custom_fields:read',
          'custom_fields:manage',
        ],
        { user: 'all' },
      ),
    },
    {
      key: 'manager',
      name: 'Manager',
      permissions: perms(['users:read', 'org:read', 'custom_fields:read'], { user: 'all' }),
    },
    {
      key: 'rep',
      name: 'Sales Rep',
      permissions: perms(['users:read', 'custom_fields:read'], { user: 'own' }),
    },
    {
      key: 'viewer',
      name: 'Viewer',
      permissions: perms(['custom_fields:read'], { user: 'own' }),
    },
  ];
