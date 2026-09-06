import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { accounts, contactMerges, contactNotes, contacts, users, type Contact } from '@nexus/db';
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
import type { CreateContactInput, ListContactsQuery, UpdateContactInput } from './contacts.schemas';

export interface ContactWarning {
  code: 'DUPLICATE_EMAIL' | 'POSSIBLE_DUPLICATE';
  message: string;
  contactIds: string[];
  confidence?: 'exact' | 'high' | 'medium';
}

export interface MergeFieldComparison {
  field: string;
  winner: unknown;
  loser: unknown;
  conflict: boolean;
}

export interface MergePreview {
  winnerId: string;
  loserId: string;
  fields: MergeFieldComparison[];
  tags: { winner: string[]; loser: string[]; merged: string[] };
  notesMoved: number;
}

export interface SerializedContact {
  id: string;
  accountId: string | null;
  account: { id: string; name: string } | null;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  title: string | null;
  lifecycleStage: string;
  tags: string[];
  customFields: Record<string, unknown>;
  computedFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  [key: string]: unknown;
}

interface JoinedContact {
  contact: Contact;
  account: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
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
export class ContactsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CustomFieldsService) private readonly fields: CustomFieldsService,
    @Inject(DedupService) private readonly dedup: DedupService,
  ) {}

  async create(
    auth: AuthContext,
    input: CreateContactInput,
  ): Promise<{ contact: SerializedContact; warnings: ContactWarning[] }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'contact');
      const account = input.accountId
        ? await this.requireAccount(db, auth.org.id, input.accountId)
        : null;
      const ownerId = await this.resolveOwnerForCreate(db, auth, input.ownerId);
      const { values: customFields, issues } = validateCustomFields(defs, input.customFields);
      if (issues.length > 0) {
        validationFailed(
          issues.map((i) => ({ path: `customFields.${i.key}`, message: `${i.key}: ${i.message}` })),
        );
      }
      const [created] = await db
        .insert(contacts)
        .values({
          orgId: auth.org.id,
          accountId: account?.id ?? null,
          ownerId,
          name: input.name,
          firstName: input.firstName || null,
          lastName: input.lastName || null,
          email: input.email,
          phone: input.phone || null,
          title: input.title || null,
          lifecycleStage: input.lifecycleStage,
          tags: input.tags,
          customFields,
        })
        .returning();
      if (!created) throw new Error('Failed to create contact');

      const matches = await this.dedup.findContactMatches(
        db,
        auth.org.id,
        { id: created.id, name: created.name, email: created.email, phone: created.phone },
        created.id,
      );
      const warnings = this.warningsForMatches(matches);
      await this.recordMatchCandidates(db, auth.org.id, created.id, matches);
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'contact.created',
        entityType: 'contact',
        entityId: created.id,
        newValues: {
          name: created.name,
          email: created.email,
          accountId: created.accountId,
          ownerId: created.ownerId,
          lifecycleStage: created.lifecycleStage,
          customFields: created.customFields,
        },
      });
      return { contact: await this.serialize(db, auth, defs, created), warnings };
    });
  }

  async list(
    auth: AuthContext,
    query: ListContactsQuery,
  ): Promise<{ contacts: SerializedContact[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'contact');
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [eq(contacts.orgId, auth.org.id), isNull(contacts.deletedAt)];
      const canSeeAll = this.recordScope(auth) === 'all';
      if (!canSeeAll) {
        conditions.push(eq(contacts.ownerId, auth.user.id));
      }
      if (query.accountId) conditions.push(eq(contacts.accountId, query.accountId));
      if (query.ownerId) {
        if (!canSeeAll && query.ownerId !== auth.user.id) {
          return { contacts: [], nextCursor: null };
        }
        conditions.push(eq(contacts.ownerId, query.ownerId));
      }
      if (query.lifecycleStage) conditions.push(eq(contacts.lifecycleStage, query.lifecycleStage));
      if (query.tag) conditions.push(sql`${contacts.tags} @> ARRAY[${query.tag}]::text[]`);
      if (query.q) {
        const pattern = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
        const nameMatch = sql`${contacts.name} ILIKE ${pattern}`;
        const emailMatch = sql`${contacts.email} ILIKE ${pattern}`;
        conditions.push(or(nameMatch, emailMatch)!);
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
          sql`(${contacts.createdAt}, ${contacts.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ contact: contacts, account: accounts, owner: users })
        .from(contacts)
        .leftJoin(accounts, eq(contacts.accountId, accounts.id))
        .leftJoin(users, eq(contacts.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(contacts.createdAt), desc(contacts.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const serialized = page.map((row) =>
        this.serializeJoined(auth, defs, row.contact, row.account, row.owner),
      );
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? `${last.contact.createdAt.toISOString()}|${last.contact.id}`
          : null;
      return { contacts: serialized, nextCursor };
    });
  }

  async getById(auth: AuthContext, id: string): Promise<SerializedContact> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'contact');
      const row = await this.requireLiveContact(db, auth.org.id, id);
      this.assertContactReadable(auth, row.contact.ownerId);
      return this.serializeJoined(auth, defs, row.contact, row.account, row.owner);
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    patch: UpdateContactInput,
  ): Promise<{ contact: SerializedContact; warnings: ContactWarning[] }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'contact');
      const row = await this.findLive(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
      }
      this.assertReadable(auth, row.contact.ownerId);

      let accountId = row.contact.accountId;
      if (patch.accountId !== undefined) {
        accountId = patch.accountId
          ? (await this.requireAccount(db, auth.org.id, patch.accountId)).id
          : null;
      }
      let ownerId = row.contact.ownerId;
      if (patch.ownerId !== undefined) {
        if (!hasScope(auth.role.permissions, 'users:manage')) {
          throw new ForbiddenException({
            message: 'Missing required scope: users:manage',
            code: 'SCOPE_FORBIDDEN',
          });
        }
        ownerId = patch.ownerId ? await this.requireMember(db, auth.org.id, patch.ownerId) : null;
      }

      let customFields = (row.contact.customFields ?? {}) as Record<string, unknown>;
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
        name: row.contact.name,
        email: row.contact.email,
        phone: row.contact.phone,
        title: row.contact.title,
        lifecycleStage: row.contact.lifecycleStage,
        accountId: row.contact.accountId,
        ownerId: row.contact.ownerId,
        tags: row.contact.tags,
      };
      const [updated] = await db
        .update(contacts)
        .set({
          accountId,
          ownerId,
          name: patch.name ?? row.contact.name,
          firstName: patch.firstName !== undefined ? patch.firstName : row.contact.firstName,
          lastName: patch.lastName !== undefined ? patch.lastName : row.contact.lastName,
          email: patch.email ?? row.contact.email,
          phone: patch.phone !== undefined ? patch.phone : row.contact.phone,
          title: patch.title !== undefined ? patch.title : row.contact.title,
          lifecycleStage: patch.lifecycleStage ?? row.contact.lifecycleStage,
          tags: patch.tags ?? row.contact.tags,
          customFields,
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, row.contact.id))
        .returning();
      if (!updated) throw new Error('Failed to update contact');

      const { oldValues, newValues } = diffObjects(before, {
        name: updated.name,
        email: updated.email,
        phone: updated.phone,
        title: updated.title,
        lifecycleStage: updated.lifecycleStage,
        accountId: updated.accountId,
        ownerId: updated.ownerId,
        tags: updated.tags,
      });
      const customDiff = diffObjects(
        (row.contact.customFields ?? {}) as Record<string, unknown>,
        (updated.customFields ?? {}) as Record<string, unknown>,
      );
      if (Object.keys(newValues).length > 0 || Object.keys(customDiff.newValues).length > 0) {
        await this.audit.record(db, {
          orgId: auth.org.id,
          actorUserId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'contact.updated',
          entityType: 'contact',
          entityId: updated.id,
          oldValues: { ...oldValues, customFields: customDiff.oldValues },
          newValues: { ...newValues, customFields: customDiff.newValues },
        });
      }
      const warnings =
        patch.email && patch.email !== row.contact.email
          ? this.warningsForMatches(
              await this.dedup.findContactMatches(
                db,
                auth.org.id,
                { id: updated.id, name: updated.name, email: updated.email, phone: updated.phone },
                updated.id,
              ),
            )
          : [];
      return { contact: await this.serialize(db, auth, defs, updated), warnings };
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.findLive(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
      }
      this.assertReadable(auth, row.contact.ownerId);
      // Open-deal guard lands with module 4.3 (deals do not exist yet).
      await db
        .update(contacts)
        .set({ deletedAt: new Date() })
        .where(eq(contacts.id, row.contact.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'contact.deleted',
        entityType: 'contact',
        entityId: row.contact.id,
        oldValues: { name: row.contact.name, email: row.contact.email },
      });
      return { ok: true as const };
    });
  }

  /** Duplicate warnings via the dedup engine (exact email keeps its own code per the AC). */
  warningsForMatches(matches: RecordMatch[]): ContactWarning[] {
    return matches.map((m) =>
      m.confidence === 'exact'
        ? {
            code: 'DUPLICATE_EMAIL' as const,
            message: 'Another contact already uses this email address',
            contactIds: [m.id],
            confidence: m.confidence,
          }
        : {
            code: 'POSSIBLE_DUPLICATE' as const,
            message: `Possible duplicate contact (${m.confidence} confidence)`,
            contactIds: [m.id],
            confidence: m.confidence,
          },
    );
  }

  /** Records on-create matches as review candidates (best confidence wins per pair). */
  async recordMatchCandidates(
    db: NexusDb,
    orgId: string,
    contactId: string,
    matches: RecordMatch[],
  ): Promise<void> {
    await this.dedup.recordCandidates(db, orgId, 'contact', contactId, matches);
  }

  private static readonly MERGEABLE_STANDARD_FIELDS = [
    'name',
    'firstName',
    'lastName',
    'email',
    'phone',
    'title',
    'lifecycleStage',
    'accountId',
  ] as const;

  /**
   * Merge preview: per-field winner/loser values with conflict flags, tag
   * union, and the number of notes that will move. Tags always union;
   * ownership stays with the winner.
   */
  async mergePreview(auth: AuthContext, winnerId: string, loserId: string): Promise<MergePreview> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const { winner, loser, defs } = await this.loadMergePair(db, auth, winnerId, loserId);
      return this.buildMergePreview(defs, winner.contact, loser.contact, db, auth.org.id);
    });
  }

  async mergeContacts(
    auth: AuthContext,
    winnerId: string,
    loserId: string,
    fieldChoices: Record<string, 'winner' | 'loser'>,
  ): Promise<{ contact: SerializedContact; mergedLoserId: string }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const { winner, loser, defs } = await this.loadMergePair(db, auth, winnerId, loserId);
      const preview = await this.buildMergePreview(
        defs,
        winner.contact,
        loser.contact,
        db,
        auth.org.id,
      );
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

      const winnerBefore = { ...winner.contact };
      const mergedTags = [...new Set([...winner.contact.tags, ...loser.contact.tags])].slice(0, 20);
      const mergedCustom: Record<string, unknown> = {
        ...(winner.contact.customFields as Record<string, unknown>),
      };
      for (const def of defs) {
        if (def.type === 'formula') continue;
        const key = `custom.${def.key}`;
        if (!(key in fieldChoices)) continue;
        const loserCustom = (loser.contact.customFields ?? {}) as Record<string, unknown>;
        if (fieldChoices[key] === 'loser') {
          if (def.key in loserCustom) mergedCustom[def.key] = loserCustom[def.key];
          else delete mergedCustom[def.key];
        }
      }
      const patch: Record<string, unknown> = {
        name: pick('name', winner.contact.name, loser.contact.name),
        firstName: pick('firstName', winner.contact.firstName, loser.contact.firstName),
        lastName: pick('lastName', winner.contact.lastName, loser.contact.lastName),
        email: pick('email', winner.contact.email, loser.contact.email),
        phone: pick('phone', winner.contact.phone, loser.contact.phone),
        title: pick('title', winner.contact.title, loser.contact.title),
        lifecycleStage: pick(
          'lifecycleStage',
          winner.contact.lifecycleStage,
          loser.contact.lifecycleStage,
        ),
        accountId: pick('accountId', winner.contact.accountId, loser.contact.accountId),
        tags: mergedTags,
        customFields: mergedCustom,
        updatedAt: new Date(),
      };
      const newAccountId = patch['accountId'] as string | null;
      if (newAccountId) {
        const [account] = await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, newAccountId),
              eq(accounts.orgId, auth.org.id),
              isNull(accounts.deletedAt),
            ),
          );
        if (!account) {
          throw new BadRequestException({
            message: 'Chosen account no longer exists',
            code: 'MERGE_ACCOUNT_INVALID',
          });
        }
      }
      const [updated] = await db
        .update(contacts)
        .set(patch as Partial<Contact>)
        .where(eq(contacts.id, winner.contact.id))
        .returning();
      if (!updated) throw new Error('Failed to merge contacts');

      const movedNotes = await db
        .update(contactNotes)
        .set({ contactId: winner.contact.id })
        .where(
          and(eq(contactNotes.contactId, loser.contact.id), eq(contactNotes.orgId, auth.org.id)),
        )
        .returning({ id: contactNotes.id });

      await db
        .update(contacts)
        .set({ deletedAt: new Date(), mergedIntoId: winner.contact.id })
        .where(eq(contacts.id, loser.contact.id));

      await db.insert(contactMerges).values({
        orgId: auth.org.id,
        winnerId: winner.contact.id,
        loserId: loser.contact.id,
        loserSnapshot: {
          loser: loser.contact,
          winnerBefore,
          winnerAfter: updated,
        },
        fieldChoices,
        mergedBy: auth.user.id,
      });
      await this.dedup.markMerged(db, auth.org.id, 'contact', winner.contact.id, loser.contact.id);
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'contact.merged',
        entityType: 'contact',
        entityId: winner.contact.id,
        newValues: {
          loserId: loser.contact.id,
          loserEmail: loser.contact.email,
          fieldChoices,
          notesMoved: movedNotes.length,
        },
      });
      return {
        contact: await this.serialize(db, auth, defs, updated),
        mergedLoserId: loser.contact.id,
      };
    });
  }

  private async loadMergePair(db: NexusDb, auth: AuthContext, winnerId: string, loserId: string) {
    if (winnerId === loserId) {
      throw new BadRequestException({
        message: 'Cannot merge a contact into itself',
        code: 'MERGE_SAME_RECORD',
      });
    }
    const defs = await this.fields.loadDefinitions(db, auth.org.id, 'contact');
    const winner = await this.requireLiveContact(db, auth.org.id, winnerId);
    const loser = await this.requireLiveContact(db, auth.org.id, loserId);
    this.assertContactReadable(auth, winner.contact.ownerId);
    this.assertContactReadable(auth, loser.contact.ownerId);
    return { winner, loser, defs };
  }

  private async buildMergePreview(
    defs: FieldDefinition[],
    winner: Contact,
    loser: Contact,
    db: NexusDb,
    orgId: string,
  ): Promise<MergePreview> {
    const standard = ContactsService.MERGEABLE_STANDARD_FIELDS.map((field) => ({
      field,
      winner: winner[field as keyof Contact],
      loser: loser[field as keyof Contact],
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
    const merged = [...new Set([...winner.tags, ...loser.tags])].slice(0, 20);
    const notes = await db
      .select({ id: contactNotes.id })
      .from(contactNotes)
      .where(and(eq(contactNotes.contactId, loser.id), eq(contactNotes.orgId, orgId)));
    return {
      winnerId: winner.id,
      loserId: loser.id,
      fields,
      tags: { winner: winner.tags, loser: loser.tags, merged },
      notesMoved: notes.length,
    };
  }

  private recordScope(auth: AuthContext): 'all' | 'own' {
    return auth.role.permissions?.recordAccess?.['contact'] ?? 'own';
  }

  /** Shared with notes/timeline modules: throws 404 for missing/deleted/foreign contacts. */
  async requireLiveContact(
    db: NexusDb,
    orgId: string,
    id: string,
  ): Promise<{
    contact: Contact;
    account: { id: string; name: string } | null;
    owner: { id: string; name: string } | null;
  }> {
    const row = await this.findLive(db, orgId, id);
    if (!row) {
      throw new NotFoundException({ message: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
    }
    return row;
  }

  /** Shared with notes/timeline modules. */
  assertContactReadable(auth: AuthContext, ownerId: string | null): void {
    try {
      checkRecordAccess(auth.role.permissions, 'contact', ownerId ?? '', auth.user.id);
    } catch {
      recordForbidden();
    }
  }

  private assertReadable(auth: AuthContext, ownerId: string | null): void {
    this.assertContactReadable(auth, ownerId);
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

  private async findLive(db: NexusDb, orgId: string, id: string): Promise<JoinedContact | null> {
    const [row] = await db
      .select({ contact: contacts, account: accounts, owner: users })
      .from(contacts)
      .leftJoin(accounts, eq(contacts.accountId, accounts.id))
      .leftJoin(users, eq(contacts.ownerId, users.id))
      .where(and(eq(contacts.id, id), eq(contacts.orgId, orgId), isNull(contacts.deletedAt)));
    if (!row) return null;
    return {
      contact: row.contact,
      account: row.account ? { id: row.account.id, name: row.account.name } : null,
      owner: row.owner ? { id: row.owner.id, name: row.owner.name } : null,
    };
  }

  private async serialize(
    db: NexusDb,
    auth: AuthContext,
    defs: FieldDefinition[],
    contact: Contact,
  ): Promise<SerializedContact> {
    const [account] = contact.accountId
      ? await db
          .select({ id: accounts.id, name: accounts.name })
          .from(accounts)
          .where(eq(accounts.id, contact.accountId))
      : [undefined];
    const [owner] = contact.ownerId
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, contact.ownerId))
      : [undefined];
    return this.serializeJoined(auth, defs, contact, account ?? null, owner ?? null);
  }

  private serializeJoined(
    auth: AuthContext,
    defs: FieldDefinition[],
    contact: Contact,
    account: { id: string; name: string } | null,
    owner: { id: string; name: string } | null,
  ): SerializedContact {
    const { computed, errors } = computeFormulas(
      defs,
      (contact.customFields ?? {}) as Record<string, unknown>,
    );
    const record: Record<string, unknown> = {
      id: contact.id,
      accountId: contact.accountId,
      account,
      ownerId: contact.ownerId,
      owner,
      name: contact.name,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      title: contact.title,
      lifecycleStage: contact.lifecycleStage,
      tags: contact.tags,
      customFields: this.filterCustom(contact.customFields, auth),
      computedFields: this.filterCustom(computed, auth),
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    };
    const visible = filterReadableFields(auth.role.permissions, 'contact', record);
    if (Object.keys(errors).length > 0) {
      (visible as Record<string, unknown>)['formulaErrors'] = errors;
    }
    return visible as SerializedContact;
  }

  /** Applies per-field rules inside the custom/computed maps (none → stripped). */
  private filterCustom(
    values: Record<string, unknown> | null | undefined,
    auth: AuthContext,
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (fieldRule(auth.role.permissions, 'contact', key) === 'none') continue;
      output[key] = value;
    }
    return output;
  }
}
