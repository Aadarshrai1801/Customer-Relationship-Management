import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, isNull, lt } from 'drizzle-orm';
import {
  activities,
  contactNotes,
  contacts,
  deals,
  leads,
  organizations,
  pipelines,
  pipelineStages,
  users,
} from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { fieldRule } from '../rbac/permissions';
import { resolveBaseCurrency } from '../pipelines/currency';
import type {
  ActivityReportQuery,
  ConversionReportQuery,
  ForecastReportQuery,
  PipelineReportQuery,
} from './reports.schemas';

/**
 * Cache TTL for report responses (PRD 4.8: real-time on view, cached for
 * 5 minutes under high load). Single-instance in-memory cache keyed by
 * org + report + params + visibility; `refresh=true` bypasses it.
 * Stated limitation: multi-instance deployments need a shared store.
 */
const REPORT_CACHE_TTL_MS = 5 * 60 * 1000;

function toNumber(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toCsv(rows: string[][]): string {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => {
            const text = cell ?? '';
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          })
          .join(','),
      )
      .join('\n') + '\n'
  );
}

interface ForecastOwnerRow {
  owner: { id: string; name: string };
  dealCount: number;
  totalBaseAmount: number;
  weightedValue: number;
  commitBaseAmount: number;
  bestCaseBaseAmount: number;
  pipelineBaseAmount: number;
}

interface ForecastData {
  baseCurrency: string;
  totals: {
    dealCount: number;
    totalBaseAmount: number;
    weightedValue: number;
    commitBaseAmount: number;
    bestCaseBaseAmount: number;
    pipelineBaseAmount: number;
  };
  byOwner: ForecastOwnerRow[];
  pipelines: unknown[];
}

interface PipelineData {
  baseCurrency: string;
  pipelines: Array<{
    pipeline: { id: string; name: string; slug: string };
    stages: Array<{
      stage: { id: string; key: string; name: string; position: number };
      open: { count: number; baseAmount: number };
      won: { count: number; baseAmount: number };
      lost: { count: number; baseAmount: number };
    }>;
  }>;
}

interface ActivityData {
  from: string | null;
  to: string | null;
  total: number;
  byType: Array<{ type: string; count: number }>;
  byOwner: Array<{ owner: { id: string; name: string }; count: number }>;
}

interface ConversionData {
  from: string | null;
  to: string | null;
  leads: {
    total: number;
    byStatus: Array<{ status: string; count: number }>;
    convertedRate: number;
  };
  deals: { open: number; won: number; lost: number; winRate: number; avgWonBaseAmount: number };
}

function rangeBounds(query: { from?: string; to?: string }): {
  from: Date | null;
  to: Date | null;
} {
  let from: Date | null = null;
  let to: Date | null = null;
  if (query.from) from = new Date(`${query.from}T00:00:00.000Z`);
  if (query.to) {
    const end = new Date(`${query.to}T00:00:00.000Z`);
    to = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  if (from && to && from.getTime() > to.getTime()) {
    throw new BadRequestException({
      message: 'from must not be after to',
      code: 'INVALID_DATE_RANGE',
    });
  }
  return { from, to };
}

@Injectable()
export class ReportsService {
  private readonly cache = new Map<string, { at: number; body: unknown }>();

  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  async forecast(
    auth: AuthContext,
    query: ForecastReportQuery,
  ): Promise<{
    data: unknown;
    meta: { cached: boolean; generatedAt: string; amountsRedacted?: boolean };
  }> {
    const showAmounts = this.dealAmountsVisible(auth);
    return this.cached(
      auth,
      ['forecast', query],
      async () => {
        return this.tenantDb.tx(auth.org.id, async (db) => {
          const baseCurrency = await this.orgBaseCurrency(db, auth.org.id);
          const dealScopeAll = this.scopeAll(auth, 'deal');
          let ownerFilter: string | null = null;
          if (!dealScopeAll) {
            if (query.ownerId && query.ownerId !== auth.user.id) {
              return this.emptyForecast(baseCurrency);
            }
            ownerFilter = auth.user.id;
          } else if (query.ownerId) {
            ownerFilter = query.ownerId;
          }

          const pipes = await db
            .select()
            .from(pipelines)
            .where(
              and(
                eq(pipelines.orgId, auth.org.id),
                ...(query.pipelineId ? [eq(pipelines.id, query.pipelineId)] : []),
              ),
            )
            .orderBy(pipelines.name);
          if (query.pipelineId && pipes.length === 0) {
            throw new NotFoundException({
              message: 'Pipeline not found',
              code: 'PIPELINE_NOT_FOUND',
            });
          }

          const byOwner = new Map<
            string,
            {
              owner: { id: string; name: string };
              dealCount: number;
              totalBaseAmount: number;
              weightedValue: number;
              commitBaseAmount: number;
              bestCaseBaseAmount: number;
              pipelineBaseAmount: number;
            }
          >();
          const pipelineBlocks = [];
          const totals = {
            dealCount: 0,
            totalBaseAmount: 0,
            weightedValue: 0,
            commitBaseAmount: 0,
            bestCaseBaseAmount: 0,
            pipelineBaseAmount: 0,
          };

          for (const pipe of pipes) {
            const stages = await db
              .select()
              .from(pipelineStages)
              .where(eq(pipelineStages.pipelineId, pipe.id))
              .orderBy(pipelineStages.position);
            const probByStage = new Map(stages.map((s) => [s.id, s.probability]));
            const rows = await db
              .select({ deal: deals, owner: users })
              .from(deals)
              .leftJoin(users, eq(deals.ownerId, users.id))
              .where(
                and(
                  eq(deals.orgId, auth.org.id),
                  eq(deals.pipelineId, pipe.id),
                  eq(deals.status, 'open'),
                  isNull(deals.deletedAt),
                  ...(ownerFilter ? [eq(deals.ownerId, ownerFilter)] : []),
                ),
              );
            const stageRollup = stages.map((s) => ({
              stage: {
                id: s.id,
                key: s.key,
                name: s.name,
                position: s.position,
                probability: s.probability,
              },
              dealCount: 0,
              totalBaseAmount: 0,
              weightedValue: 0,
            }));
            const stageById = new Map(stageRollup.map((r) => [r.stage.id, r]));
            for (const row of rows) {
              // Field-level redaction (PRD 4.12): without amount visibility
              // every money input is zero, so counts survive but values don't.
              const base = showAmounts ? toNumber(row.deal.baseAmount) : 0;
              const prob = row.deal.probability ?? probByStage.get(row.deal.stageId) ?? 0;
              const weighted = round2((base * prob) / 100);
              const category = row.deal.forecastCategory;
              const stageEntry = stageById.get(row.deal.stageId);
              if (stageEntry) {
                stageEntry.dealCount += 1;
                stageEntry.totalBaseAmount = round2(stageEntry.totalBaseAmount + base);
                stageEntry.weightedValue = round2(stageEntry.weightedValue + weighted);
              }
              const ownerKey = row.deal.ownerId ?? 'unassigned';
              const bucket = byOwner.get(ownerKey) ?? {
                owner: row.owner
                  ? { id: row.owner.id, name: row.owner.name }
                  : { id: 'unassigned', name: 'Unassigned' },
                dealCount: 0,
                totalBaseAmount: 0,
                weightedValue: 0,
                commitBaseAmount: 0,
                bestCaseBaseAmount: 0,
                pipelineBaseAmount: 0,
              };
              bucket.dealCount += 1;
              bucket.totalBaseAmount = round2(bucket.totalBaseAmount + base);
              bucket.weightedValue = round2(bucket.weightedValue + weighted);
              bucket.pipelineBaseAmount = round2(bucket.pipelineBaseAmount + base);
              if (category === 'commit' || category === 'best_case') {
                bucket.bestCaseBaseAmount = round2(bucket.bestCaseBaseAmount + base);
              }
              if (category === 'commit') {
                bucket.commitBaseAmount = round2(bucket.commitBaseAmount + base);
              }
              byOwner.set(ownerKey, bucket);
              totals.dealCount += 1;
              totals.totalBaseAmount = round2(totals.totalBaseAmount + base);
              totals.weightedValue = round2(totals.weightedValue + weighted);
              totals.pipelineBaseAmount = round2(totals.pipelineBaseAmount + base);
              if (category === 'commit' || category === 'best_case') {
                totals.bestCaseBaseAmount = round2(totals.bestCaseBaseAmount + base);
              }
              if (category === 'commit') {
                totals.commitBaseAmount = round2(totals.commitBaseAmount + base);
              }
            }
            pipelineBlocks.push({
              pipeline: { id: pipe.id, name: pipe.name, slug: pipe.slug },
              stages: stageRollup,
            });
          }
          return {
            baseCurrency,
            totals,
            byOwner: [...byOwner.values()].sort((a, b) => b.totalBaseAmount - a.totalBaseAmount),
            pipelines: pipelineBlocks,
          };
        });
      },
      query.refresh === true,
      { amountsRedacted: !showAmounts },
    );
  }

  async pipeline(
    auth: AuthContext,
    query: PipelineReportQuery,
  ): Promise<{
    data: unknown;
    meta: { cached: boolean; generatedAt: string; amountsRedacted?: boolean };
  }> {
    const showAmounts = this.dealAmountsVisible(auth);
    return this.cached(
      auth,
      ['pipeline', query],
      async () => {
        return this.tenantDb.tx(auth.org.id, async (db) => {
          const baseCurrency = await this.orgBaseCurrency(db, auth.org.id);
          const dealScopeAll = this.scopeAll(auth, 'deal');
          const pipes = await db
            .select()
            .from(pipelines)
            .where(
              and(
                eq(pipelines.orgId, auth.org.id),
                ...(query.pipelineId ? [eq(pipelines.id, query.pipelineId)] : []),
              ),
            )
            .orderBy(pipelines.name);
          if (query.pipelineId && pipes.length === 0) {
            throw new NotFoundException({
              message: 'Pipeline not found',
              code: 'PIPELINE_NOT_FOUND',
            });
          }
          const blocks = [];
          for (const pipe of pipes) {
            const stages = await db
              .select()
              .from(pipelineStages)
              .where(eq(pipelineStages.pipelineId, pipe.id))
              .orderBy(pipelineStages.position);
            const rows = await db
              .select({
                id: deals.id,
                stageId: deals.stageId,
                status: deals.status,
                baseAmount: deals.baseAmount,
                ownerId: deals.ownerId,
              })
              .from(deals)
              .where(
                and(
                  eq(deals.orgId, auth.org.id),
                  eq(deals.pipelineId, pipe.id),
                  isNull(deals.deletedAt),
                  ...(dealScopeAll ? [] : [eq(deals.ownerId, auth.user.id)]),
                ),
              );
            const stageRollup = stages.map((s) => ({
              stage: { id: s.id, key: s.key, name: s.name, position: s.position },
              open: { count: 0, baseAmount: 0 },
              won: { count: 0, baseAmount: 0 },
              lost: { count: 0, baseAmount: 0 },
            }));
            const byId = new Map(stageRollup.map((r) => [r.stage.id, r]));
            for (const row of rows) {
              const entry = byId.get(row.stageId);
              if (!entry) continue;
              const bucket = entry[row.status as 'open' | 'won' | 'lost'];
              if (!bucket) continue;
              bucket.count += 1;
              bucket.baseAmount = round2(
                bucket.baseAmount + (showAmounts ? toNumber(row.baseAmount) : 0),
              );
            }
            blocks.push({
              pipeline: { id: pipe.id, name: pipe.name, slug: pipe.slug },
              stages: stageRollup,
            });
          }
          return { baseCurrency, pipelines: blocks };
        });
      },
      query.refresh === true,
      { amountsRedacted: !showAmounts },
    );
  }

  async activity(
    auth: AuthContext,
    query: ActivityReportQuery,
  ): Promise<{ data: unknown; meta: { cached: boolean; generatedAt: string } }> {
    return this.cached(
      auth,
      ['activity', query],
      async () => {
        return this.tenantDb.tx(auth.org.id, async (db) => {
          const { from, to } = rangeBounds(query);
          const activityScopeAll = this.scopeAll(auth, 'activity');
          let ownerFilter: string | null = null;
          if (!activityScopeAll) {
            if (query.ownerId && query.ownerId !== auth.user.id) {
              return {
                from: query.from ?? null,
                to: query.to ?? null,
                total: 0,
                byType: [],
                byOwner: [],
              };
            }
            ownerFilter = auth.user.id;
          } else if (query.ownerId) {
            ownerFilter = query.ownerId;
          }
          const rows = await db
            .select({
              type: activities.type,
              ownerId: activities.ownerId,
              ownerName: users.name,
            })
            .from(activities)
            .leftJoin(users, eq(activities.ownerId, users.id))
            .where(
              and(
                eq(activities.orgId, auth.org.id),
                ...(from ? [gte(activities.occurredAt, from)] : []),
                ...(to ? [lt(activities.occurredAt, to)] : []),
                ...(ownerFilter ? [eq(activities.ownerId, ownerFilter)] : []),
              ),
            );
          const noteRows = await db
            .select({ authorId: contactNotes.authorId })
            .from(contactNotes)
            .innerJoin(contacts, eq(contactNotes.contactId, contacts.id))
            .where(
              and(
                eq(contactNotes.orgId, auth.org.id),
                ...(from ? [gte(contactNotes.createdAt, from)] : []),
                ...(to ? [lt(contactNotes.createdAt, to)] : []),
                ...(ownerFilter ? [eq(contactNotes.authorId, ownerFilter)] : []),
              ),
            );
          const byType = new Map<string, number>();
          const byOwner = new Map<string, { owner: { id: string; name: string }; count: number }>();
          const owners = new Map<string, string>();
          for (const row of rows) {
            byType.set(row.type, (byType.get(row.type) ?? 0) + 1);
            if (row.ownerId) owners.set(row.ownerId, row.ownerName ?? 'Unknown');
          }
          byType.set('note', (byType.get('note') ?? 0) + noteRows.length);
          const activityByOwner = new Map<string, number>();
          for (const row of rows) {
            if (!row.ownerId) continue;
            activityByOwner.set(row.ownerId, (activityByOwner.get(row.ownerId) ?? 0) + 1);
          }
          for (const note of noteRows) {
            if (!note.authorId) continue;
            activityByOwner.set(note.authorId, (activityByOwner.get(note.authorId) ?? 0) + 1);
            if (!owners.has(note.authorId)) owners.set(note.authorId, 'Unknown');
          }
          for (const [ownerId, count] of activityByOwner) {
            byOwner.set(ownerId, {
              owner: { id: ownerId, name: owners.get(ownerId) ?? 'Unknown' },
              count,
            });
          }
          return {
            from: query.from ?? null,
            to: query.to ?? null,
            total: rows.length + noteRows.length,
            byType: [...byType.entries()]
              .map(([type, count]) => ({ type, count }))
              .sort((a, b) => b.count - a.count),
            byOwner: [...byOwner.values()].sort((a, b) => b.count - a.count),
          };
        });
      },
      query.refresh === true,
    );
  }

  async conversion(
    auth: AuthContext,
    query: ConversionReportQuery,
  ): Promise<{
    data: unknown;
    meta: { cached: boolean; generatedAt: string; amountsRedacted?: boolean };
  }> {
    const showAmounts = this.dealAmountsVisible(auth);
    return this.cached(
      auth,
      ['conversion', query],
      async () => {
        return this.tenantDb.tx(auth.org.id, async (db) => {
          const { from, to } = rangeBounds(query);
          const leadScopeAll = this.scopeAll(auth, 'lead');
          const dealScopeAll = this.scopeAll(auth, 'deal');
          const leadRows = await db
            .select({ status: leads.status })
            .from(leads)
            .where(
              and(
                eq(leads.orgId, auth.org.id),
                ...(from ? [gte(leads.createdAt, from)] : []),
                ...(to ? [lt(leads.createdAt, to)] : []),
                ...(leadScopeAll ? [] : [eq(leads.ownerId, auth.user.id)]),
              ),
            );
          const byStatus = new Map<string, number>();
          for (const row of leadRows) {
            byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
          }
          const leadTotal = leadRows.length;
          const converted = byStatus.get('converted') ?? 0;
          const dealRows = await db
            .select({ status: deals.status, baseAmount: deals.baseAmount })
            .from(deals)
            .where(
              and(
                eq(deals.orgId, auth.org.id),
                isNull(deals.deletedAt),
                ...(from ? [gte(deals.createdAt, from)] : []),
                ...(to ? [lt(deals.createdAt, to)] : []),
                ...(dealScopeAll ? [] : [eq(deals.ownerId, auth.user.id)]),
              ),
            );
          const won = dealRows.filter((d) => d.status === 'won');
          const lost = dealRows.filter((d) => d.status === 'lost');
          const open = dealRows.filter((d) => d.status === 'open');
          const wonBase = showAmounts ? won.reduce((sum, d) => sum + toNumber(d.baseAmount), 0) : 0;
          return {
            from: query.from ?? null,
            to: query.to ?? null,
            leads: {
              total: leadTotal,
              byStatus: [...byStatus.entries()]
                .map(([status, count]) => ({ status, count }))
                .sort((a, b) => b.count - a.count),
              convertedRate: leadTotal === 0 ? 0 : round2((converted / leadTotal) * 100),
            },
            deals: {
              open: open.length,
              won: won.length,
              lost: lost.length,
              winRate:
                won.length + lost.length === 0
                  ? 0
                  : round2((won.length / (won.length + lost.length)) * 100),
              avgWonBaseAmount: won.length === 0 ? 0 : round2(wonBase / won.length),
            },
          };
        });
      },
      query.refresh === true,
      { amountsRedacted: !showAmounts },
    );
  }

  /**
   * CSV export (PRD 4.8 P1: printable data interchange; chart-preserving
   * PDF stays deferred — no rendering engine is vendored). Reuses the
   * same scoped computations as the JSON reports, so field redaction and
   * record scoping apply identically.
   */
  async exportCsv(
    auth: AuthContext,
    name: 'forecast' | 'pipeline' | 'activity' | 'conversion',
  ): Promise<{ filename: string; csv: string }> {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    if (name === 'forecast') {
      const { data } = await this.forecast(auth, {});
      const d = data as ForecastData;
      const rows = [
        ['owner', 'deals', 'pipeline_amount', 'best_case_amount', 'commit_amount', 'weighted'],
        ...d.byOwner.map((r) => [
          r.owner.name,
          String(r.dealCount),
          String(r.pipelineBaseAmount),
          String(r.bestCaseBaseAmount),
          String(r.commitBaseAmount),
          String(r.weightedValue),
        ]),
        [
          'TOTAL',
          String(d.totals.dealCount),
          String(d.totals.pipelineBaseAmount),
          String(d.totals.bestCaseBaseAmount),
          String(d.totals.commitBaseAmount),
          String(d.totals.weightedValue),
        ],
      ];
      return { filename: `forecast-${stamp}.csv`, csv: toCsv(rows) };
    }
    if (name === 'pipeline') {
      const { data } = await this.pipeline(auth, {});
      const d = data as PipelineData;
      const rows = [
        [
          'pipeline',
          'stage',
          'open_count',
          'open_amount',
          'won_count',
          'won_amount',
          'lost_count',
          'lost_amount',
        ],
      ];
      for (const p of d.pipelines) {
        for (const s of p.stages) {
          rows.push([
            p.pipeline.name,
            s.stage.name,
            String(s.open.count),
            String(s.open.baseAmount),
            String(s.won.count),
            String(s.won.baseAmount),
            String(s.lost.count),
            String(s.lost.baseAmount),
          ]);
        }
      }
      return { filename: `pipeline-${stamp}.csv`, csv: toCsv(rows) };
    }
    if (name === 'activity') {
      const { data } = await this.activity(auth, {});
      const d = data as ActivityData;
      const rows = [['group', 'name', 'count']];
      for (const t of d.byType) rows.push(['type', t.type, String(t.count)]);
      for (const o of d.byOwner) rows.push(['owner', o.owner.name, String(o.count)]);
      return { filename: `activity-${stamp}.csv`, csv: toCsv(rows) };
    }
    const { data } = await this.conversion(auth, {});
    const d = data as ConversionData;
    const rows = [
      ['metric', 'value'],
      ['leads_total', String(d.leads.total)],
      ['leads_converted_rate', String(d.leads.convertedRate)],
      ...d.leads.byStatus.map((s): string[] => [`leads_${s.status}`, String(s.count)]),
      ['deals_open', String(d.deals.open)],
      ['deals_won', String(d.deals.won)],
      ['deals_lost', String(d.deals.lost)],
      ['deals_win_rate', String(d.deals.winRate)],
      ['deals_avg_won', String(d.deals.avgWonBaseAmount)],
    ];
    return { filename: `conversion-${stamp}.csv`, csv: toCsv(rows) };
  }

  private emptyForecast(baseCurrency: string): {
    baseCurrency: string;
    totals: Record<string, number>;
    byOwner: unknown[];
    pipelines: unknown[];
  } {
    return {
      baseCurrency,
      totals: {
        dealCount: 0,
        totalBaseAmount: 0,
        weightedValue: 0,
        commitBaseAmount: 0,
        bestCaseBaseAmount: 0,
        pipelineBaseAmount: 0,
      },
      byOwner: [],
      pipelines: [],
    };
  }

  private scopeAll(auth: AuthContext, entity: string): boolean {
    return (auth.role.permissions?.recordAccess?.[entity] ?? 'own') === 'all';
  }

  /**
   * PRD 4.12: field-level rules apply to the reporting layer too — a role
   * that may not read deal amounts gets counts but zeroed money (never a
   * back door around the record endpoints, which strip the same fields).
   */
  private dealAmountsVisible(auth: AuthContext): boolean {
    return (
      fieldRule(auth.role.permissions, 'deal', 'amount') !== 'none' &&
      fieldRule(auth.role.permissions, 'deal', 'baseAmount') !== 'none'
    );
  }

  private async orgBaseCurrency(db: NexusDb, orgId: string): Promise<string> {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return resolveBaseCurrency(org?.settings);
  }

  private async cached<T>(
    auth: AuthContext,
    parts: [string, unknown],
    compute: () => Promise<T>,
    bypass: boolean,
    extraMeta: Record<string, unknown> = {},
  ): Promise<{
    data: T;
    meta: { cached: boolean; generatedAt: string; amountsRedacted?: boolean };
  }> {
    // The refresh flag bypasses the cache but must not fragment it. The
    // caller's permissions join the key so a mid-window role change
    // cannot serve another visibility level's numbers.
    const { refresh: _refresh, ...keyParams } = (parts[1] ?? {}) as Record<string, unknown>;
    void _refresh;
    const key = `${auth.org.id}|${parts[0]}|${JSON.stringify(keyParams)}|${auth.user.id}|${JSON.stringify(auth.role.permissions)}`;
    if (!bypass) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < REPORT_CACHE_TTL_MS) {
        return {
          data: hit.body as T,
          meta: {
            cached: true,
            generatedAt: new Date(hit.at).toISOString(),
            ...extraMeta,
          },
        };
      }
    }
    const data = await compute();
    this.cache.set(key, { at: Date.now(), body: data });
    return { data, meta: { cached: false, generatedAt: new Date().toISOString(), ...extraMeta } };
  }
}
