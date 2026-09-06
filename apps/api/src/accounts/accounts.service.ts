import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { accounts, contacts, users, type Account } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService, diffObjects } from '../audit/audit.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import {
  computeFormulas,
  validateCustomFields,
  type FieldDefinition,
} from '../custom-fields/field-validation';
import { checkRecordAccess, fieldRule, filterReadableFields, hasScope } from '../rbac/permissions';
import type { CreateAccountInput, ListAccountsQuery, UpdateAccountInput } from './accounts.schemas';

export interface SerializedAccount {
  id: string;
  name: string;
  website: string | null;
  domains: string[];
  phone: string | null;
  industry: string | null;
  parentId: string | null;
  parent: { id: string; name: string } | null;
  children: Array<{ id: string; name: string }>;
  contactCount: number;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  tags: string[];
  customFields: Record<string, unknown>;
  computedFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}

function validationFailed(errors: Array<{ path: string; message: string }>): never {
  throw new BadRequestException({
    message: 'Validation failed',
    code: 'VALIDATION_ERROR',
    errors,
  });
}

function recordForbidden(): never {
  throw new ForbiddenException({
    message: 'Not allowed to access this record',
    code: 'RECORD_FORBIDDEN',
  });
}

function parseCursor(cursor: string): { time: Date; id: string } | null {
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const time = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(time.getTime()) || !id) return null;
  return { time, id };
}

@Injectable()
export class AccountsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CustomFieldsService) private readonly fields: CustomFieldsService,
  ) {}

  async create(auth: AuthContext, input: CreateAccountInput): Promise<SerializedAccount> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'account');
      const { values: customFields, issues } = validateCustomFields(defs, input.customFields);
      if (issues.length > 0) {
        validationFailed(
          issues.map((i) => ({ path: `customFields.${i.key}`, message: `${i.key}: ${i.message}` })),
        );
      }
      const ownerId = await this.resolveOwnerForCreate(db, auth, input.ownerId);
      let parentId: string | null = null;
      if (input.parentId) {
        parentId = (await this.requireAccount(db, auth.org.id, input.parentId)).id;
      }
      const [created] = await db
        .insert(accounts)
        .values({
          orgId: auth.org.id,
          name: input.name,
          website: input.website || null,
          domains: input.domains,
          phone: input.phone || null,
          industry: input.industry || null,
          parentId,
          ownerId,
          tags: input.tags,
          customFields,
        })
        .returning();
      if (!created) throw new Error('Failed to create account');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'account.created',
        entityType: 'account',
        entityId: created.id,
        newValues: { name: created.name, parentId: created.parentId, ownerId: created.ownerId },
      });
      return this.serialize(db, auth, defs, created);
    });
  }

  async list(
    auth: AuthContext,
    query: ListAccountsQuery,
  ): Promise<{ accounts: SerializedAccount[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'account');
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [eq(accounts.orgId, auth.org.id), isNull(accounts.deletedAt)];
      const canSeeAll = this.recordScope(auth) === 'all';
      if (!canSeeAll) {
        conditions.push(eq(accounts.ownerId, auth.user.id));
      }
      if (query.parentId) conditions.push(eq(accounts.parentId, query.parentId));
      if (query.ownerId) {
        if (!canSeeAll && query.ownerId !== auth.user.id) {
          return { accounts: [], nextCursor: null };
        }
        conditions.push(eq(accounts.ownerId, query.ownerId));
      }
      if (query.tag) conditions.push(sql`${accounts.tags} @> ARRAY[${query.tag}]::text[]`);
      if (query.q) {
        const pattern = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
        const nameMatch = sql`${accounts.name} ILIKE ${pattern}`;
        const domainMatch = sql`array_to_string(${accounts.domains}, ',') ILIKE ${pattern}`;
        conditions.push(or(nameMatch, domainMatch)!);
      }
      if (query.cursor) {
        const parsed = parseCursor(query.cursor);
        if (!parsed) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
        conditions.push(
          sql`(${accounts.createdAt}, ${accounts.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ account: accounts, owner: users })
        .from(accounts)
        .leftJoin(users, eq(accounts.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(accounts.createdAt), desc(accounts.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const serialized = await Promise.all(
        page.map((row) =>
          this.serializeJoined(
            db,
            auth,
            defs,
            row.account,
            row.owner ? { id: row.owner.id, name: row.owner.name } : null,
          ),
        ),
      );
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? `${last.account.createdAt.toISOString()}|${last.account.id}`
          : null;
      return { accounts: serialized, nextCursor };
    });
  }

  async getById(auth: AuthContext, id: string): Promise<SerializedAccount> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'account');
      const row = await this.findLive(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
      }
      this.assertReadable(auth, row.account.ownerId);
      return this.serializeJoined(db, auth, defs, row.account, row.owner);
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    patch: UpdateAccountInput,
  ): Promise<SerializedAccount> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'account');
      const row = await this.findLive(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
      }
      const current = row.account;
      this.assertReadable(auth, current.ownerId);

      let parentId = current.parentId;
      if (patch.parentId !== undefined) {
        parentId = patch.parentId
          ? (await this.requireAccount(db, auth.org.id, patch.parentId)).id
          : null;
        await this.assertNoCycle(db, auth.org.id, current.id, parentId);
      }
      let ownerId = current.ownerId;
      if (patch.ownerId !== undefined) {
        if (!hasScope(auth.role.permissions, 'users:manage')) {
          throw new ForbiddenException({
            message: 'Missing required scope: users:manage',
            code: 'SCOPE_FORBIDDEN',
          });
        }
        ownerId = patch.ownerId ? await this.requireMember(db, auth.org.id, patch.ownerId) : null;
      }

      let customFields = (current.customFields ?? {}) as Record<string, unknown>;
      if (patch.customFields !== undefined && patch.customFields !== null) {
        const merged = { ...customFields };
        for (const [key, value] of Object.entries(patch.customFields)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        const { values, issues } = validateCustomFields(defs, merged);
        if (issues.length > 0) {
          validationFailed(
            issues.map((i) => ({
              path: `customFields.${i.key}`,
              message: `${i.key}: ${i.message}`,
            })),
          );
        }
        customFields = values;
      }

      const before = {
        name: current.name,
        website: current.website,
        domains: current.domains,
        phone: current.phone,
        industry: current.industry,
        parentId: current.parentId,
        ownerId: current.ownerId,
        tags: current.tags,
      };
      const [updated] = await db
        .update(accounts)
        .set({
          name: patch.name ?? current.name,
          website: patch.website !== undefined ? patch.website : current.website,
          domains: patch.domains ?? current.domains,
          phone: patch.phone !== undefined ? patch.phone : current.phone,
          industry: patch.industry !== undefined ? patch.industry : current.industry,
          parentId,
          ownerId,
          tags: patch.tags ?? current.tags,
          customFields,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, current.id))
        .returning();
      if (!updated) throw new Error('Failed to update account');

      const { oldValues, newValues } = diffObjects(before, {
        name: updated.name,
        website: updated.website,
        domains: updated.domains,
        phone: updated.phone,
        industry: updated.industry,
        parentId: updated.parentId,
        ownerId: updated.ownerId,
        tags: updated.tags,
      });
      const customDiff = diffObjects(
        (current.customFields ?? {}) as Record<string, unknown>,
        (updated.customFields ?? {}) as Record<string, unknown>,
      );
      if (Object.keys(newValues).length > 0 || Object.keys(customDiff.newValues).length > 0) {
        await this.audit.record(db, {
          orgId: auth.org.id,
          actorUserId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'account.updated',
          entityType: 'account',
          entityId: updated.id,
          oldValues: { ...oldValues, customFields: customDiff.oldValues },
          newValues: { ...newValues, customFields: customDiff.newValues },
        });
      }
      return this.serialize(db, auth, defs, updated);
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.findLive(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
      }
      this.assertReadable(auth, row.account.ownerId);
      await db
        .update(accounts)
        .set({ deletedAt: new Date() })
        .where(eq(accounts.id, row.account.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'account.deleted',
        entityType: 'account',
        entityId: row.account.id,
        oldValues: { name: row.account.name },
      });
      return { ok: true as const };
    });
  }

  private recordScope(auth: AuthContext): 'all' | 'own' {
    return auth.role.permissions?.recordAccess?.['account'] ?? 'own';
  }

  private assertReadable(auth: AuthContext, ownerId: string | null): void {
    try {
      checkRecordAccess(auth.role.permissions, 'account', ownerId ?? '', auth.user.id);
    } catch {
      recordForbidden();
    }
  }

  private async requireAccount(db: NexusDb, orgId: string, accountId: string) {
    const [account] = await db
      .select()
      .from(accounts)
      .where(
        and(eq(accounts.id, accountId), eq(accounts.orgId, orgId), isNull(accounts.deletedAt)),
      );
    if (!account) {
      throw new NotFoundException({ message: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
    }
    return account;
  }

  private async requireMember(db: NexusDb, orgId: string, userId: string): Promise<string> {
    const [member] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)));
    if (!member) {
      throw new BadRequestException({
        message: 'Owner must be a workspace member',
        code: 'OWNER_NOT_MEMBER',
      });
    }
    return member.id;
  }

  private async resolveOwnerForCreate(
    db: NexusDb,
    auth: AuthContext,
    ownerId: string | undefined,
  ): Promise<string> {
    if (!ownerId || ownerId === auth.user.id) return auth.user.id;
    if (!hasScope(auth.role.permissions, 'users:manage')) {
      throw new ForbiddenException({
        message: 'Assigning another owner requires users:manage',
        code: 'SCOPE_FORBIDDEN',
      });
    }
    return this.requireMember(db, auth.org.id, ownerId);
  }

  /** Walks the parent chain; rejects self-parenting and any cycle (bounded). */
  private async assertNoCycle(
    db: NexusDb,
    orgId: string,
    accountId: string,
    parentId: string | null,
  ): Promise<void> {
    let current = parentId;
    const seen = new Set<string>();
    for (let depth = 0; depth < 50 && current; depth += 1) {
      if (current === accountId || seen.has(current)) {
        throw new ConflictException({
          message: 'Account hierarchy cannot contain a cycle',
          code: 'ACCOUNT_CYCLE',
        });
      }
      seen.add(current);
      const [row] = await db
        .select({ parentId: accounts.parentId })
        .from(accounts)
        .where(and(eq(accounts.id, current), eq(accounts.orgId, orgId)));
      current = row?.parentId ?? null;
    }
  }

  private async findLive(db: NexusDb, orgId: string, id: string) {
    const [row] = await db
      .select({ account: accounts, owner: users })
      .from(accounts)
      .leftJoin(users, eq(accounts.ownerId, users.id))
      .where(and(eq(accounts.id, id), eq(accounts.orgId, orgId), isNull(accounts.deletedAt)));
    if (!row) return null;
    return {
      account: row.account,
      owner: row.owner ? { id: row.owner.id, name: row.owner.name } : null,
    };
  }

  private async serialize(
    db: NexusDb,
    auth: AuthContext,
    defs: FieldDefinition[],
    account: Account,
  ): Promise<SerializedAccount> {
    const [owner] = account.ownerId
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, account.ownerId))
      : [undefined];
    return this.serializeJoined(db, auth, defs, account, owner ?? null);
  }

  private async serializeJoined(
    db: NexusDb,
    auth: AuthContext,
    defs: FieldDefinition[],
    account: Account,
    owner: { id: string; name: string } | null,
  ): Promise<SerializedAccount> {
    const [parent] = account.parentId
      ? await db
          .select({ id: accounts.id, name: accounts.name })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, account.parentId),
              eq(accounts.orgId, account.orgId),
              isNull(accounts.deletedAt),
            ),
          )
      : [undefined];
    const children = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(
        and(
          eq(accounts.parentId, account.id),
          eq(accounts.orgId, account.orgId),
          isNull(accounts.deletedAt),
        ),
      );
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, account.id),
          eq(contacts.orgId, account.orgId),
          isNull(contacts.deletedAt),
        ),
      );
    const contactCount = row?.count ?? 0;
    const { computed, errors } = computeFormulas(
      defs,
      (account.customFields ?? {}) as Record<string, unknown>,
    );
    const record: Record<string, unknown> = {
      id: account.id,
      name: account.name,
      website: account.website,
      domains: account.domains,
      phone: account.phone,
      industry: account.industry,
      parentId: account.parentId,
      parent: parent ?? null,
      children,
      contactCount,
      ownerId: account.ownerId,
      owner,
      tags: account.tags,
      customFields: this.filterCustom(account.customFields, auth),
      computedFields: this.filterCustom(computed, auth),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
    const visible = filterReadableFields(auth.role.permissions, 'account', record);
    if (Object.keys(errors).length > 0) {
      (visible as Record<string, unknown>)['formulaErrors'] = errors;
    }
    return visible as SerializedAccount;
  }

  private filterCustom(
    values: Record<string, unknown> | null | undefined,
    auth: AuthContext,
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (fieldRule(auth.role.permissions, 'account', key) === 'none') continue;
      output[key] = value;
    }
    return output;
  }
}
