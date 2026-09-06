import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { roles, users, type Role, type User } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import {
  assertEditableFields,
  checkRecordAccess,
  filterReadableFields,
  hasScope,
} from '../rbac/permissions';
import type { ChangeRoleInput, UpdateUserInput } from './users.schemas';

export interface SerializedUser {
  id: string;
  name: string;
  status: string;
  timezone: string;
  role: { id: string; key: string; name: string };
  createdAt: Date;
  email?: string;
}

function mapServiceError(err: unknown): never {
  const coded = err as { code?: string; fields?: string[]; message?: string };
  if (coded?.code === 'RECORD_FORBIDDEN') {
    throw new ForbiddenException({
      message: 'Not allowed to access this record',
      code: 'RECORD_FORBIDDEN',
    });
  }
  if (coded?.code === 'FIELD_NOT_EDITABLE') {
    throw new BadRequestException({
      message: `Fields not editable: ${(coded.fields ?? []).join(', ')}`,
      code: 'FIELD_NOT_EDITABLE',
      fields: coded.fields ?? [],
    });
  }
  throw err;
}

function serialize(
  viewer: AuthContext,
  user: User,
  role: Pick<Role, 'id' | 'key' | 'name'>,
): SerializedUser {
  const base = {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    timezone: user.timezone,
    role: { id: role.id, key: role.key, name: role.name },
    createdAt: user.createdAt,
  };
  return filterReadableFields(viewer.role.permissions, 'user', base) as SerializedUser;
}

@Injectable()
export class UsersService {
  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  async list(auth: AuthContext): Promise<SerializedUser[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db
        .select({ user: users, role: roles })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.orgId, auth.org.id));
      const visible = rows.filter((row) => {
        try {
          checkRecordAccess(auth.role.permissions, 'user', row.user.id, auth.user.id);
          return true;
        } catch {
          return false;
        }
      });
      return visible.map((row) => serialize(auth, row.user, row.role));
    });
  }

  async getById(auth: AuthContext, id: string): Promise<SerializedUser> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.findInOrg(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'User not found', code: 'USER_NOT_FOUND' });
      }
      try {
        checkRecordAccess(auth.role.permissions, 'user', row.user.id, auth.user.id);
      } catch (err) {
        mapServiceError(err);
      }
      return serialize(auth, row.user, row.role);
    });
  }

  async update(auth: AuthContext, id: string, patch: UpdateUserInput): Promise<SerializedUser> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.findInOrg(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'User not found', code: 'USER_NOT_FOUND' });
      }
      const isSelf = row.user.id === auth.user.id;
      if (!isSelf && !hasScope(auth.role.permissions, 'users:manage')) {
        throw new ForbiddenException({
          message: 'Missing required scope: users:manage',
          code: 'SCOPE_FORBIDDEN',
        });
      }
      if (!isSelf) {
        try {
          checkRecordAccess(auth.role.permissions, 'user', row.user.id, auth.user.id);
        } catch (err) {
          mapServiceError(err);
        }
      }
      try {
        assertEditableFields(auth.role.permissions, 'user', Object.keys(patch));
      } catch (err) {
        mapServiceError(err);
      }
      const [updated] = await db
        .update(users)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(users.id, row.user.id))
        .returning();
      if (!updated) throw new Error('Failed to update user');
      return serialize(auth, updated, row.role);
    });
  }

  async changeRole(auth: AuthContext, id: string, input: ChangeRoleInput): Promise<SerializedUser> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.findInOrg(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'User not found', code: 'USER_NOT_FOUND' });
      }
      if (row.user.id === auth.user.id) {
        throw new ForbiddenException({
          message: 'You cannot change your own role',
          code: 'SELF_ROLE_CHANGE_FORBIDDEN',
        });
      }
      const [role] = await db
        .select()
        .from(roles)
        .where(and(eq(roles.orgId, auth.org.id), eq(roles.key, input.roleKey)));
      if (!role) {
        throw new NotFoundException({ message: 'Role not found', code: 'ROLE_NOT_FOUND' });
      }
      if (row.role.key === 'owner' && role.key !== 'owner') {
        const owners = await db
          .select({ id: users.id })
          .from(users)
          .innerJoin(roles, eq(users.roleId, roles.id))
          .where(and(eq(users.orgId, auth.org.id), eq(roles.key, 'owner')));
        if (owners.length <= 1) {
          throw new ConflictException({
            message: 'Cannot demote the last owner of the workspace',
            code: 'LAST_OWNER',
          });
        }
      }
      if (row.user.roleId !== role.id) {
        await db.update(users).set({ roleId: role.id }).where(eq(users.id, row.user.id));
      }
      const refreshed = await this.findInOrg(db, auth.org.id, id);
      if (!refreshed) throw new Error('Failed to reload user');
      return serialize(auth, refreshed.user, refreshed.role);
    });
  }

  async setStatus(
    auth: AuthContext,
    id: string,
    status: 'suspended' | 'active',
  ): Promise<SerializedUser> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.findInOrg(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'User not found', code: 'USER_NOT_FOUND' });
      }
      if (row.user.id === auth.user.id) {
        throw new ForbiddenException({
          message: 'You cannot suspend your own account',
          code: 'SELF_SUSPEND_FORBIDDEN',
        });
      }
      const [updated] = await db
        .update(users)
        .set({ status })
        .where(eq(users.id, row.user.id))
        .returning();
      if (!updated) throw new Error('Failed to update user');
      return serialize(auth, updated, row.role);
    });
  }

  private async findInOrg(
    db: NexusDb,
    orgId: string,
    id: string,
  ): Promise<{ user: User; role: Role } | null> {
    const [row] = await db
      .select({ user: users, role: roles })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(and(eq(users.id, id), eq(users.orgId, orgId)));
    return row ?? null;
  }
}
