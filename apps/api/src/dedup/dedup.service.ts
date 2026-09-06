import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { accounts, contacts, duplicateCandidates, organizations } from '@nexus/db';
import { IdentityDb, TenantDb, type NexusDb } from '../database/tenant-db.service';
import { QueueService } from '../queue/queue.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { checkRecordAccess, hasScope } from '../rbac/permissions';

export const DEDUP_SCAN_QUEUE = 'dedup-nightly-scan';

export type MatchConfidence = 'exact' | 'high' | 'medium';

export interface RecordMatch {
  id: string;
  confidence: MatchConfidence;
  signals: Record<string, unknown>;
}

export interface ScanStats {
  orgs: number;
  candidates: number;
}

const CONFIDENCE_RANK: Record<MatchConfidence, number> = { exact: 3, high: 2, medium: 1 };
const NAME_SIMILARITY_THRESHOLD = 0.5;
const SCAN_PAIR_LIMIT = 5000;

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 ? digits : null;
}

export function emailDomain(email: string): string | null {
  const parts = email.trim().toLowerCase().split('@');
  return parts.length === 2 && parts[1] ? parts[1]! : null;
}

/**
 * Pure merge-choice validation shared by contact and account merges.
 * Every conflicting field needs an explicit winner|loser choice; unknown
 * fields are rejected; choices for agreeing fields are ignored.
 */
export function assertValidMergeChoices(
  eligible: string[],
  conflicts: string[],
  choices: Record<string, unknown>,
): void {
  for (const field of Object.keys(choices)) {
    if (!eligible.includes(field)) {
      throw new Error(`Unknown merge field: ${field}`);
    }
    if (choices[field] !== 'winner' && choices[field] !== 'loser') {
      throw new Error(`Choice for ${field} must be winner or loser`);
    }
  }
  const missing = conflicts.filter((f) => choices[f] !== 'winner' && choices[f] !== 'loser');
  if (missing.length > 0) {
    throw new Error(`Missing choice for conflicting fields: ${missing.join(', ')}`);
  }
}

export function mergeConflicts(
  fields: Array<{ field: string; winner: unknown; loser: unknown }>,
): string[] {
  return fields
    .filter((f) => JSON.stringify(f.winner ?? null) !== JSON.stringify(f.loser ?? null))
    .map((f) => f.field);
}

export interface CandidateRecord {
  id: string;
  name: string;
  email: string | null;
  ownerId: string | null;
}

export interface SerializedCandidate {
  id: string;
  entityType: 'contact' | 'account';
  confidence: MatchConfidence;
  signals: Record<string, unknown>;
  status: string;
  createdAt: Date;
  records: [CandidateRecord, CandidateRecord];
}

function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

interface PairRow {
  a: string;
  b: string;
  sim?: string | number;
}

async function rawPairs(db: NexusDb, query: SQL): Promise<PairRow[]> {
  const result = (await db.execute(query)) as unknown as { rows: PairRow[] };
  return result.rows;
}

function normalizeWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  const cleaned = website
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
  return cleaned.length > 0 ? cleaned : null;
}

@Injectable()
export class DedupService {
  private readonly logger = new Logger(DedupService.name);

  constructor(
    @Inject(IdentityDb) private readonly identityDb: IdentityDb,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(QueueService) private readonly queues: QueueService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.queues.registerWorker(DEDUP_SCAN_QUEUE, () => this.runNightlyScan());
    this.queues.registerSchedule(DEDUP_SCAN_QUEUE, '0 2 * * *');
  }

  /**
   * All matches for a candidate contact, highest confidence first. Pure reads;
   * callers decide whether to warn, persist candidates, or both.
   */
  async findContactMatches(
    db: NexusDb,
    orgId: string,
    candidate: { id?: string; name: string; email: string; phone?: string | null },
    excludeId?: string,
  ): Promise<RecordMatch[]> {
    const byId = new Map<string, RecordMatch>();
    const consider = (
      id: string,
      confidence: MatchConfidence,
      signals: Record<string, unknown>,
    ): void => {
      if (excludeId && id === excludeId) return;
      if (candidate.id && id === candidate.id) return;
      const prev = byId.get(id);
      if (!prev || CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[prev.confidence]) {
        byId.set(id, { id, confidence, signals });
      }
    };

    const emailLower = candidate.email.trim().toLowerCase();
    const exactRows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, orgId),
          sql`lower(${contacts.email}) = ${emailLower}`,
          sql`${contacts.deletedAt} IS NULL`,
        ),
      );
    for (const row of exactRows) {
      consider(row.id, 'exact', { emailMatch: true });
    }

    const phone = normalizePhone(candidate.phone);
    if (phone) {
      const phoneRows = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, orgId),
            sql`regexp_replace(${contacts.phone}, '\\D', '', 'g') = ${phone}`,
            sql`${contacts.deletedAt} IS NULL`,
          ),
        );
      for (const row of phoneRows) {
        consider(row.id, 'high', { phoneMatch: true });
      }
    }

    const domain = emailDomain(candidate.email);
    if (domain && candidate.name.trim().length >= 3) {
      const fuzzyRows = await db
        .select({
          id: contacts.id,
          similarity: sql<number>`similarity(lower(${contacts.name}), ${candidate.name.trim().toLowerCase()})`,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, orgId),
            sql`split_part(lower(${contacts.email}), '@', 2) = ${domain}`,
            sql`similarity(lower(${contacts.name}), ${candidate.name.trim().toLowerCase()}) >= ${NAME_SIMILARITY_THRESHOLD}`,
            sql`${contacts.deletedAt} IS NULL`,
          ),
        )
        .limit(50);
      for (const row of fuzzyRows) {
        consider(row.id, 'medium', { sameDomain: domain, nameSimilarity: Number(row.similarity) });
      }
    }

    return [...byId.values()].sort(
      (a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence],
    );
  }

  async findAccountMatches(
    db: NexusDb,
    orgId: string,
    candidate: {
      id?: string;
      name: string;
      website?: string | null;
      phone?: string | null;
      domains?: string[];
    },
    excludeId?: string,
  ): Promise<RecordMatch[]> {
    const byId = new Map<string, RecordMatch>();
    const consider = (
      id: string,
      confidence: MatchConfidence,
      signals: Record<string, unknown>,
    ): void => {
      if (excludeId && id === excludeId) return;
      if (candidate.id && id === candidate.id) return;
      const prev = byId.get(id);
      if (!prev || CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[prev.confidence]) {
        byId.set(id, { id, confidence, signals });
      }
    };

    const website = normalizeWebsite(candidate.website);
    if (website) {
      const rows = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.orgId, orgId),
            sql`lower(regexp_replace(${accounts.website}, '^https?://(www\\.)?|/+$', '', 'g')) = ${website}`,
            sql`${accounts.deletedAt} IS NULL`,
          ),
        );
      for (const row of rows) {
        consider(row.id, 'exact', { websiteMatch: true });
      }
    }

    const phone = normalizePhone(candidate.phone);
    if (phone) {
      const rows = await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.orgId, orgId),
            sql`regexp_replace(${accounts.phone}, '\\D', '', 'g') = ${phone}`,
            sql`${accounts.deletedAt} IS NULL`,
          ),
        );
      for (const row of rows) {
        consider(row.id, 'high', { phoneMatch: true });
      }
    }

    const domains = [...new Set([...(candidate.domains ?? []), ...(website ? [website] : [])])];
    if (domains.length > 0 && candidate.name.trim().length >= 3) {
      const domainList = sql.join(
        domains.map((d) => sql`${d}`),
        sql`, `,
      );
      const rows = await db
        .select({
          id: accounts.id,
          similarity: sql<number>`similarity(lower(${accounts.name}), ${candidate.name.trim().toLowerCase()})`,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.orgId, orgId),
            sql`${accounts.domains} && ARRAY[${domainList}]`,
            sql`similarity(lower(${accounts.name}), ${candidate.name.trim().toLowerCase()}) >= ${NAME_SIMILARITY_THRESHOLD}`,
            sql`${accounts.deletedAt} IS NULL`,
          ),
        )
        .limit(50);
      for (const row of rows) {
        consider(row.id, 'medium', {
          sharedDomains: domains,
          nameSimilarity: Number(row.similarity),
        });
      }
    }

    return [...byId.values()].sort(
      (a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence],
    );
  }

  /** Persists matches as pending candidates (ordered pairs, duplicates ignored). */
  async recordCandidates(
    db: NexusDb,
    orgId: string,
    entityType: 'contact' | 'account',
    sourceId: string,
    matches: RecordMatch[],
  ): Promise<number> {
    let added = 0;
    for (const match of matches) {
      const [a, b] = orderPair(sourceId, match.id);
      if (a === b) continue;
      const inserted = await db
        .insert(duplicateCandidates)
        .values({
          orgId,
          entityType,
          recordAId: a,
          recordBId: b,
          confidence: match.confidence,
          signals: match.signals,
          status: 'pending',
        })
        .onConflictDoNothing({
          target: [
            duplicateCandidates.orgId,
            duplicateCandidates.entityType,
            duplicateCandidates.recordAId,
            duplicateCandidates.recordBId,
          ],
        })
        .returning({ id: duplicateCandidates.id });
      added += inserted.length;
    }
    return added;
  }

  async markMerged(
    db: NexusDb,
    orgId: string,
    entityType: 'contact' | 'account',
    a: string,
    b: string,
  ): Promise<void> {
    const [first, second] = orderPair(a, b);
    await db
      .update(duplicateCandidates)
      .set({ status: 'merged', resolvedAt: new Date() })
      .where(
        and(
          eq(duplicateCandidates.orgId, orgId),
          eq(duplicateCandidates.entityType, entityType),
          eq(duplicateCandidates.recordAId, first),
          eq(duplicateCandidates.recordBId, second),
          eq(duplicateCandidates.status, 'pending'),
        ),
      );
  }

  /**
   * Nightly scan across orgs. Blocking keeps it sub-quadratic: exact matches
   * by email/website/phone via grouped indexes, fuzzy only within shared
   * domains, capped pairs per org. Previously dismissed pairs stay dismissed.
   */
  async runNightlyScan(): Promise<ScanStats> {
    const orgs = await this.identityDb.db.select({ id: organizations.id }).from(organizations);
    let candidates = 0;
    for (const org of orgs) {
      try {
        candidates += await this.tenantDb.tx(org.id, (db) => this.scanOrg(db, org.id));
      } catch (err) {
        this.logger.error(`Dedup scan failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
    return { orgs: orgs.length, candidates };
  }

  private async scanOrg(db: NexusDb, orgId: string): Promise<number> {
    const dismissed = await db
      .select({
        entityType: duplicateCandidates.entityType,
        a: duplicateCandidates.recordAId,
        b: duplicateCandidates.recordBId,
      })
      .from(duplicateCandidates)
      .where(
        and(
          eq(duplicateCandidates.orgId, orgId),
          sql`${duplicateCandidates.status} IN ('dismissed', 'merged')`,
        ),
      );
    const dead = new Set(dismissed.map((d) => `${d.entityType}:${d.a}:${d.b}`));
    let added = 0;

    added += await this.scanContactExact(db, orgId, dead);
    added += await this.scanContactPhones(db, orgId, dead);
    added += await this.scanContactFuzzy(db, orgId, dead);
    added += await this.scanAccountPairs(db, orgId, dead);
    return added;
  }

  private pairKey(entity: string, a: string, b: string): string {
    const [first, second] = orderPair(a, b);
    return `${entity}:${first}:${second}`;
  }

  private async insertCandidate(
    db: NexusDb,
    orgId: string,
    entityType: 'contact' | 'account',
    a: string,
    b: string,
    confidence: MatchConfidence,
    signals: Record<string, unknown>,
    dead: Set<string>,
  ): Promise<boolean> {
    if (a === b || dead.has(this.pairKey(entityType, a, b))) return false;
    const [first, second] = orderPair(a, b);
    const inserted = await db
      .insert(duplicateCandidates)
      .values({
        orgId,
        entityType,
        recordAId: first,
        recordBId: second,
        confidence,
        signals,
        status: 'pending',
      })
      .onConflictDoNothing({
        target: [
          duplicateCandidates.orgId,
          duplicateCandidates.entityType,
          duplicateCandidates.recordAId,
          duplicateCandidates.recordBId,
        ],
      })
      .returning({ id: duplicateCandidates.id });
    return inserted.length > 0;
  }

  private async scanContactExact(db: NexusDb, orgId: string, dead: Set<string>): Promise<number> {
    const dupes = await rawPairs(
      db,
      sql`
      SELECT a.id AS a, b.id AS b FROM contacts a JOIN contacts b
        ON a.org_id = ${orgId} AND b.org_id = ${orgId}
        AND a.id < b.id
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND lower(a.email) = lower(b.email)
      LIMIT ${SCAN_PAIR_LIMIT}`,
    );
    let added = 0;
    for (const row of dupes) {
      if (
        await this.insertCandidate(
          db,
          orgId,
          'contact',
          row.a,
          row.b,
          'exact',
          { emailMatch: true },
          dead,
        )
      ) {
        added += 1;
      }
    }
    return added;
  }

  private async scanContactPhones(db: NexusDb, orgId: string, dead: Set<string>): Promise<number> {
    const dupes = await rawPairs(
      db,
      sql`
      SELECT a.id AS a, b.id AS b FROM contacts a JOIN contacts b
        ON a.org_id = ${orgId} AND b.org_id = ${orgId}
        AND a.id < b.id
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND a.phone IS NOT NULL AND b.phone IS NOT NULL
        AND regexp_replace(a.phone, '\\D', '', 'g') = regexp_replace(b.phone, '\\D', '', 'g')
        AND length(regexp_replace(a.phone, '\\D', '', 'g')) >= 7
      LIMIT ${SCAN_PAIR_LIMIT}`,
    );
    let added = 0;
    for (const row of dupes) {
      if (
        await this.insertCandidate(
          db,
          orgId,
          'contact',
          row.a,
          row.b,
          'high',
          { phoneMatch: true },
          dead,
        )
      ) {
        added += 1;
      }
    }
    return added;
  }

  private async scanContactFuzzy(db: NexusDb, orgId: string, dead: Set<string>): Promise<number> {
    const dupes = await rawPairs(
      db,
      sql`
      SELECT a.id AS a, b.id AS b,
        similarity(lower(a.name), lower(b.name)) AS sim
      FROM contacts a JOIN contacts b
        ON a.org_id = ${orgId} AND b.org_id = ${orgId}
        AND a.id < b.id
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND split_part(lower(a.email), '@', 2) = split_part(lower(b.email), '@', 2)
        AND length(a.name) >= 3 AND length(b.name) >= 3
        AND similarity(lower(a.name), lower(b.name)) >= ${NAME_SIMILARITY_THRESHOLD}
      LIMIT ${SCAN_PAIR_LIMIT}`,
    );
    let added = 0;
    for (const row of dupes) {
      if (
        await this.insertCandidate(
          db,
          orgId,
          'contact',
          row.a,
          row.b,
          'medium',
          { nameSimilarity: Number(row.sim) },
          dead,
        )
      ) {
        added += 1;
      }
    }
    return added;
  }

  private async scanAccountPairs(db: NexusDb, orgId: string, dead: Set<string>): Promise<number> {
    let added = 0;
    const websites = await rawPairs(
      db,
      sql`
      SELECT a.id AS a, b.id AS b FROM accounts a JOIN accounts b
        ON a.org_id = ${orgId} AND b.org_id = ${orgId}
        AND a.id < b.id
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND a.website IS NOT NULL AND b.website IS NOT NULL
        AND lower(regexp_replace(a.website, '^https?://(www\\.)?|/+$', '', 'g'))
          = lower(regexp_replace(b.website, '^https?://(www\\.)?|/+$', '', 'g'))
      LIMIT ${SCAN_PAIR_LIMIT}`,
    );
    for (const row of websites) {
      if (
        await this.insertCandidate(
          db,
          orgId,
          'account',
          row.a,
          row.b,
          'exact',
          { websiteMatch: true },
          dead,
        )
      ) {
        added += 1;
      }
    }
    const phones = await rawPairs(
      db,
      sql`
      SELECT a.id AS a, b.id AS b FROM accounts a JOIN accounts b
        ON a.org_id = ${orgId} AND b.org_id = ${orgId}
        AND a.id < b.id
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND a.phone IS NOT NULL AND b.phone IS NOT NULL
        AND regexp_replace(a.phone, '\\D', '', 'g') = regexp_replace(b.phone, '\\D', '', 'g')
        AND length(regexp_replace(a.phone, '\\D', '', 'g')) >= 7
      LIMIT ${SCAN_PAIR_LIMIT}`,
    );
    for (const row of phones) {
      if (
        await this.insertCandidate(
          db,
          orgId,
          'account',
          row.a,
          row.b,
          'high',
          { phoneMatch: true },
          dead,
        )
      ) {
        added += 1;
      }
    }
    const fuzzy = await rawPairs(
      db,
      sql`
      SELECT a.id AS a, b.id AS b,
        similarity(lower(a.name), lower(b.name)) AS sim
      FROM accounts a JOIN accounts b
        ON a.org_id = ${orgId} AND b.org_id = ${orgId}
        AND a.id < b.id
        AND a.deleted_at IS NULL AND b.deleted_at IS NULL
        AND a.domains && b.domains
        AND length(a.name) >= 3 AND length(b.name) >= 3
        AND similarity(lower(a.name), lower(b.name)) >= ${NAME_SIMILARITY_THRESHOLD}
      LIMIT ${SCAN_PAIR_LIMIT}`,
    );
    for (const row of fuzzy) {
      if (
        await this.insertCandidate(
          db,
          orgId,
          'account',
          row.a,
          row.b,
          'medium',
          { nameSimilarity: Number(row.sim) },
          dead,
        )
      ) {
        added += 1;
      }
    }
    return added;
  }

  /**
   * Review queue. Only pairs where the viewer can read BOTH records are
   * shown — reviewing a pair you could not merge would leak the other side.
   * Pairs pointing at deleted records are auto-dismissed.
   */
  async listCandidates(
    auth: AuthContext,
    filter: {
      entityType?: 'contact' | 'account';
      confidence?: MatchConfidence;
      status?: 'pending' | 'dismissed' | 'merged';
    },
  ): Promise<SerializedCandidate[]> {
    const types: Array<'contact' | 'account'> = filter.entityType
      ? [filter.entityType]
      : ['contact', 'account'];
    const visible = types.filter((t) =>
      hasScope(auth.role.permissions, t === 'contact' ? 'contacts:manage' : 'accounts:manage'),
    );
    if (visible.length === 0) {
      throw new ForbiddenException({
        message: 'Missing required scope: contacts:manage',
        code: 'SCOPE_FORBIDDEN',
      });
    }
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const conditions = [
        eq(duplicateCandidates.orgId, auth.org.id),
        eq(duplicateCandidates.status, filter.status ?? 'pending'),
        sql`${duplicateCandidates.entityType} IN (${sql.join(
          visible.map((t) => sql`${t}`),
          sql`, `,
        )})`,
      ];
      if (filter.confidence) conditions.push(eq(duplicateCandidates.confidence, filter.confidence));
      const rows = await db
        .select()
        .from(duplicateCandidates)
        .where(and(...conditions))
        .orderBy(desc(duplicateCandidates.createdAt))
        .limit(200);

      const output: SerializedCandidate[] = [];
      for (const row of rows) {
        const records =
          row.entityType === 'contact'
            ? await this.loadContactPair(db, auth.org.id, row.recordAId, row.recordBId)
            : await this.loadAccountPair(db, auth.org.id, row.recordAId, row.recordBId);
        if (!records) {
          await db
            .update(duplicateCandidates)
            .set({ status: 'dismissed', resolvedAt: new Date() })
            .where(eq(duplicateCandidates.id, row.id));
          continue;
        }
        if (!this.canRead(auth, row.entityType, records[0].ownerId)) continue;
        if (!this.canRead(auth, row.entityType, records[1].ownerId)) continue;
        output.push({
          id: row.id,
          entityType: row.entityType,
          confidence: row.confidence,
          signals: (row.signals ?? {}) as Record<string, unknown>,
          status: row.status,
          createdAt: row.createdAt,
          records,
        });
      }
      output.sort(
        (a, b) =>
          CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
      return output;
    });
  }

  async dismissCandidate(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [row] = await db
        .select()
        .from(duplicateCandidates)
        .where(and(eq(duplicateCandidates.id, id), eq(duplicateCandidates.orgId, auth.org.id)));
      if (!row || row.status !== 'pending') {
        throw new NotFoundException({
          message: 'Duplicate candidate not found',
          code: 'DUPLICATE_NOT_FOUND',
        });
      }
      if (
        !hasScope(
          auth.role.permissions,
          row.entityType === 'contact' ? 'contacts:manage' : 'accounts:manage',
        )
      ) {
        throw new ForbiddenException({
          message: 'Missing required scope for this record type',
          code: 'SCOPE_FORBIDDEN',
        });
      }
      const records =
        row.entityType === 'contact'
          ? await this.loadContactPair(db, auth.org.id, row.recordAId, row.recordBId)
          : await this.loadAccountPair(db, auth.org.id, row.recordAId, row.recordBId);
      if (!records) {
        throw new NotFoundException({
          message: 'Duplicate candidate not found',
          code: 'DUPLICATE_NOT_FOUND',
        });
      }
      if (!this.canRead(auth, row.entityType, records[0].ownerId)) {
        throw new ForbiddenException({ message: 'Not allowed', code: 'RECORD_FORBIDDEN' });
      }
      if (!this.canRead(auth, row.entityType, records[1].ownerId)) {
        throw new ForbiddenException({ message: 'Not allowed', code: 'RECORD_FORBIDDEN' });
      }
      await db
        .update(duplicateCandidates)
        .set({ status: 'dismissed', resolvedAt: new Date() })
        .where(eq(duplicateCandidates.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'duplicate.dismissed',
        entityType: 'duplicate_candidate',
        entityId: row.id,
      });
      return { ok: true as const };
    });
  }

  private canRead(
    auth: AuthContext,
    entity: 'contact' | 'account',
    ownerId: string | null,
  ): boolean {
    try {
      checkRecordAccess(auth.role.permissions, entity, ownerId ?? '', auth.user.id);
      return true;
    } catch {
      return false;
    }
  }

  private async loadContactPair(
    db: NexusDb,
    orgId: string,
    a: string,
    b: string,
  ): Promise<[CandidateRecord, CandidateRecord] | null> {
    const rows = await db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.orgId, orgId),
          sql`${contacts.id} IN (${a}, ${b})`,
          sql`${contacts.deletedAt} IS NULL`,
        ),
      );
    if (rows.length !== 2) return null;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const first = byId.get(a);
    const second = byId.get(b);
    if (!first || !second) return null;
    return [
      { id: first.id, name: first.name, email: first.email, ownerId: first.ownerId },
      { id: second.id, name: second.name, email: second.email, ownerId: second.ownerId },
    ];
  }

  private async loadAccountPair(
    db: NexusDb,
    orgId: string,
    a: string,
    b: string,
  ): Promise<[CandidateRecord, CandidateRecord] | null> {
    const rows = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.orgId, orgId),
          sql`${accounts.id} IN (${a}, ${b})`,
          sql`${accounts.deletedAt} IS NULL`,
        ),
      );
    if (rows.length !== 2) return null;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const first = byId.get(a);
    const second = byId.get(b);
    if (!first || !second) return null;
    return [
      { id: first.id, name: first.name, email: first.website, ownerId: first.ownerId },
      { id: second.id, name: second.name, email: second.website, ownerId: second.ownerId },
    ];
  }
}
