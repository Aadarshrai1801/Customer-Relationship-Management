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
  ): Promise<{ data: unknown; meta: { cached: boolean; generatedAt: string } }> {
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
              const base = toNumber(row.deal.baseAmount);
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
    );
  }

  async pipeline(
    auth: AuthContext,
    query: PipelineReportQuery,
  ): Promise<{ data: unknown; meta: { cached: boolean; generatedAt: string } }> {
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
              bucket.baseAmount = round2(bucket.baseAmount + toNumber(row.baseAmount));
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
  ): Promise<{ data: unknown; meta: { cached: boolean; generatedAt: string } }> {
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
          const wonBase = won.reduce((sum, d) => sum + toNumber(d.baseAmount), 0);
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
    );
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
  ): Promise<{ data: T; meta: { cached: boolean; generatedAt: string } }> {
    // The refresh flag bypasses the cache but must not fragment it.
    const { refresh: _refresh, ...keyParams } = (parts[1] ?? {}) as Record<string, unknown>;
    void _refresh;
    const key = `${auth.org.id}|${parts[0]}|${JSON.stringify(keyParams)}|${auth.user.id}`;
    if (!bypass) {
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < REPORT_CACHE_TTL_MS) {
        return {
          data: hit.body as T,
          meta: { cached: true, generatedAt: new Date(hit.at).toISOString() },
        };
      }
    }
    const data = await compute();
    this.cache.set(key, { at: Date.now(), body: data });
    return { data, meta: { cached: false, generatedAt: new Date().toISOString() } };
  }
}
