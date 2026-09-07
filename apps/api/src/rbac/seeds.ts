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
 *
 * NOTE: each module that adds a record type must extend recordAccess here
 * (owner/admin/manager need 'all'), otherwise those roles are locked out.
 */
export const SYSTEM_ROLE_SEEDS: Array<{ key: string; name: string; permissions: RolePermissions }> =
  [
    {
      key: 'owner',
      name: 'Owner',
      permissions: perms(['*'], {
        user: 'all',
        contact: 'all',
        account: 'all',
        lead: 'all',
        deal: 'all',
      }),
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
          'contacts:read',
          'contacts:manage',
          'accounts:read',
          'accounts:manage',
          'leads:read',
          'leads:manage',
          'lead_routing:manage',
          'deals:read',
          'deals:manage',
          'pipelines:manage',
          'notifications:read',
        ],
        { user: 'all', contact: 'all', account: 'all', lead: 'all', deal: 'all' },
      ),
    },
    {
      key: 'manager',
      name: 'Manager',
      permissions: perms(
        [
          'users:read',
          'org:read',
          'custom_fields:read',
          'contacts:read',
          'accounts:read',
          'leads:read',
          'leads:manage',
          'lead_routing:manage',
          'deals:read',
          'notifications:read',
        ],
        {
          user: 'all',
          contact: 'all',
          account: 'all',
          lead: 'all',
          deal: 'all',
        },
      ),
    },
    {
      key: 'rep',
      name: 'Sales Rep',
      permissions: perms(
        [
          'users:read',
          'custom_fields:read',
          'contacts:read',
          'contacts:manage',
          'accounts:read',
          'accounts:manage',
          'leads:read',
          'leads:manage',
          'deals:read',
          'deals:manage',
          'notifications:read',
        ],
        {
          user: 'own',
          contact: 'own',
          account: 'own',
          lead: 'own',
          deal: 'own',
        },
      ),
    },
    {
      key: 'viewer',
      name: 'Viewer',
      permissions: perms(
        [
          'custom_fields:read',
          'contacts:read',
          'accounts:read',
          'leads:read',
          'deals:read',
          'notifications:read',
        ],
        {
          user: 'own',
          contact: 'own',
          account: 'own',
          lead: 'own',
          deal: 'own',
        },
      ),
    },
  ];
