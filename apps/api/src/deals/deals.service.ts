import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  accounts,
  contacts,
  deals,
  dealStageHistory,
  exchangeRates,
  organizations,
  pipelineStages,
  pipelines,
  users,
  type Deal,
  type PipelineStage,
} from '@nexus/db';
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
import { PipelinesService } from '../pipelines/pipelines.service';
import { convertToBaseCurrency, resolveBaseCurrency } from '../pipelines/currency';
import type { CreateDealInput, ListDealsQuery, UpdateDealInput } from './deals.schemas';

export interface SerializedDeal {
  id: string;
  pipeline: { id: string; name: string; slug: string };
  stage: {
    id: string;
    key: string;
    name: string;
    position: number;
    probability: number;
    isClosedWon: boolean;
    isClosedLost: boolean;
  };
  account: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string } | null;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  name: string;
  amount: number;
  currency: string;
  baseCurrency: string;
  baseAmount: number;
  exchangeRate: number;
  exchangeRateDate: string;
  probability: number | null;
  effectiveProbability: number;
  weightedValue: number;
  expectedCloseDate: Date | null;
  closeDateStatus: 'overdue' | 'due-soon' | 'on-track' | null;
  status: 'open' | 'won' | 'lost';
  lossReason: string | null;
  closedAt: Date | null;
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

function toNumber(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric value for ${field}`);
  return parsed;
}

/**
 * Close-date decay signal. Overdue = past expected close while still open;
 * due-soon = within the next 7 days. Thresholds are a stated assumption —
 * configurable decay rules belong to a later reporting pass.
 */
function closeDateStatus(
  status: 'open' | 'won' | 'lost',
  expectedCloseDate: Date | null,
): 'overdue' | 'due-soon' | 'on-track' | null {
  if (status !== 'open' || !expectedCloseDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  const close = expectedCloseDate.toISOString().slice(0, 10);
  if (close < today) return 'overdue';
  const inSevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (close <= inSevenDays) return 'due-soon';
  return 'on-track';
}

@Injectable()
export class DealsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CustomFieldsService) private readonly fields: CustomFieldsService,
    @Inject(PipelinesService) private readonly pipelines: PipelinesService,
  ) {}

  async create(auth: AuthContext, input: CreateDealInput): Promise<{ deal: SerializedDeal }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'deal');
      const { pipeline, stage } = await this.resolveStageForCreate(db, auth.org.id, input);
      const account = input.accountId
        ? await this.requireAccount(db, auth.org.id, input.accountId)
        : null;
      const contact = input.contactId
        ? await this.requireContact(db, auth.org.id, input.contactId)
        : null;
      const ownerId = await this.resolveOwnerForCreate(db, auth, input.ownerId);
      const { values: customFields, issues } = validateCustomFields(defs, input.customFields);
      if (issues.length > 0) {
        validationFailed(
          issues.map((i) => ({ path: `customFields.${i.key}`, message: `${i.key}: ${i.message}` })),
        );
      }

      const baseCurrency = await this.orgBaseCurrency(db, auth.org.id);
      const { rate, rateDate } = await this.rateFor(db, auth.org.id, input.currency, baseCurrency);
      const converted = convertToBaseCurrency({
        amount: input.amount,
        currency: input.currency,
        baseCurrency,
        rates: { [input.currency]: rate },
        rateDate,
      });

      const [created] = await db
        .insert(deals)
        .values({
          orgId: auth.org.id,
          pipelineId: pipeline.id,
          stageId: stage.id,
          accountId: account?.id ?? null,
          contactId: contact?.id ?? null,
          ownerId,
          name: input.name,
          amount: String(input.amount),
          currency: input.currency,
          baseCurrency: converted.baseCurrency,
          baseAmount: String(converted.baseAmount),
          exchangeRate: String(converted.exchangeRate),
          exchangeRateDate: converted.rateDate,
          probability: input.probability ?? null,
          expectedCloseDate: input.expectedCloseDate ? new Date(input.expectedCloseDate) : null,
          customFields,
        })
        .returning();
      if (!created) throw new Error('Failed to create deal');

      await db.insert(dealStageHistory).values({
        orgId: auth.org.id,
        dealId: created.id,
        fromStageId: null,
        toStageId: stage.id,
        fromStageName: null,
        toStageName: stage.name,
        actorUserId: auth.user.id,
      });

      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'deal.created',
        entityType: 'deal',
        entityId: created.id,
        newValues: {
          name: created.name,
          pipelineId: created.pipelineId,
          stageId: created.stageId,
          amount: created.amount,
          currency: created.currency,
          baseAmount: created.baseAmount,
          baseCurrency: created.baseCurrency,
          ownerId: created.ownerId,
        },
      });
      const [owner] = created.ownerId
        ? await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(eq(users.id, created.ownerId))
        : [undefined];
      return {
        deal: this.serialize(
          auth,
          defs,
          created,
          { id: pipeline.id, name: pipeline.name, slug: pipeline.slug },
          stage,
          account ? { id: account.id, name: account.name } : null,
          contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
          owner ?? null,
        ),
      };
    });
  }

  async list(
    auth: AuthContext,
    query: ListDealsQuery,
  ): Promise<{ deals: SerializedDeal[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'deal');
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [eq(deals.orgId, auth.org.id), isNull(deals.deletedAt)];
      const canSeeAll = this.recordScope(auth) === 'all';
      if (!canSeeAll) {
        conditions.push(eq(deals.ownerId, auth.user.id));
      }
      if (query.pipelineId) conditions.push(eq(deals.pipelineId, query.pipelineId));
      if (query.stageId) conditions.push(eq(deals.stageId, query.stageId));
      if (query.ownerId) {
        if (!canSeeAll && query.ownerId !== auth.user.id) {
          return { deals: [], nextCursor: null };
        }
        conditions.push(eq(deals.ownerId, query.ownerId));
      }
      if (query.accountId) conditions.push(eq(deals.accountId, query.accountId));
      if (query.contactId) conditions.push(eq(deals.contactId, query.contactId));
      if (query.status) conditions.push(eq(deals.status, query.status));
      if (query.q) {
        const pattern = `%${query.q.replace(/[%_\\]/g, '\\$&')}%`;
        conditions.push(sql`${deals.name} ILIKE ${pattern}`);
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
          sql`(${deals.createdAt}, ${deals.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({
          deal: deals,
          pipeline: pipelines,
          stage: pipelineStages,
          account: accounts,
          contact: contacts,
          owner: users,
        })
        .from(deals)
        .innerJoin(pipelines, eq(deals.pipelineId, pipelines.id))
        .innerJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
        .leftJoin(accounts, eq(deals.accountId, accounts.id))
        .leftJoin(contacts, eq(deals.contactId, contacts.id))
        .leftJoin(users, eq(deals.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(deals.createdAt), desc(deals.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const serialized = page.map((row) =>
        this.serializeJoined(
          auth,
          defs,
          row.deal,
          row.pipeline,
          row.stage,
          row.account,
          row.contact,
          row.owner,
        ),
      );
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last ? `${last.deal.createdAt.toISOString()}|${last.deal.id}` : null;
      return { deals: serialized, nextCursor };
    });
  }

  async getById(auth: AuthContext, id: string): Promise<SerializedDeal> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'deal');
      const row = await this.requireLiveDeal(db, auth.org.id, id);
      this.assertDealReadable(auth, row.deal.ownerId);
      return this.serializeJoined(
        auth,
        defs,
        row.deal,
        row.pipeline,
        row.stage,
        row.account,
        row.contact,
        row.owner,
      );
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    patch: UpdateDealInput,
  ): Promise<{ deal: SerializedDeal }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'deal');
      const row = await this.requireLiveDeal(db, auth.org.id, id);
      this.assertDealReadable(auth, row.deal.ownerId);

      let accountId = row.deal.accountId;
      if (patch.accountId !== undefined) {
        accountId = patch.accountId
          ? (await this.requireAccount(db, auth.org.id, patch.accountId)).id
          : null;
      }
      let contactId = row.deal.contactId;
      if (patch.contactId !== undefined) {
        contactId = patch.contactId
          ? (await this.requireContact(db, auth.org.id, patch.contactId)).id
          : null;
      }
      let ownerId = row.deal.ownerId;
      if (patch.ownerId !== undefined) {
        if (!hasScope(auth.role.permissions, 'users:manage')) {
          throw new ForbiddenException({
            message: 'Missing required scope: users:manage',
            code: 'SCOPE_FORBIDDEN',
          });
        }
        ownerId = patch.ownerId ? await this.requireMember(db, auth.org.id, patch.ownerId) : null;
      }

      let amount = toNumber(row.deal.amount, 'amount');
      let currency = row.deal.currency;
      let baseCurrency = row.deal.baseCurrency;
      let baseAmount = toNumber(row.deal.baseAmount, 'baseAmount');
      let exchangeRate = toNumber(row.deal.exchangeRate, 'exchangeRate');
      let exchangeRateDate = row.deal.exchangeRateDate;
      if (patch.amount !== undefined || patch.currency !== undefined) {
        amount = patch.amount ?? amount;
        currency = patch.currency ?? currency;
        baseCurrency = await this.orgBaseCurrency(db, auth.org.id);
        const snapshot = await this.rateFor(db, auth.org.id, currency, baseCurrency);
        const converted = convertToBaseCurrency({
          amount,
          currency,
          baseCurrency,
          rates: { [currency]: snapshot.rate },
          rateDate: snapshot.rateDate,
        });
        baseAmount = converted.baseAmount;
        exchangeRate = converted.exchangeRate;
        exchangeRateDate = converted.rateDate;
        baseCurrency = converted.baseCurrency;
      }

      let customFields = (row.deal.customFields ?? {}) as Record<string, unknown>;
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
        name: row.deal.name,
        accountId: row.deal.accountId,
        contactId: row.deal.contactId,
        ownerId: row.deal.ownerId,
        amount: row.deal.amount,
        currency: row.deal.currency,
        baseAmount: row.deal.baseAmount,
        probability: row.deal.probability,
        expectedCloseDate: row.deal.expectedCloseDate,
      };
      const [updated] = await db
        .update(deals)
        .set({
          accountId,
          contactId,
          ownerId,
          name: patch.name ?? row.deal.name,
          amount: String(amount),
          currency,
          baseCurrency,
          baseAmount: String(baseAmount),
          exchangeRate: String(exchangeRate),
          exchangeRateDate,
          probability: patch.probability !== undefined ? patch.probability : row.deal.probability,
          expectedCloseDate:
            patch.expectedCloseDate !== undefined
              ? patch.expectedCloseDate
                ? new Date(patch.expectedCloseDate)
                : null
              : row.deal.expectedCloseDate,
          customFields,
          updatedAt: new Date(),
        })
        .where(eq(deals.id, row.deal.id))
        .returning();
      if (!updated) throw new Error('Failed to update deal');

      const after = {
        name: updated.name,
        accountId: updated.accountId,
        contactId: updated.contactId,
        ownerId: updated.ownerId,
        amount: updated.amount,
        currency: updated.currency,
        baseAmount: updated.baseAmount,
        probability: updated.probability,
        expectedCloseDate: updated.expectedCloseDate,
      };
      const { oldValues, newValues } = diffObjects(before, {
        ...after,
        expectedCloseDate: after.expectedCloseDate?.toISOString() ?? null,
      });
      const customDiff = diffObjects(
        (row.deal.customFields ?? {}) as Record<string, unknown>,
        (updated.customFields ?? {}) as Record<string, unknown>,
      );
      if (Object.keys(newValues).length > 0 || Object.keys(customDiff.newValues).length > 0) {
        await this.audit.record(db, {
          orgId: auth.org.id,
          actorUserId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'deal.updated',
          entityType: 'deal',
          entityId: updated.id,
          oldValues: {
            ...oldValues,
            expectedCloseDate: before.expectedCloseDate?.toISOString() ?? null,
            customFields: customDiff.oldValues,
          },
          newValues: { ...newValues, customFields: customDiff.newValues },
        });
      }
      return { deal: await this.serializeById(db, auth, defs, updated.id) };
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveDeal(db, auth.org.id, id);
      this.assertDealReadable(auth, row.deal.ownerId);
      await db.update(deals).set({ deletedAt: new Date() }).where(eq(deals.id, row.deal.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'deal.deleted',
        entityType: 'deal',
        entityId: row.deal.id,
        oldValues: { name: row.deal.name, amount: row.deal.amount, currency: row.deal.currency },
      });
      return { ok: true as const };
    });
  }

  /**
   * Moves a deal between stages of its own pipeline. Closes the open history
   * row (recording duration), opens a new one, and derives status/closedAt
   * from the target stage flags. Loss-reason enforcement lands in M4-PR4;
   * a provided reason is stored as-is until then.
   */
  async transitionStage(
    auth: AuthContext,
    id: string,
    input: { stageId: string; lossReason?: string },
  ): Promise<{ deal: SerializedDeal; changed: boolean }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, 'deal');
      const row = await this.requireLiveDeal(db, auth.org.id, id);
      this.assertDealReadable(auth, row.deal.ownerId);

      const [target] = await db
        .select()
        .from(pipelineStages)
        .where(
          and(
            eq(pipelineStages.id, input.stageId),
            eq(pipelineStages.pipelineId, row.deal.pipelineId),
            eq(pipelineStages.orgId, auth.org.id),
          ),
        );
      if (!target) {
        throw new NotFoundException({
          message: 'Stage not found in this deal\u2019s pipeline',
          code: 'STAGE_NOT_FOUND',
        });
      }
      if (target.id === row.deal.stageId) {
        return {
          deal: await this.serializeById(db, auth, defs, row.deal.id),
          changed: false,
        };
      }

      const now = new Date();
      const openRows = await db
        .select({ id: dealStageHistory.id, enteredAt: dealStageHistory.enteredAt })
        .from(dealStageHistory)
        .where(
          and(
            eq(dealStageHistory.dealId, row.deal.id),
            eq(dealStageHistory.orgId, auth.org.id),
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
        orgId: auth.org.id,
        dealId: row.deal.id,
        fromStageId: row.stage.id,
        toStageId: target.id,
        fromStageName: row.stage.name,
        toStageName: target.name,
        actorUserId: auth.user.id,
      });

      const status = target.isClosedWon ? 'won' : target.isClosedLost ? 'lost' : 'open';
      const [updated] = await db
        .update(deals)
        .set({
          stageId: target.id,
          status,
          closedAt: status === 'open' ? null : now,
          lossReason: input.lossReason !== undefined ? input.lossReason : row.deal.lossReason,
          updatedAt: now,
        })
        .where(eq(deals.id, row.deal.id))
        .returning();
      if (!updated) throw new Error('Failed to transition deal');

      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'deal.stage_changed',
        entityType: 'deal',
        entityId: updated.id,
        oldValues: { stageId: row.stage.id, stageName: row.stage.name, status: row.deal.status },
        newValues: { stageId: target.id, stageName: target.name, status },
      });
      return { deal: await this.serializeById(db, auth, defs, updated.id), changed: true };
    });
  }

  async history(
    auth: AuthContext,
    id: string,
  ): Promise<Array<typeof dealStageHistory.$inferSelect>> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveDeal(db, auth.org.id, id);
      this.assertDealReadable(auth, row.deal.ownerId);
      return db
        .select()
        .from(dealStageHistory)
        .where(
          and(eq(dealStageHistory.dealId, row.deal.id), eq(dealStageHistory.orgId, auth.org.id)),
        )
        .orderBy(desc(dealStageHistory.enteredAt), desc(dealStageHistory.id));
    });
  }

  /**
   * Weighted forecast for one pipeline, summed in the org base currency.
   * Closed deals are excluded by default (status=open); pass status=all to
   * include them. Overdue = open with an expected close date before today.
   */
  async forecast(
    auth: AuthContext,
    pipelineId: string,
    filter: { ownerId?: string; status?: 'open' | 'won' | 'lost' | 'all' },
  ): Promise<{
    pipeline: { id: string; name: string; slug: string };
    baseCurrency: string;
    stages: Array<{
      stage: { id: string; key: string; name: string; position: number; probability: number };
      dealCount: number;
      totalBaseAmount: number;
      weightedValue: number;
      overdueCount: number;
      overdueBaseAmount: number;
    }>;
    totals: { dealCount: number; totalBaseAmount: number; weightedValue: number };
  }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [pipeline] = await db
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.orgId, auth.org.id)));
      if (!pipeline) {
        throw new NotFoundException({ message: 'Pipeline not found', code: 'PIPELINE_NOT_FOUND' });
      }
      const stages = await db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, pipeline.id))
        .orderBy(pipelineStages.position);
      const baseCurrency = await this.orgBaseCurrency(db, auth.org.id);
      const canSeeAll = this.recordScope(auth) === 'all';
      const status = filter.status ?? 'open';

      const conditions = [
        eq(deals.orgId, auth.org.id),
        eq(deals.pipelineId, pipeline.id),
        isNull(deals.deletedAt),
      ];
      if (status !== 'all') conditions.push(eq(deals.status, status));
      if (!canSeeAll) {
        if (filter.ownerId && filter.ownerId !== auth.user.id) {
          return this.emptyForecast(pipeline, stages, baseCurrency);
        }
        conditions.push(eq(deals.ownerId, auth.user.id));
      } else if (filter.ownerId) {
        conditions.push(eq(deals.ownerId, filter.ownerId));
      }

      const rows = await db
        .select({
          deal: deals,
          probability: pipelineStages.probability,
        })
        .from(deals)
        .innerJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
        .where(and(...conditions));

      const today = new Date().toISOString().slice(0, 10);
      const byStage = new Map<
        string,
        {
          dealCount: number;
          totalBaseAmount: number;
          weightedValue: number;
          overdueCount: number;
          overdueBaseAmount: number;
        }
      >();
      for (const stage of stages) {
        byStage.set(stage.id, {
          dealCount: 0,
          totalBaseAmount: 0,
          weightedValue: 0,
          overdueCount: 0,
          overdueBaseAmount: 0,
        });
      }
      const totals = { dealCount: 0, totalBaseAmount: 0, weightedValue: 0 };
      for (const row of rows) {
        const bucket = byStage.get(row.deal.stageId);
        if (!bucket) continue;
        const base = toNumber(row.deal.baseAmount, 'baseAmount');
        const probability = row.deal.probability ?? row.probability;
        const weighted = Math.round(base * (probability / 100) * 100) / 100;
        bucket.dealCount += 1;
        bucket.totalBaseAmount = Math.round((bucket.totalBaseAmount + base) * 100) / 100;
        bucket.weightedValue = Math.round((bucket.weightedValue + weighted) * 100) / 100;
        totals.dealCount += 1;
        totals.totalBaseAmount = Math.round((totals.totalBaseAmount + base) * 100) / 100;
        totals.weightedValue = Math.round((totals.weightedValue + weighted) * 100) / 100;
        if (
          row.deal.status === 'open' &&
          row.deal.expectedCloseDate &&
          row.deal.expectedCloseDate.toISOString().slice(0, 10) < today
        ) {
          bucket.overdueCount += 1;
          bucket.overdueBaseAmount = Math.round((bucket.overdueBaseAmount + base) * 100) / 100;
        }
      }
      return {
        pipeline: { id: pipeline.id, name: pipeline.name, slug: pipeline.slug },
        baseCurrency,
        stages: stages.map((stage) => ({
          stage: {
            id: stage.id,
            key: stage.key,
            name: stage.name,
            position: stage.position,
            probability: stage.probability,
          },
          ...byStage.get(stage.id)!,
        })),
        totals,
      };
    });
  }

  private emptyForecast(
    pipeline: { id: string; name: string; slug: string },
    stages: Array<{ id: string; key: string; name: string; position: number; probability: number }>,
    baseCurrency: string,
  ): {
    pipeline: { id: string; name: string; slug: string };
    baseCurrency: string;
    stages: Array<{
      stage: { id: string; key: string; name: string; position: number; probability: number };
      dealCount: number;
      totalBaseAmount: number;
      weightedValue: number;
      overdueCount: number;
      overdueBaseAmount: number;
    }>;
    totals: { dealCount: number; totalBaseAmount: number; weightedValue: number };
  } {
    return {
      pipeline: { id: pipeline.id, name: pipeline.name, slug: pipeline.slug },
      baseCurrency,
      stages: stages.map((stage) => ({
        stage: {
          id: stage.id,
          key: stage.key,
          name: stage.name,
          position: stage.position,
          probability: stage.probability,
        },
        dealCount: 0,
        totalBaseAmount: 0,
        weightedValue: 0,
        overdueCount: 0,
        overdueBaseAmount: 0,
      })),
      totals: { dealCount: 0, totalBaseAmount: 0, weightedValue: 0 },
    };
  }

  private recordScope(auth: AuthContext): 'all' | 'own' {
    return auth.role.permissions?.recordAccess?.['deal'] ?? 'own';
  }

  private assertDealReadable(auth: AuthContext, ownerId: string | null): void {
    try {
      checkRecordAccess(auth.role.permissions, 'deal', ownerId ?? '', auth.user.id);
    } catch {
      recordForbidden();
    }
  }

  private async resolveStageForCreate(
    db: NexusDb,
    orgId: string,
    input: { pipelineId?: string; stageId?: string },
  ): Promise<{ pipeline: { id: string; name: string; slug: string }; stage: PipelineStage }> {
    if (!input.pipelineId && input.stageId) {
      const [stage] = await db
        .select()
        .from(pipelineStages)
        .where(and(eq(pipelineStages.id, input.stageId), eq(pipelineStages.orgId, orgId)));
      if (!stage) {
        throw new NotFoundException({
          message: 'Stage not found',
          code: 'STAGE_NOT_FOUND',
        });
      }
      const [pipeline] = await db
        .select()
        .from(pipelines)
        .where(and(eq(pipelines.id, stage.pipelineId), eq(pipelines.orgId, orgId)));
      if (!pipeline) {
        throw new NotFoundException({ message: 'Pipeline not found', code: 'PIPELINE_NOT_FOUND' });
      }
      return {
        pipeline: { id: pipeline.id, name: pipeline.name, slug: pipeline.slug },
        stage,
      };
    }
    if (!input.pipelineId) {
      const defaults = await this.pipelines.ensureDefaultPipeline(orgId);
      const first = defaults.stages[0];
      if (!first) throw new Error('Default pipeline has no stages');
      return {
        pipeline: {
          id: defaults.pipeline.id,
          name: defaults.pipeline.name,
          slug: defaults.pipeline.slug,
        },
        stage: first,
      };
    }
    const [pipeline] = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.orgId, orgId)));
    if (!pipeline) {
      throw new NotFoundException({ message: 'Pipeline not found', code: 'PIPELINE_NOT_FOUND' });
    }
    if (!input.stageId) {
      const [first] = await db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, pipeline.id))
        .orderBy(pipelineStages.position)
        .limit(1);
      if (!first) {
        throw new NotFoundException({
          message: 'Pipeline has no stages',
          code: 'PIPELINE_EMPTY',
        });
      }
      return {
        pipeline: { id: pipeline.id, name: pipeline.name, slug: pipeline.slug },
        stage: first,
      };
    }
    const [stage] = await db
      .select()
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.id, input.stageId),
          eq(pipelineStages.pipelineId, pipeline.id),
          eq(pipelineStages.orgId, orgId),
        ),
      );
    if (!stage) {
      throw new NotFoundException({
        message: 'Stage not found in this pipeline',
        code: 'STAGE_NOT_FOUND',
      });
    }
    return {
      pipeline: { id: pipeline.id, name: pipeline.name, slug: pipeline.slug },
      stage,
    };
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

  private async requireContact(db: NexusDb, orgId: string, contactId: string) {
    const [contact] = await db
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.id, contactId), eq(contacts.orgId, orgId), isNull(contacts.deletedAt)),
      );
    if (!contact) {
      throw new NotFoundException({ message: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
    }
    return contact;
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

  private async orgBaseCurrency(db: NexusDb, orgId: string): Promise<string> {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return resolveBaseCurrency(org?.settings);
  }

  private async rateFor(
    db: NexusDb,
    orgId: string,
    currency: string,
    baseCurrency: string,
  ): Promise<{ rate: number; rateDate: string }> {
    const today = new Date().toISOString().slice(0, 10);
    const [snapshot] = await db
      .select()
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.orgId, orgId),
          eq(exchangeRates.baseCurrency, baseCurrency),
          eq(exchangeRates.rateDate, today),
        ),
      );
    if (currency === baseCurrency) return { rate: 1, rateDate: today };
    const rate = (snapshot?.rates as Record<string, number> | undefined)?.[currency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new NotFoundException({
        message: `No exchange-rate snapshot for ${currency} on ${today}`,
        code: 'RATE_SNAPSHOT_MISSING',
      });
    }
    return { rate, rateDate: today };
  }

  private async requireLiveDeal(db: NexusDb, orgId: string, id: string) {
    const [row] = await db
      .select({
        deal: deals,
        pipeline: pipelines,
        stage: pipelineStages,
        account: accounts,
        contact: contacts,
        owner: users,
      })
      .from(deals)
      .innerJoin(pipelines, eq(deals.pipelineId, pipelines.id))
      .innerJoin(pipelineStages, eq(deals.stageId, pipelineStages.id))
      .leftJoin(accounts, eq(deals.accountId, accounts.id))
      .leftJoin(contacts, eq(deals.contactId, contacts.id))
      .leftJoin(users, eq(deals.ownerId, users.id))
      .where(and(eq(deals.id, id), eq(deals.orgId, orgId), isNull(deals.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    return row;
  }

  private async serializeById(
    db: NexusDb,
    auth: AuthContext,
    defs: FieldDefinition[],
    id: string,
  ): Promise<SerializedDeal> {
    const row = await this.requireLiveDeal(db, auth.org.id, id);
    return this.serializeJoined(
      auth,
      defs,
      row.deal,
      row.pipeline,
      row.stage,
      row.account,
      row.contact,
      row.owner,
    );
  }

  private serialize(
    auth: AuthContext,
    defs: FieldDefinition[],
    deal: Deal,
    pipeline: { id: string; name: string; slug: string },
    stage: PipelineStage,
    account: { id: string; name: string } | null,
    contact: { id: string; name: string; email: string } | null,
    owner: { id: string; name: string } | null,
  ): SerializedDeal {
    return this.serializeJoined(auth, defs, deal, pipeline, stage, account, contact, owner);
  }

  private serializeJoined(
    auth: AuthContext,
    defs: FieldDefinition[],
    deal: Deal,
    pipeline: { id: string; name: string; slug: string },
    stage: PipelineStage,
    account: { id: string; name: string } | null,
    contact: { id: string; name: string; email: string } | null,
    owner: { id: string; name: string } | null,
  ): SerializedDeal {
    const { computed, errors } = computeFormulas(
      defs,
      (deal.customFields ?? {}) as Record<string, unknown>,
    );
    const effectiveProbability = deal.probability ?? stage.probability;
    const baseAmount = toNumber(deal.baseAmount, 'baseAmount');
    const weightedValue = Math.round(baseAmount * (effectiveProbability / 100) * 100) / 100;
    const record: Record<string, unknown> = {
      id: deal.id,
      pipeline: { id: pipeline.id, name: pipeline.name, slug: pipeline.slug },
      stage: {
        id: stage.id,
        key: stage.key,
        name: stage.name,
        position: stage.position,
        probability: stage.probability,
        isClosedWon: stage.isClosedWon,
        isClosedLost: stage.isClosedLost,
      },
      account,
      contact: contact ? { id: contact.id, name: contact.name, email: contact.email } : null,
      owner,
      ownerId: deal.ownerId,
      name: deal.name,
      amount: toNumber(deal.amount, 'amount'),
      currency: deal.currency,
      baseCurrency: deal.baseCurrency,
      baseAmount,
      exchangeRate: toNumber(deal.exchangeRate, 'exchangeRate'),
      exchangeRateDate: deal.exchangeRateDate,
      probability: deal.probability,
      effectiveProbability,
      weightedValue,
      expectedCloseDate: deal.expectedCloseDate,
      closeDateStatus: closeDateStatus(deal.status, deal.expectedCloseDate),
      status: deal.status,
      lossReason: deal.lossReason,
      closedAt: deal.closedAt,
      customFields: this.filterCustom(deal.customFields, auth),
      computedFields: this.filterCustom(computed, auth),
      createdAt: deal.createdAt,
      updatedAt: deal.updatedAt,
    };
    const visible = filterReadableFields(auth.role.permissions, 'deal', record);
    if (Object.keys(errors).length > 0) {
      (visible as Record<string, unknown>)['formulaErrors'] = errors;
    }
    return visible as SerializedDeal;
  }

  private filterCustom(
    values: Record<string, unknown> | null | undefined,
    auth: AuthContext,
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (fieldRule(auth.role.permissions, 'deal', key) === 'none') continue;
      output[key] = value;
    }
    return output;
  }
}
