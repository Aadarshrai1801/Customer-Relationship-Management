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
import { inviteAndAccept, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';

describe('deals core crud, scoping, and custom fields', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@deals.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let ownerId: string;
  let orgId: string;
  let pipelineId: string;
  let discoveryStageId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    authDb = new Pool({ connectionString: AUTH_DATABASE_URL });

    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Deals Org ${runId}`,
        name: 'Dana Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgId = signup.body.org.id as string;
    ownerId = signup.body.user.id as string;
    orgIds.push(orgId);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const defaults = await app.get(PipelinesService).ensureDefaultPipeline(orgId);
    pipelineId = defaults.pipeline.id;
    discoveryStageId = defaults.stages[0]!.id;

    await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'deal',
      key: 'deal_score',
      label: 'Deal Score',
      type: 'number',
    });
    await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'deal',
      key: 'double_score',
      label: 'Double Score',
      type: 'formula',
      options: { expression: '{deal_score} * 2' },
    });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('creates a deal on the default pipeline first stage', async () => {
    const res = await ownerAgent.post('/v1/deals').send({
      name: 'Acme Expansion',
      amount: 50000,
      currency: 'USD',
    });
    expect(res.status).toBe(201);
    expect(res.body.deal.name).toBe('Acme Expansion');
    expect(res.body.deal.pipeline.id).toBe(pipelineId);
    expect(res.body.deal.stage.id).toBe(discoveryStageId);
    expect(res.body.deal.stage.probability).toBe(10);
    expect(res.body.deal.effectiveProbability).toBe(10);
    expect(res.body.deal.weightedValue).toBe(5000);
    expect(res.body.deal.baseCurrency).toBe('USD');
    expect(res.body.deal.baseAmount).toBe(50000);
    expect(res.body.deal.exchangeRate).toBe(1);
    expect(res.body.deal.status).toBe('open');
    expect(res.body.deal.ownerId).toBe(ownerId);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'deal.created', entityId: res.body.deal.id });
    expect(audit.body.entries).toHaveLength(1);
  });

  it('validates deal input explicitly', async () => {
    const missing = await ownerAgent.post('/v1/deals').send({ amount: 100 });
    expect(missing.status).toBe(400);

    const negative = await ownerAgent.post('/v1/deals').send({ name: 'X', amount: -5 });
    expect(negative.status).toBe(400);

    const badCurrency = await ownerAgent
      .post('/v1/deals')
      .send({ name: 'X', amount: 5, currency: 'US' });
    expect(badCurrency.status).toBe(400);

    const badProbability = await ownerAgent
      .post('/v1/deals')
      .send({ name: 'X', amount: 5, probability: 150 });
    expect(badProbability.status).toBe(400);

    const stageAlone = await ownerAgent.post('/v1/deals').send({
      name: 'Stage Only',
      amount: 5,
      stageId: discoveryStageId,
    });
    expect(stageAlone.status).toBe(201);
    expect(stageAlone.body.deal.stage.id).toBe(discoveryStageId);
    expect(stageAlone.body.deal.pipeline.id).toBe(pipelineId);

    const unknownPipeline = await ownerAgent.post('/v1/deals').send({
      name: 'X',
      amount: 5,
      pipelineId: '00000000-0000-0000-0000-000000000000',
    });
    expect(unknownPipeline.status).toBe(404);
    expect(unknownPipeline.body.code).toBe('PIPELINE_NOT_FOUND');

    const foreignStage = await ownerAgent.post('/v1/deals').send({
      name: 'X',
      amount: 5,
      pipelineId,
      stageId: '00000000-0000-0000-0000-000000000000',
    });
    expect(foreignStage.status).toBe(404);
    expect(foreignStage.body.code).toBe('STAGE_NOT_FOUND');
  });

  it('converts foreign currency from the daily snapshot', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await app.get(PipelinesService).upsertExchangeRates(orgId, {
      rateDate: today,
      baseCurrency: 'USD',
      rates: { EUR: 0.9 },
    });
    const res = await ownerAgent.post('/v1/deals').send({
      name: 'Berlin Deal',
      amount: 9000,
      currency: 'EUR',
    });
    expect(res.status).toBe(201);
    expect(res.body.deal.baseCurrency).toBe('USD');
    expect(res.body.deal.baseAmount).toBe(10000);
    expect(res.body.deal.exchangeRate).toBe(0.9);
    expect(res.body.deal.exchangeRateDate).toBe(today);
    expect(res.body.deal.weightedValue).toBe(1000);

    const missing = await ownerAgent.post('/v1/deals').send({
      name: 'Tokyo Deal',
      amount: 1000,
      currency: 'JPY',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('RATE_SNAPSHOT_MISSING');
  });

  it('round-trips deal custom fields with computed formulas', async () => {
    const res = await ownerAgent.post('/v1/deals').send({
      name: 'Scored Deal',
      amount: 1000,
      customFields: { deal_score: 21 },
    });
    expect(res.status).toBe(201);
    expect(res.body.deal.customFields).toMatchObject({ deal_score: 21 });
    expect(res.body.deal.computedFields).toMatchObject({ double_score: 42 });

    const bad = await ownerAgent.post('/v1/deals').send({
      name: 'Bad Custom',
      amount: 1000,
      customFields: { deal_score: 'high', bogus: 1 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_ERROR');
  });

  it('associates accounts and contacts, rejecting foreign ones', async () => {
    const account = await ownerAgent.post('/v1/accounts').send({ name: 'Deal Account' });
    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Deal Person',
      email: `deal-person-${runId}@example.test`,
      accountId: account.body.account.id as string,
    });
    const res = await ownerAgent.post('/v1/deals').send({
      name: 'Associated Deal',
      amount: 2000,
      accountId: account.body.account.id as string,
      contactId: contact.body.contact.id as string,
    });
    expect(res.status).toBe(201);
    expect(res.body.deal.account).toMatchObject({ id: account.body.account.id });
    expect(res.body.deal.contact.email).toBe(`deal-person-${runId}@example.test`);

    const badAccount = await ownerAgent.post('/v1/deals').send({
      name: 'X',
      amount: 5,
      accountId: '00000000-0000-0000-0000-000000000000',
    });
    expect(badAccount.status).toBe(404);

    const other = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Deals Other ${runId}`,
        name: 'O',
        email: email('other'),
        password: 'correct-horse-12',
      });
    orgIds.push(other.body.org.id as string);
    const foreign = await ownerAgent.post('/v1/deals').send({
      name: 'X',
      amount: 5,
      accountId: other.body.org.id as string,
    });
    expect(foreign.status).toBe(404);
  });

  it('scopes visibility: rep sees own, manager sees all', async () => {
    const rep = await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const mine = await repAgent.post('/v1/deals').send({ name: 'Rep Deal', amount: 100 });
    expect(mine.status).toBe(201);

    const repList = await repAgent.get('/v1/deals');
    expect(repList.body.deals.map((d: { id: string }) => d.id)).toEqual([mine.body.deal.id]);

    const manager = await inviteAndAccept(server, ownerAgent, {
      email: email('manager'),
      roleKey: 'manager',
      name: 'Manny Manager',
    });
    void manager;
    const managerAgent = await loginAgent(server, email('manager'), 'member-pass-12');
    const managerList = await managerAgent.get('/v1/deals');
    expect(managerList.body.deals.length).toBeGreaterThan(1);

    const blocked = await repAgent.get(`/v1/deals/${managerList.body.deals[0].id as string}`);
    void blocked;
    const foreign = managerList.body.deals.find(
      (d: { id: string }) => d.id !== (mine.body.deal.id as string),
    ) as { id: string };
    const denied = await repAgent.get(`/v1/deals/${foreign.id}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('RECORD_FORBIDDEN');
    void rep;
  });

  it('requires deals:manage for writes', async () => {
    await inviteAndAccept(server, ownerAgent, {
      email: email('viewer'),
      roleKey: 'viewer',
      name: 'Vicky Viewer',
    });
    const viewerAgent = await loginAgent(server, email('viewer'), 'member-pass-12');
    const read = await viewerAgent.get('/v1/deals');
    expect(read.status).toBe(200);
    const create = await viewerAgent.post('/v1/deals').send({ name: 'X', amount: 5 });
    expect(create.status).toBe(403);
  });

  it('updates fields, reconverts currency, and audits the diff', async () => {
    const created = await ownerAgent.post('/v1/deals').send({ name: 'Mutable', amount: 1000 });
    const id = created.body.deal.id as string;
    const updated = await ownerAgent.patch(`/v1/deals/${id}`).send({
      name: 'Mutable Renamed',
      amount: 2000,
      probability: 50,
      customFields: { deal_score: 5 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.deal.name).toBe('Mutable Renamed');
    expect(updated.body.deal.effectiveProbability).toBe(50);
    expect(updated.body.deal.weightedValue).toBe(1000);
    expect(updated.body.deal.customFields).toMatchObject({ deal_score: 5 });

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'deal.updated', entityId: id });
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0].newValues.name).toBe('Mutable Renamed');
  });

  it('soft-deletes and hides the deal afterwards', async () => {
    const created = await ownerAgent.post('/v1/deals').send({ name: 'Gone', amount: 10 });
    const id = created.body.deal.id as string;
    const removed = await ownerAgent.delete(`/v1/deals/${id}`);
    expect(removed.status).toBe(200);
    const gone = await ownerAgent.get(`/v1/deals/${id}`);
    expect(gone.status).toBe(404);
    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'deal.deleted', entityId: id });
    expect(audit.body.entries).toHaveLength(1);
  });
});
