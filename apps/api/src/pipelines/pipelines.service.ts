import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  dealStageHistory,
  deals,
  exchangeRates,
  pipelineStages,
  pipelines,
  type Pipeline,
  type PipelineStage,
} from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import { assertCurrencyCode, assertPositiveRates, RATE_DATE_PATTERN } from './currency';

export const DEFAULT_PIPELINE_SLUG = 'sales';

export interface DefaultStageSeed {
  key: string;
  name: string;
  position: number;
  probability: number;
  isClosedWon: boolean;
  isClosedLost: boolean;
}

export const DEFAULT_PIPELINE_STAGES: DefaultStageSeed[] = [
  {
    key: 'discovery',
    name: 'Discovery',
    position: 1,
    probability: 10,
    isClosedWon: false,
    isClosedLost: false,
  },
  {
    key: 'proposal',
    name: 'Proposal',
    position: 2,
    probability: 50,
    isClosedWon: false,
    isClosedLost: false,
  },
  {
    key: 'negotiation',
    name: 'Negotiation',
    position: 3,
    probability: 75,
    isClosedWon: false,
    isClosedLost: false,
  },
  {
    key: 'closed-won',
    name: 'Closed Won',
    position: 4,
    probability: 100,
    isClosedWon: true,
    isClosedLost: false,
  },
  {
    key: 'closed-lost',
    name: 'Closed Lost',
    position: 5,
    probability: 0,
    isClosedWon: false,
    isClosedLost: true,
  },
];

export interface PipelineWithStages {
  pipeline: Pipeline;
  stages: PipelineStage[];
}

function toBadRequest(err: unknown): never {
  throw new BadRequestException({
    message: err instanceof Error ? err.message : 'Invalid currency input',
    code: (err as { code?: string }).code ?? 'CURRENCY_INVALID',
  });
}

@Injectable()
export class PipelinesService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async ensureDefaultPipeline(
    orgId: string,
    actor?: { id: string; email: string },
  ): Promise<PipelineWithStages> {
    return this.tenantDb.tx(orgId, async (db) => {
      const existing = await this.findBySlug(db, orgId, DEFAULT_PIPELINE_SLUG);
      if (existing) return existing;
      const [pipeline] = await db
        .insert(pipelines)
        .values({
          orgId,
          name: 'Sales Pipeline',
          slug: DEFAULT_PIPELINE_SLUG,
          description: 'Default sales pipeline',
          isDefault: true,
        })
        .returning();
      if (!pipeline) throw new Error('Failed to seed default pipeline');
      const stages = await db
        .insert(pipelineStages)
        .values(
          DEFAULT_PIPELINE_STAGES.map((stage) => ({
            orgId,
            pipelineId: pipeline.id,
            ...stage,
          })),
        )
        .returning();
      await this.audit.record(db, {
        orgId,
        actorUserId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        action: 'pipeline.created',
        entityType: 'pipeline',
        entityId: pipeline.id,
        newValues: { name: pipeline.name, slug: pipeline.slug, stages: stages.length },
      });
      return { pipeline, stages: stages.sort((a, b) => a.position - b.position) };
    });
  }

  async listPipelines(orgId: string): Promise<PipelineWithStages[]> {
    return this.tenantDb.tx(orgId, async (db) => {
      const rows = await db.select().from(pipelines).where(eq(pipelines.orgId, orgId));
      const output: PipelineWithStages[] = [];
      for (const pipeline of rows) {
        const stages = await db
          .select()
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, pipeline.id))
          .orderBy(asc(pipelineStages.position));
        output.push({ pipeline, stages });
      }
      return output;
    });
  }

  async createPipeline(
    orgId: string,
    input: { name: string; slug?: string; description?: string },
    actor?: { id: string; email: string },
  ): Promise<PipelineWithStages> {
    const slug = (input.slug ?? input.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (slug.length < 2) {
      throw new BadRequestException({
        message: 'Pipeline slug must be at least 2 characters',
        code: 'PIPELINE_SLUG_INVALID',
      });
    }
    return this.tenantDb.tx(orgId, async (db) => {
      const [existing] = await db
        .select({ id: pipelines.id })
        .from(pipelines)
        .where(and(eq(pipelines.orgId, orgId), eq(pipelines.slug, slug)));
      if (existing) {
        throw new ConflictException({
          message: 'A pipeline with this slug already exists',
          code: 'PIPELINE_SLUG_TAKEN',
        });
      }
      const [pipeline] = await db
        .insert(pipelines)
        .values({
          orgId,
          name: input.name,
          slug,
          description: input.description ?? null,
          isDefault: false,
        })
        .returning();
      if (!pipeline) throw new Error('Failed to create pipeline');
      await this.audit.record(db, {
        orgId,
        actorUserId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        action: 'pipeline.created',
        entityType: 'pipeline',
        entityId: pipeline.id,
        newValues: { name: pipeline.name, slug: pipeline.slug },
      });
      return { pipeline, stages: [] };
    });
  }

  async updatePipeline(
    orgId: string,
    id: string,
    patch: { name?: string; description?: string | null },
    actor?: { id: string; email: string },
  ): Promise<PipelineWithStages> {
    return this.tenantDb.tx(orgId, async (db) => {
      const pipeline = await this.requirePipeline(db, orgId, id);
      const [updated] = await db
        .update(pipelines)
        .set({
          name: patch.name ?? pipeline.name,
          description: patch.description !== undefined ? patch.description : pipeline.description,
          updatedAt: new Date(),
        })
        .where(eq(pipelines.id, pipeline.id))
        .returning();
      if (!updated) throw new Error('Failed to update pipeline');
      await this.audit.record(db, {
        orgId,
        actorUserId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        action: 'pipeline.updated',
        entityType: 'pipeline',
        entityId: updated.id,
        oldValues: { name: pipeline.name },
        newValues: { name: updated.name },
      });
      const stages = await this.stagesFor(db, updated.id);
      return { pipeline: updated, stages };
    });
  }

  async deletePipeline(
    orgId: string,
    id: string,
    actor?: { id: string; email: string },
  ): Promise<{ ok: true }> {
    return this.tenantDb.tx(orgId, async (db) => {
      const pipeline = await this.requirePipeline(db, orgId, id);
      if (pipeline.isDefault) {
        throw new ConflictException({
          message: 'The default pipeline cannot be deleted',
          code: 'PIPELINE_DEFAULT_IMMUTABLE',
        });
      }
      const [blocking] = await db
        .select({ id: deals.id })
        .from(deals)
        .where(
          and(eq(deals.orgId, orgId), eq(deals.pipelineId, pipeline.id), isNull(deals.deletedAt)),
        )
        .limit(1);
      if (blocking) {
        throw new ConflictException({
          message: 'Pipeline has live deals — move or delete them first',
          code: 'PIPELINE_HAS_DEALS',
        });
      }
      await db.delete(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id));
      await db.delete(pipelines).where(eq(pipelines.id, pipeline.id));
      await this.audit.record(db, {
        orgId,
        actorUserId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        action: 'pipeline.deleted',
        entityType: 'pipeline',
        entityId: pipeline.id,
        oldValues: { name: pipeline.name, slug: pipeline.slug },
      });
      return { ok: true as const };
    });
  }

  async createStage(
    orgId: string,
    pipelineId: string,
    input: {
      key: string;
      name: string;
      position?: number;
      probability: number;
      isClosedWon?: boolean;
      isClosedLost?: boolean;
    },
    actor?: { id: string; email: string },
  ): Promise<PipelineStage> {
    this.assertStageShape(input);
    return this.tenantDb.tx(orgId, async (db) => {
      const pipeline = await this.requirePipeline(db, orgId, pipelineId);
      const existing = await this.stagesFor(db, pipeline.id);
      if (existing.some((s) => s.key === input.key)) {
        throw new ConflictException({
          message: 'A stage with this key already exists in the pipeline',
          code: 'STAGE_KEY_TAKEN',
        });
      }
      const position =
        input.position === undefined
          ? existing.length + 1
          : Math.min(Math.max(Math.floor(input.position), 1), existing.length + 1);
      await db
        .update(pipelineStages)
        .set({ position: sql`${pipelineStages.position} + 1`, updatedAt: new Date() })
        .where(
          and(
            eq(pipelineStages.pipelineId, pipeline.id),
            sql`${pipelineStages.position} >= ${position}`,
          ),
        );
      const [created] = await db
        .insert(pipelineStages)
        .values({
          orgId,
          pipelineId: pipeline.id,
          key: input.key,
          name: input.name,
          position,
          probability: input.probability,
          isClosedWon: input.isClosedWon ?? false,
          isClosedLost: input.isClosedLost ?? false,
        })
        .returning();
      if (!created) throw new Error('Failed to create stage');
      await this.audit.record(db, {
        orgId,
        actorUserId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        action: 'pipeline.stage_created',
        entityType: 'pipeline',
        entityId: pipeline.id,
        newValues: { key: created.key, name: created.name, probability: created.probability },
      });
      return created;
    });
  }

  async updateStage(
    orgId: string,
    pipelineId: string,
    stageId: string,
    patch: {
      name?: string;
      position?: number;
      probability?: number;
      isClosedWon?: boolean;
      isClosedLost?: boolean;
    },
    actor?: { id: string; email: string },
  ): Promise<PipelineStage> {
    return this.tenantDb.tx(orgId, async (db) => {
      const pipeline = await this.requirePipeline(db, orgId, pipelineId);
      const stages = await this.stagesFor(db, pipeline.id);
      const stage = stages.find((s) => s.id === stageId);
      if (!stage) {
        throw new NotFoundException({ message: 'Stage not found', code: 'STAGE_NOT_FOUND' });
      }
      const next = {
        name: patch.name ?? stage.name,
        probability: patch.probability ?? stage.probability,
        isClosedWon: patch.isClosedWon ?? stage.isClosedWon,
        isClosedLost: patch.isClosedLost ?? stage.isClosedLost,
      };
      this.assertStageShape({
        key: stage.key,
        name: next.name,
        probability: next.probability,
        isClosedWon: next.isClosedWon,
        isClosedLost: next.isClosedLost,
      });
      if (patch.position !== undefined && patch.position !== stage.position) {
        const ordered = stages
          .filter((s) => s.id !== stage.id)
          .sort((a, b) => a.position - b.position);
        const position = Math.min(Math.max(Math.floor(patch.position), 1), ordered.length + 1);
        ordered.splice(position - 1, 0, stage);
        // Two-phase write: direct rewrites can collide on the unique
        // (pipelineId, position) constraint mid-loop.
        for (const [index, row] of ordered.entries()) {
          await db
            .update(pipelineStages)
            .set({ position: -(index + 1), updatedAt: new Date() })
            .where(eq(pipelineStages.id, row.id));
        }
        for (const [index, row] of ordered.entries()) {
          await db
            .update(pipelineStages)
            .set({ position: index + 1, updatedAt: new Date() })
            .where(eq(pipelineStages.id, row.id));
        }
      }
      const [updated] = await db
        .update(pipelineStages)
        .set({
          name: next.name,
          probability: next.probability,
          isClosedWon: next.isClosedWon,
          isClosedLost: next.isClosedLost,
          updatedAt: new Date(),
        })
        .where(eq(pipelineStages.id, stage.id))
        .returning();
      if (!updated) throw new Error('Failed to update stage');
      await this.audit.record(db, {
        orgId,
        actorUserId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        action: 'pipeline.stage_updated',
        entityType: 'pipeline',
        entityId: pipeline.id,
        oldValues: {
          name: stage.name,
          probability: stage.probability,
          isClosedWon: stage.isClosedWon,
          isClosedLost: stage.isClosedLost,
        },
        newValues: {
          name: updated.name,
          probability: updated.probability,
          isClosedWon: updated.isClosedWon,
          isClosedLost: updated.isClosedLost,
        },
      });
      return updated;
    });
  }

  /**
   * Deletes a stage, migrating its live deals to an explicit target stage.
   * Deals are never orphaned: without migrateToStageId the call fails if any
   * live deal sits in the removed stage.
   */
  async deleteStage(
    orgId: string,
    pipelineId: string,
    stageId: string,
    migrateToStageId: string | undefined,
    actor?: { id: string; email: string },
  ): Promise<{ ok: true; dealsMigrated: number }> {
    return this.tenantDb.tx(orgId, async (db) => {
      const pipeline = await this.requirePipeline(db, orgId, pipelineId);
      const stages = await this.stagesFor(db, pipeline.id);
      const stage = stages.find((s) => s.id === stageId);
      if (!stage) {
        throw new NotFoundException({ message: 'Stage not found', code: 'STAGE_NOT_FOUND' });
      }
      if (stages.length <= 1) {
        throw new ConflictException({
          message: 'A pipeline must keep at least one stage',
          code: 'STAGE_LAST_REMAINING',
        });
      }
      const live = await db
        .select({ id: deals.id })
        .from(deals)
        .where(and(eq(deals.orgId, orgId), eq(deals.stageId, stage.id), isNull(deals.deletedAt)));
      let target: PipelineStage | null = null;
      if (live.length > 0) {
        if (!migrateToStageId) {
          throw new ConflictException({
            message: 'Stage has live deals — provide migrateToStageId',
            code: 'STAGE_HAS_DEALS',
          });
        }
        target = stages.find((s) => s.id === migrateToStageId) ?? null;
        if (!target || target.id === stage.id) {
          throw new NotFoundException({
            message: 'Migration target stage not found in this pipeline',
            code: 'STAGE_TARGET_NOT_FOUND',
          });
        }
        const now = new Date();
        for (const deal of live) {
          const openRows = await db
            .select({ id: dealStageHistory.id, enteredAt: dealStageHistory.enteredAt })
            .from(dealStageHistory)
            .where(
              and(
                eq(dealStageHistory.dealId, deal.id),
                eq(dealStageHistory.orgId, orgId),
                isNull(dealStageHistory.exitedAt),
              ),
            );
          for (const open of openRows) {
            await db
              .update(dealStageHistory)
              .set({
                exitedAt: now,
                durationSeconds: Math.max(
                  0,
                  Math.floor((now.getTime() - open.enteredAt.getTime()) / 1000),
                ),
              })
              .where(eq(dealStageHistory.id, open.id));
          }
          await db.insert(dealStageHistory).values({
            orgId,
            dealId: deal.id,
            fromStageId: stage.id,
            toStageId: target.id,
            fromStageName: stage.name,
            toStageName: target.name,
            actorUserId: actor?.id ?? null,
          });
          await db
            .update(deals)
            .set({
              stageId: target.id,
              status: target.isClosedWon ? 'won' : target.isClosedLost ? 'lost' : 'open',
              closedAt: target.isClosedWon || target.isClosedLost ? now : null,
              updatedAt: now,
            })
            .where(eq(deals.id, deal.id));
        }
      }
      await db.delete(pipelineStages).where(eq(pipelineStages.id, stage.id));
      const remaining = (await this.stagesFor(db, pipeline.id)).sort(
        (a, b) => a.position - b.position,
      );
      for (const [index, row] of remaining.entries()) {
        if (row.position !== index + 1) {
          await db
            .update(pipelineStages)
            .set({ position: index + 1, updatedAt: new Date() })
            .where(eq(pipelineStages.id, row.id));
        }
      }
      await this.audit.record(db, {
        orgId,
        actorUserId: actor?.id ?? null,
        actorEmail: actor?.email ?? null,
        action: 'pipeline.stage_deleted',
        entityType: 'pipeline',
        entityId: pipeline.id,
        oldValues: { key: stage.key, name: stage.name },
        newValues: target
          ? { migrateToStageId: target.id, dealsMigrated: live.length }
          : { dealsMigrated: 0 },
      });
      return { ok: true as const, dealsMigrated: live.length };
    });
  }

  private assertStageShape(input: {
    key?: string;
    name: string;
    probability: number;
    isClosedWon?: boolean;
    isClosedLost?: boolean;
  }): void {
    if (input.key !== undefined && !/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/.test(input.key)) {
      throw new BadRequestException({
        message: 'Stage key must be lowercase alphanumeric with dashes',
        code: 'STAGE_KEY_INVALID',
      });
    }
    if (!input.name.trim()) {
      throw new BadRequestException({
        message: 'Stage name is required',
        code: 'STAGE_NAME_INVALID',
      });
    }
    if (!Number.isInteger(input.probability) || input.probability < 0 || input.probability > 100) {
      throw new BadRequestException({
        message: 'Stage probability must be an integer 0-100',
        code: 'STAGE_PROBABILITY_INVALID',
      });
    }
    if (input.isClosedWon && input.isClosedLost) {
      throw new BadRequestException({
        message: 'A stage cannot be both Closed Won and Closed Lost',
        code: 'STAGE_CLOSED_CONFLICT',
      });
    }
  }

  private async requirePipeline(db: NexusDb, orgId: string, id: string) {
    const [pipeline] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, id), eq(pipelines.orgId, orgId)));
    if (!pipeline) {
      throw new NotFoundException({ message: 'Pipeline not found', code: 'PIPELINE_NOT_FOUND' });
    }
    return pipeline;
  }

  private async stagesFor(db: NexusDb, pipelineId: string): Promise<PipelineStage[]> {
    return db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
      .orderBy(asc(pipelineStages.position));
  }

  async upsertExchangeRates(
    orgId: string,
    input: { rateDate: string; baseCurrency: string; rates: Record<string, unknown> },
  ): Promise<{ rateDate: string; baseCurrency: string; rates: Record<string, number> }> {
    let baseCurrency: string;
    let rates: Record<string, number>;
    try {
      baseCurrency = assertCurrencyCode(input.baseCurrency, 'baseCurrency');
      rates = assertPositiveRates(input.rates);
      if (
        !RATE_DATE_PATTERN.test(input.rateDate) ||
        Number.isNaN(Date.parse(`${input.rateDate}T00:00:00Z`))
      ) {
        const err = new Error('rateDate must be an ISO date (YYYY-MM-DD)');
        (err as Error & { code?: string }).code = 'RATE_DATE_INVALID';
        throw err;
      }
    } catch (err) {
      toBadRequest(err);
    }
    const [row] = await this.tenantDb.tx(orgId, (db) =>
      db
        .insert(exchangeRates)
        .values({ orgId, rateDate: input.rateDate, baseCurrency: baseCurrency!, rates: rates! })
        .onConflictDoUpdate({
          target: [exchangeRates.orgId, exchangeRates.rateDate, exchangeRates.baseCurrency],
          set: { rates: rates! },
        })
        .returning({
          rateDate: exchangeRates.rateDate,
          baseCurrency: exchangeRates.baseCurrency,
          rates: exchangeRates.rates,
        }),
    );
    if (!row) throw new Error('Failed to save exchange rates');
    return row;
  }

  async getExchangeRate(
    orgId: string,
    input: { currency: string; baseCurrency: string; rateDate: string },
  ): Promise<{ rate: number; rateDate: string; baseCurrency: string }> {
    let currency: string;
    let baseCurrency: string;
    try {
      currency = assertCurrencyCode(input.currency);
      baseCurrency = assertCurrencyCode(input.baseCurrency, 'baseCurrency');
    } catch (err) {
      toBadRequest(err);
    }
    if (currency! === baseCurrency!) {
      return { rate: 1, rateDate: input.rateDate, baseCurrency: baseCurrency! };
    }
    const [snapshot] = await this.tenantDb.tx(orgId, (db) =>
      db
        .select()
        .from(exchangeRates)
        .where(
          and(
            eq(exchangeRates.orgId, orgId),
            eq(exchangeRates.rateDate, input.rateDate),
            eq(exchangeRates.baseCurrency, baseCurrency!),
          ),
        ),
    );
    if (!snapshot) {
      throw new NotFoundException({
        message: `No exchange-rate snapshot for ${baseCurrency!} on ${input.rateDate}`,
        code: 'RATE_SNAPSHOT_MISSING',
      });
    }
    const rate = (snapshot.rates as Record<string, number>)[currency!];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new NotFoundException({
        message: `Missing exchange rate for ${currency!} on ${input.rateDate}`,
        code: 'RATE_MISSING',
      });
    }
    return { rate, rateDate: snapshot.rateDate, baseCurrency: snapshot.baseCurrency };
  }

  private async findBySlug(
    db: NexusDb,
    orgId: string,
    slug: string,
  ): Promise<PipelineWithStages | null> {
    const [pipeline] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.orgId, orgId), eq(pipelines.slug, slug)));
    if (!pipeline) return null;
    const stages = await db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipeline.id))
      .orderBy(asc(pipelineStages.position));
    return { pipeline, stages };
  }
}
