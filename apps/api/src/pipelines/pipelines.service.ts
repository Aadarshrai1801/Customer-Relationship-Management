import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import {
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
