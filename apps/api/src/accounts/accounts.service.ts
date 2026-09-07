import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { accounts, accountMerges, contacts, deals, users, type Account } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService, diffObjects } from '../audit/audit.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import {
  assertValidMergeChoices,
  DedupService,
  mergeConflicts,
  type RecordMatch,
} from '../dedup/dedup.service';
import {
  computeFormulas,
  validateCustomFields,
  type FieldDefinition,
} from '../custom-fields/field-validation';
import { checkRecordAccess, fieldRule, filterReadableFields, hasScope } from '../rbac/permissions';
import type { CreateAccountInput, ListAccountsQuery, UpdateAccountInput } from './accounts.schemas';

export interface AccountWarning {
  code: 'POSSIBLE_DUPLICATE';
  message: string;
  accountIds: string[];
  confidence: 'exact' | 'high' | 'medium';
}

export interface MergeFieldComparison {
  field: string;
  winner: unknown;
  loser: unknown;
  conflict: boolean;
}

export interface AccountMergePreview {
  winnerId: string;
  loserId: string;
  fields: MergeFieldComparison[];
  tags: { winner: string[]; loser: string[]; merged: string[] };
  domains: { winner: string[]; loser: string[]; merged: string[] };
  contactsMoved: number;
  childrenMoved: number;
}
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
    @Inject(DedupService) private readonly dedup: DedupService,
  ) {}

  async create(
    auth: AuthContext,
    input: CreateAccountInput,
  ): Promise<{ account: SerializedAccount; warnings: AccountWarning[] }> {
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
      const matches = await this.dedup.findAccountMatches(
        db,
        auth.org.id,
        {
          id: created.id,
          name: created.name,
          website: created.website,
          phone: created.phone,
          domains: created.domains,
        },
        created.id,
      );
      const warnings = this.warningsForMatches(matches);
      await this.dedup.recordCandidates(db, auth.org.id, 'account', created.id, matches);
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'account.created',
        entityType: 'account',
        entityId: created.id,
        newValues: { name: created.name, parentId: created.parentId, ownerId: created.ownerId },
      });
      return { account: await this.serialize(db, auth, defs, created), warnings };
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
      const [openDeal] = await db
        .select({ id: deals.id })
        .from(deals)
        .where(
          and(
            eq(deals.orgId, auth.org.id),
            eq(deals.accountId, row.account.id),
            eq(deals.status, 'open'),
            isNull(deals.deletedAt),
          ),
        )
        .limit(1);
      if (openDeal) {
        throw new ConflictException({
          message: 'Account has open deals — move or close them before deleting',
          code: 'ACCOUNT_HAS_OPEN_DEALS',
          dealId: openDeal.id,
        });
      }
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

  warningsForMatches(matches: RecordMatch[]): AccountWarning[] {
    return matches.map((m) => ({
      code: 'POSSIBLE_DUPLICATE' as const,
      message: `Possible duplicate account (${m.confidence} confidence)`,
      accountIds: [m.id],
      confidence: m.confidence,
    }));
  }

  private static readonly MERGEABLE_STANDARD_FIELDS = [
    'name',
    'website',
    'phone',
    'industry',
    'parentId',
  ] as const;

  async mergePreview(
    auth: AuthContext,
    winnerId: string,
    loserId: string,
  ): Promise<AccountMergePreview> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const { winner, loser, defs } = await this.loadMergePair(db, auth, winnerId, loserId);
      return this.buildMergePreview(db, auth.org.id, defs, winner, loser);
    });
  }

  async mergeAccounts(
    auth: AuthContext,
    winnerId: string,
    loserId: string,
    fieldChoices: Record<string, 'winner' | 'loser'>,
  ): Promise<{ account: SerializedAccount; mergedLoserId: string }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const { winner, loser, defs } = await this.loadMergePair(db, auth, winnerId, loserId);
      const preview = await this.buildMergePreview(db, auth.org.id, defs, winner, loser);
      const eligible = preview.fields.map((f) => f.field);
      const conflicts = mergeConflicts(preview.fields);
      try {
        assertValidMergeChoices(eligible, conflicts, fieldChoices);
      } catch (err) {
        throw new BadRequestException({
          message: (err as Error).message,
          code: 'MERGE_CHOICE_INVALID',
        });
      }

      const pick = (field: string, winnerValue: unknown, loserValue: unknown): unknown =>
        fieldChoices[field] === 'loser' ? loserValue : winnerValue;

      const winnerBefore = { ...winner };
      const mergedTags = [...new Set([...winner.tags, ...loser.tags])].slice(0, 20);
      const mergedDomains = [...new Set([...winner.domains, ...loser.domains])].slice(0, 20);
      const mergedCustom: Record<string, unknown> = {
        ...(winner.customFields as Record<string, unknown>),
      };
      for (const def of defs) {
        if (def.type === 'formula') continue;
        const key = `custom.${def.key}`;
        if (!(key in fieldChoices)) continue;
        const loserCustom = (loser.customFields ?? {}) as Record<string, unknown>;
        if (fieldChoices[key] === 'loser') {
          if (def.key in loserCustom) mergedCustom[def.key] = loserCustom[def.key];
          else delete mergedCustom[def.key];
        }
      }
      let parentId = pick('parentId', winner.parentId, loser.parentId) as string | null;
      if (parentId === winner.id) {
        // Winner sat under the loser: transplant one level up instead of
        // pointing at a deleted record.
        parentId = loser.parentId === winner.id ? null : loser.parentId;
      }
      if (parentId) {
        await this.requireAccount(db, auth.org.id, parentId);
        await this.assertNoCycle(db, auth.org.id, winner.id, parentId);
      }
      const [updated] = await db
        .update(accounts)
        .set({
          name: pick('name', winner.name, loser.name) as string,
          website: pick('website', winner.website, loser.website) as string | null,
          phone: pick('phone', winner.phone, loser.phone) as string | null,
          industry: pick('industry', winner.industry, loser.industry) as string | null,
          parentId,
          tags: mergedTags,
          domains: mergedDomains,
          customFields: mergedCustom,
          updatedAt: new Date(),
        })
        .where(eq(accounts.id, winner.id))
        .returning();
      if (!updated) throw new Error('Failed to merge accounts');

      const movedContacts = await db
        .update(contacts)
        .set({ accountId: winner.id })
        .where(and(eq(contacts.accountId, loser.id), eq(contacts.orgId, auth.org.id)))
        .returning({ id: contacts.id });
      const movedChildren = await db
        .update(accounts)
        .set({ parentId: winner.id })
        .where(
          and(
            eq(accounts.parentId, loser.id),
            eq(accounts.orgId, auth.org.id),
            isNull(accounts.deletedAt),
          ),
        )
        .returning({ id: accounts.id });

      await db.update(accounts).set({ deletedAt: new Date() }).where(eq(accounts.id, loser.id));
      await db.insert(accountMerges).values({
        orgId: auth.org.id,
        winnerId: winner.id,
        loserId: loser.id,
        loserSnapshot: { loser, winnerBefore, winnerAfter: updated },
        fieldChoices,
        mergedBy: auth.user.id,
      });
      await this.dedup.markMerged(db, auth.org.id, 'account', winner.id, loser.id);
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'account.merged',
        entityType: 'account',
        entityId: winner.id,
        newValues: {
          loserId: loser.id,
          loserName: loser.name,
          fieldChoices,
          contactsMoved: movedContacts.length,
          childrenMoved: movedChildren.length,
        },
      });
      return { account: await this.serialize(db, auth, defs, updated), mergedLoserId: loser.id };
    });
  }

  private async loadMergePair(db: NexusDb, auth: AuthContext, winnerId: string, loserId: string) {
    if (winnerId === loserId) {
      throw new BadRequestException({
        message: 'Cannot merge an account into itself',
        code: 'MERGE_SAME_RECORD',
      });
    }
    const defs = await this.fields.loadDefinitions(db, auth.org.id, 'account');
    const winner = await this.requireLiveAccount(db, auth, winnerId);
    const loser = await this.requireLiveAccount(db, auth, loserId);
    return { winner, loser, defs };
  }

  private async requireLiveAccount(db: NexusDb, auth: AuthContext, id: string): Promise<Account> {
    const row = await this.findLive(db, auth.org.id, id);
    if (!row) {
      throw new NotFoundException({ message: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
    }
    this.assertReadable(auth, row.account.ownerId);
    return row.account;
  }

  private async buildMergePreview(
    db: NexusDb,
    orgId: string,
    defs: FieldDefinition[],
    winner: Account,
    loser: Account,
  ): Promise<AccountMergePreview> {
    const standard = AccountsService.MERGEABLE_STANDARD_FIELDS.map((field) => ({
      field,
      winner: winner[field],
      loser: loser[field],
    }));
    const winnerCustom = (winner.customFields ?? {}) as Record<string, unknown>;
    const loserCustom = (loser.customFields ?? {}) as Record<string, unknown>;
    const customKeys = [
      ...new Set([...Object.keys(winnerCustom), ...Object.keys(loserCustom)]),
    ].filter((key) => defs.some((d) => d.key === key && d.type !== 'formula'));
    const custom = customKeys.map((key) => ({
      field: `custom.${key}`,
      winner: winnerCustom[key] ?? null,
      loser: loserCustom[key] ?? null,
    }));
    const fields = [...standard, ...custom].map((f) => ({
      ...f,
      conflict: mergeConflicts([{ field: f.field, winner: f.winner, loser: f.loser }]).length > 0,
    }));
    const movedContacts = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, loser.id),
          eq(contacts.orgId, orgId),
          isNull(contacts.deletedAt),
        ),
      );
    const movedChildren = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.parentId, loser.id), eq(accounts.orgId, orgId), isNull(accounts.deletedAt)),
      );
    return {
      winnerId: winner.id,
      loserId: loser.id,
      fields,
      tags: {
        winner: winner.tags,
        loser: loser.tags,
        merged: [...new Set([...winner.tags, ...loser.tags])].slice(0, 20),
      },
      domains: {
        winner: winner.domains,
        loser: loser.domains,
        merged: [...new Set([...winner.domains, ...loser.domains])].slice(0, 20),
      },
      contactsMoved: movedContacts.length,
      childrenMoved: movedChildren.length,
    };
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
