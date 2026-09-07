import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PipelinesService } from '../src/pipelines/pipelines.service';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://nexus_app:nexus_app@localhost:5433/nexus';

describe('pipelines schema, seeding, and currency snapshots', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@pipelines.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  let appDb: Pool;
  const orgIds: string[] = [];
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    authDb = new Pool({ connectionString: AUTH_DATABASE_URL });
    appDb = new Pool({ connectionString: DATABASE_URL });

    const signupA = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Pipelines Org A ${runId}`,
        name: 'Pippa Owner',
        email: email('owner-a'),
        password: 'correct-horse-12',
      });
    expect(signupA.status).toBe(201);
    orgAId = signupA.body.org.id as string;
    orgIds.push(orgAId);

    const signupB = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Pipelines Org B ${runId}`,
        name: 'Owen Owner',
        email: email('owner-b'),
        password: 'correct-horse-12',
      });
    expect(signupB.status).toBe(201);
    orgBId = signupB.body.org.id as string;
    orgIds.push(orgBId);
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await appDb.end();
    await app.close();
  });

  it('seeds a default pipeline with ordered stages on signup', async () => {
    const service = app.get(PipelinesService);
    const seeded = await service.listPipelines(orgAId);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.pipeline.slug).toBe('sales');
    expect(seeded[0]!.pipeline.isDefault).toBe(true);
    expect(
      seeded[0]!.stages.map((s) => [s.key, s.probability, s.isClosedWon, s.isClosedLost]),
    ).toEqual([
      ['discovery', 10, false, false],
      ['proposal', 50, false, false],
      ['negotiation', 75, false, false],
      ['closed-won', 100, true, false],
      ['closed-lost', 0, false, true],
    ]);

    const again = await service.ensureDefaultPipeline(orgAId);
    expect(again.pipeline.id).toBe(seeded[0]!.pipeline.id);
    const relisted = await service.listPipelines(orgAId);
    expect(relisted).toHaveLength(1);
  });

  it('isolates pipelines per tenant at the database layer', async () => {
    const service = app.get(PipelinesService);
    const mine = await service.listPipelines(orgBId);
    expect(mine).toHaveLength(1);
    const theirs = await service.listPipelines(orgAId);
    expect(mine[0]!.pipeline.id).not.toBe(theirs[0]!.pipeline.id);

    const withoutTenant = await appDb.query('SELECT count(*)::int AS n FROM pipelines');
    expect(withoutTenant.rows[0].n).toBe(0);
  });

  it('stores and resolves daily exchange-rate snapshots', async () => {
    const service = app.get(PipelinesService);
    const saved = await service.upsertExchangeRates(orgAId, {
      rateDate: '2026-09-07',
      baseCurrency: 'usd',
      rates: { eur: 0.92, gbp: 0.79 },
    });
    expect(saved).toMatchObject({ rateDate: '2026-09-07', baseCurrency: 'USD' });
    expect(saved.rates).toEqual({ EUR: 0.92, GBP: 0.79 });

    await expect(
      service.getExchangeRate(orgAId, {
        currency: 'EUR',
        baseCurrency: 'USD',
        rateDate: '2026-09-07',
      }),
    ).resolves.toMatchObject({ rate: 0.92 });
    await expect(
      service.getExchangeRate(orgAId, {
        currency: 'USD',
        baseCurrency: 'USD',
        rateDate: '2026-09-07',
      }),
    ).resolves.toMatchObject({ rate: 1 });
    await expect(
      service.getExchangeRate(orgAId, {
        currency: 'JPY',
        baseCurrency: 'USD',
        rateDate: '2026-09-07',
      }),
    ).rejects.toMatchObject({ response: { code: 'RATE_MISSING' } });
    await expect(
      service.getExchangeRate(orgAId, {
        currency: 'EUR',
        baseCurrency: 'USD',
        rateDate: '2026-09-06',
      }),
    ).rejects.toMatchObject({ response: { code: 'RATE_SNAPSHOT_MISSING' } });
  });

  it('rejects invalid currency snapshots', async () => {
    const service = app.get(PipelinesService);
    await expect(
      service.upsertExchangeRates(orgAId, {
        rateDate: '2026-09-07',
        baseCurrency: 'XX',
        rates: { EUR: 0.92 },
      }),
    ).rejects.toMatchObject({ response: { code: 'CURRENCY_INVALID' } });
    await expect(
      service.upsertExchangeRates(orgAId, {
        rateDate: '09/07/2026',
        baseCurrency: 'USD',
        rates: { EUR: 0.92 },
      }),
    ).rejects.toMatchObject({ response: { code: 'RATE_DATE_INVALID' } });
    await expect(
      service.upsertExchangeRates(orgAId, {
        rateDate: '2026-09-07',
        baseCurrency: 'USD',
        rates: { EUR: 0 },
      }),
    ).rejects.toMatchObject({ response: { code: 'RATE_INVALID' } });
  });
});

describe('deal stage transitions, history, and forecasting', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@stagestest.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let pipelineId: string;
  const stageIds: Record<string, string> = {};

  async function freshOrg(tag: string): Promise<{ orgId: string; agent: request.Agent }> {
    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Stages ${tag} ${runId}`,
        name: 'S',
        email: email(`owner-${tag}`),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    const agent = request.agent(server);
    await agent
      .post('/v1/auth/login')
      .send({ email: email(`owner-${tag}`), password: 'correct-horse-12' });
    return { orgId: signup.body.org.id as string, agent };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    authDb = new Pool({ connectionString: AUTH_DATABASE_URL });

    const setup = await freshOrg('main');
    ownerAgent = setup.agent;
    const pipelines = await ownerAgent.get('/v1/pipelines');
    expect(pipelines.status).toBe(200);
    pipelineId = pipelines.body[0].pipeline.id as string;
    for (const stage of pipelines.body[0].stages as Array<{ key: string; id: string }>) {
      stageIds[stage.key] = stage.id;
    }
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('lists the seeded pipeline with ordered stages', async () => {
    const res = await ownerAgent.get('/v1/pipelines');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].pipeline.slug).toBe('sales');
    expect(res.body[0].stages.map((s: { key: string }) => s.key)).toEqual([
      'discovery',
      'proposal',
      'negotiation',
      'closed-won',
      'closed-lost',
    ]);
  });

  it('transitions deals with history, durations, and audit', async () => {
    const created = await ownerAgent.post('/v1/deals').send({ name: 'Stagey', amount: 10000 });
    const id = created.body.deal.id as string;

    const first = await ownerAgent.get(`/v1/deals/${id}/history`);
    expect(first.body).toHaveLength(1);
    expect(first.body[0].toStageName).toBe('Discovery');
    expect(first.body[0].fromStageId).toBeNull();

    const moved = await ownerAgent.post(`/v1/deals/${id}/stage`).send({
      stageId: stageIds['proposal'],
    });
    expect(moved.status).toBe(201);
    expect(moved.body.changed).toBe(true);
    expect(moved.body.deal.stage.key).toBe('proposal');
    expect(moved.body.deal.effectiveProbability).toBe(50);
    expect(moved.body.deal.weightedValue).toBe(5000);

    const history = await ownerAgent.get(`/v1/deals/${id}/history`);
    expect(history.body).toHaveLength(2);
    const closed = history.body.find((h: { toStageName: string }) => h.toStageName === 'Discovery');
    expect(closed.exitedAt).not.toBeNull();
    expect(closed.durationSeconds).toBeGreaterThanOrEqual(0);

    const noop = await ownerAgent.post(`/v1/deals/${id}/stage`).send({
      stageId: stageIds['proposal'],
    });
    expect(noop.body.changed).toBe(false);
    const sameHistory = await ownerAgent.get(`/v1/deals/${id}/history`);
    expect(sameHistory.body).toHaveLength(2);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'deal.stage_changed', entityId: id });
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0].newValues).toMatchObject({ stageName: 'Proposal' });
  });

  it('rejects stages from other pipelines', async () => {
    const other = await freshOrg('other-pipeline');
    const otherPipelines = await other.agent.get('/v1/pipelines');
    const foreignStageId = otherPipelines.body[0].stages[0].id as string;
    const created = await ownerAgent.post('/v1/deals').send({ name: 'Mismatch', amount: 5 });
    const res = await ownerAgent.post(`/v1/deals/${created.body.deal.id as string}/stage`).send({
      stageId: foreignStageId,
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STAGE_NOT_FOUND');
  });

  it('forecasts per-stage sums, weights, and overdue amounts', async () => {
    const { agent } = await freshOrg('forecast');
    const pipes = await agent.get('/v1/pipelines');
    const pipeId = pipes.body[0].pipeline.id as string;
    const stages = Object.fromEntries(
      (pipes.body[0].stages as Array<{ key: string; id: string }>).map((s) => [s.key, s.id]),
    );
    const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await agent.post('/v1/deals').send({
      name: 'F1',
      amount: 10000,
      stageId: stages['discovery'],
      expectedCloseDate: past,
    });
    await agent.post('/v1/deals').send({
      name: 'F2',
      amount: 20000,
      stageId: stages['proposal'],
      expectedCloseDate: future,
    });
    const f3 = await agent.post('/v1/deals').send({ name: 'F3', amount: 40000 });
    await agent.post(`/v1/deals/${f3.body.deal.id as string}/stage`).send({
      stageId: stages['closed-won'],
    });

    const forecast = await agent.get(`/v1/deals/forecast/by-pipeline?pipelineId=${pipeId}`);
    expect(forecast.status).toBe(200);
    expect(forecast.body.baseCurrency).toBe('USD');
    const discovery = forecast.body.stages.find(
      (s: { stage: { key: string } }) => s.stage.key === 'discovery',
    );
    expect(discovery).toMatchObject({
      dealCount: 1,
      totalBaseAmount: 10000,
      weightedValue: 1000,
      overdueCount: 1,
      overdueBaseAmount: 10000,
    });
    const proposal = forecast.body.stages.find(
      (s: { stage: { key: string } }) => s.stage.key === 'proposal',
    );
    expect(proposal).toMatchObject({ dealCount: 1, totalBaseAmount: 20000, weightedValue: 10000 });
    expect(forecast.body.totals).toMatchObject({
      dealCount: 2,
      totalBaseAmount: 30000,
      weightedValue: 11000,
    });

    const all = await agent.get(`/v1/deals/forecast/by-pipeline?pipelineId=${pipeId}&status=all`);
    expect(all.body.totals.dealCount).toBe(3);
  });

  it('exposes close-date decay signals on the deal', async () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    const soon = new Date(Date.now() + 3 * 86400000).toISOString();
    const far = new Date(Date.now() + 30 * 86400000).toISOString();
    const overdue = await ownerAgent
      .post('/v1/deals')
      .send({ name: 'Late', amount: 1, expectedCloseDate: past });
    expect(overdue.body.deal.closeDateStatus).toBe('overdue');
    const dueSoon = await ownerAgent
      .post('/v1/deals')
      .send({ name: 'Soon', amount: 1, expectedCloseDate: soon });
    expect(dueSoon.body.deal.closeDateStatus).toBe('due-soon');
    const onTrack = await ownerAgent
      .post('/v1/deals')
      .send({ name: 'Far', amount: 1, expectedCloseDate: far });
    expect(onTrack.body.deal.closeDateStatus).toBe('on-track');
    const none = await ownerAgent.post('/v1/deals').send({ name: 'Nodate', amount: 1 });
    expect(none.body.deal.closeDateStatus).toBeNull();
  });

  it('manages pipelines and stages with validation', async () => {
    const { agent } = await freshOrg('mgmt');
    const created = await agent.post('/v1/pipelines').send({ name: 'Enterprise' });
    expect(created.status).toBe(201);
    expect(created.body.pipeline.slug).toBe('enterprise');
    expect(created.body.stages).toEqual([]);

    const dupe = await agent.post('/v1/pipelines').send({ name: 'Enterprise' });
    expect(dupe.status).toBe(409);

    const renamed = await agent.patch(`/v1/pipelines/${created.body.pipeline.id as string}`).send({
      name: 'Enterprise Plus',
    });
    expect(renamed.body.pipeline.name).toBe('Enterprise Plus');

    const stage = await agent
      .post(`/v1/pipelines/${created.body.pipeline.id as string}/stages`)
      .send({ key: 'intro', name: 'Intro', probability: 5 });
    expect(stage.status).toBe(201);
    expect(stage.body.position).toBe(1);

    const badProb = await agent
      .post(`/v1/pipelines/${created.body.pipeline.id as string}/stages`)
      .send({ key: 'bad', name: 'Bad', probability: 150 });
    expect(badProb.status).toBe(400);

    const bothClosed = await agent
      .post(`/v1/pipelines/${created.body.pipeline.id as string}/stages`)
      .send({ key: 'both', name: 'Both', probability: 100, isClosedWon: true, isClosedLost: true });
    expect(bothClosed.status).toBe(400);

    const second = await agent
      .post(`/v1/pipelines/${created.body.pipeline.id as string}/stages`)
      .send({ key: 'second', name: 'Second', probability: 20, position: 1 });
    expect(second.body.position).toBe(1);
    const listed = await agent.get('/v1/pipelines');
    const pipe = (
      listed.body as Array<{
        pipeline: { id: string };
        stages: Array<{ key: string; position: number }>;
      }>
    ).find((p) => p.pipeline.id === (created.body.pipeline.id as string))!;
    expect(pipe.stages.map((s) => [s.key, s.position])).toEqual([
      ['second', 1],
      ['intro', 2],
    ]);

    const moved = await agent
      .patch(
        `/v1/pipelines/${created.body.pipeline.id as string}/stages/${second.body.id as string}`,
      )
      .send({ position: 2, probability: 25 });
    expect(moved.body.position).toBe(2);
    expect(moved.body.probability).toBe(25);

    const removed = await agent.delete(
      `/v1/pipelines/${created.body.pipeline.id as string}/stages/${second.body.id as string}`,
    );
    expect(removed.status).toBe(200);

    const deleted = await agent.delete(`/v1/pipelines/${created.body.pipeline.id as string}`);
    expect(deleted.status).toBe(200);
  });

  it('migrates deals off a deleted stage instead of orphaning them', async () => {
    const deal = await ownerAgent.post('/v1/deals').send({ name: 'Migrate Me', amount: 7000 });
    const dealId = deal.body.deal.id as string;
    await ownerAgent.post(`/v1/deals/${dealId}/stage`).send({ stageId: stageIds['negotiation'] });

    const blocked = await ownerAgent.delete(
      `/v1/pipelines/${pipelineId}/stages/${stageIds['negotiation']}`,
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('STAGE_HAS_DEALS');

    const migrated = await ownerAgent.delete(
      `/v1/pipelines/${pipelineId}/stages/${stageIds['negotiation']}?migrateToStageId=${stageIds['proposal']}`,
    );
    expect(migrated.status).toBe(200);
    expect(migrated.body.dealsMigrated).toBe(1);

    const after = await ownerAgent.get(`/v1/deals/${dealId}`);
    expect(after.body.stage.key).toBe('proposal');

    const history = await ownerAgent.get(`/v1/deals/${dealId}/history`);
    const migrationEntry = (history.body as Array<{ toStageName: string }>).find(
      (h) => h.toStageName === 'Proposal',
    );
    expect(migrationEntry).toBeDefined();

    const stages = await ownerAgent.get('/v1/pipelines');
    expect(stages.body[0].stages.map((s: { key: string }) => s.key)).not.toContain('negotiation');
  });

  it('protects the default pipeline and requires manage scope', async () => {
    const { agent } = await freshOrg('guards');
    const pipes = await agent.get('/v1/pipelines');
    const defaultId = pipes.body[0].pipeline.id as string;
    const delDefault = await agent.delete(`/v1/pipelines/${defaultId}`);
    expect(delDefault.status).toBe(409);
    expect(delDefault.body.code).toBe('PIPELINE_DEFAULT_IMMUTABLE');
  });
});
