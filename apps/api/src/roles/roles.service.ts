import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { roles, users, type Role } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import type { CreateRoleInput, UpdateRoleInput } from './roles.schemas';

export interface SerializedRole {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  permissions: Role['permissions'];
  createdAt: Date;
}

function serialize(role: Role): SerializedRole {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    isSystem: role.isSystem,
    permissions: role.permissions,
    createdAt: role.createdAt,
  };
}

@Injectable()
export class RolesService {
  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  async list(auth: AuthContext): Promise<SerializedRole[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db.select().from(roles).where(eq(roles.orgId, auth.org.id));
      return rows.map(serialize);
    });
  }

  async create(auth: AuthContext, input: CreateRoleInput): Promise<SerializedRole> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [existing] = await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, auth.org.id), eq(roles.key, input.key)));
      if (existing) {
        throw new ConflictException({
          message: 'A role with this key already exists',
          code: 'ROLE_KEY_TAKEN',
        });
      }
      const [created] = await db
        .insert(roles)
        .values({
          orgId: auth.org.id,
          key: input.key,
          name: input.name,
          permissions: input.permissions,
          isSystem: false,
        })
        .returning();
      if (!created) throw new Error('Failed to create role');
      return serialize(created);
    });
  }

  async update(auth: AuthContext, id: string, input: UpdateRoleInput): Promise<SerializedRole> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const role = await this.findInOrg(db, auth.org.id, id);
      if (!role) {
        throw new NotFoundException({ message: 'Role not found', code: 'ROLE_NOT_FOUND' });
      }
      if (role.isSystem) {
        throw new ForbiddenException({
          message: 'System roles cannot be modified',
          code: 'ROLE_SYSTEM_IMMUTABLE',
        });
      }
      const [updated] = await db
        .update(roles)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(roles.id, role.id))
        .returning();
      if (!updated) throw new Error('Failed to update role');
      return serialize(updated);
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const role = await this.findInOrg(db, auth.org.id, id);
      if (!role) {
        throw new NotFoundException({ message: 'Role not found', code: 'ROLE_NOT_FOUND' });
      }
      if (role.isSystem) {
        throw new ForbiddenException({
          message: 'System roles cannot be deleted',
          code: 'ROLE_SYSTEM_IMMUTABLE',
        });
      }
      const [assigned] = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, auth.org.id), eq(users.roleId, role.id)));
      if (assigned) {
        throw new ConflictException({
          message: 'Role is assigned to users and cannot be deleted',
          code: 'ROLE_IN_USE',
        });
      }
      await db.delete(roles).where(eq(roles.id, role.id));
      return { ok: true as const };
    });
  }

  private async findInOrg(db: NexusDb, orgId: string, id: string): Promise<Role | null> {
    const [row] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.id, id), eq(roles.orgId, orgId)));
    return row ?? null;
  }
}
