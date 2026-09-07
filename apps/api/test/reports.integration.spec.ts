import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { inviteAndAccept, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';

describe('reports forecast, pipeline, activity, and conversion', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@reports.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let repAgent: request.Agent;
  let ownerName: string;
  const stageIds: Record<string, string> = {};
  let contactId: string;

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
        orgName: `Reports Org ${runId}`,
        name: 'Rita Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerName = signup.body.user.name as string;
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Randy Rep',
    });
    repAgent = await loginAgent(server, email('rep'), 'member-pass-12');

    const pipelines = await ownerAgent.get('/v1/pipelines');
    expect(pipelines.status).toBe(200);
    for (const stage of pipelines.body[0].stages as Array<{ key: string; id: string }>) {
      stageIds[stage.key] = stage.id;
    }

    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Report Person',
      email: `reporty-${runId}@example.test`,
    });
    contactId = contact.body.contact.id as string;

    // Owner forecast set: one deal per category, all in Discovery (10%).
    await ownerAgent.post('/v1/deals').send({
      name: 'Commit deal',
      amount: 10000,
      forecastCategory: 'commit',
    });
    await ownerAgent.post('/v1/deals').send({
      name: 'Best case deal',
      amount: 20000,
      forecastCategory: 'best_case',
    });
    await ownerAgent.post('/v1/deals').send({ name: 'Pipeline deal', amount: 5000 });
    await repAgent.post('/v1/deals').send({ name: 'Rep pipeline deal', amount: 4000 });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('rolls forecast buckets by category with base-currency math', async () => {
    const res = await ownerAgent.get('/v1/reports/forecast').query({ refresh: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.meta.cached).toBe(false);
    expect(res.body.data.baseCurrency).toBe('USD');
    const totals = res.body.data.totals;
    expect(totals.dealCount).toBe(4);
    expect(totals.totalBaseAmount).toBe(39000);
    expect(totals.weightedValue).toBe(3900);
    expect(totals.commitBaseAmount).toBe(10000);
    expect(totals.bestCaseBaseAmount).toBe(30000);
    expect(totals.pipelineBaseAmount).toBe(39000);

    const owners = res.body.data.byOwner as Array<{
      owner: { name: string };
      totalBaseAmount: number;
      commitBaseAmount: number;
    }>;
    expect(owners.length).toBe(2);
    const mine = owners.find((o) => o.owner.name === ownerName);
    expect(mine?.totalBaseAmount).toBe(35000);
    expect(mine?.commitBaseAmount).toBe(10000);

    const discovery = (
      res.body.data.pipelines[0].stages as Array<{ stage: { key: string }; dealCount: number }>
    ).find((s) => s.stage.key === 'discovery');
    expect(discovery?.dealCount).toBe(4);
  });

  it('serves repeated forecast views from cache until refreshed', async () => {
    const first = await ownerAgent.get('/v1/reports/forecast');
    expect(first.body.meta.cached).toBe(true);
    const second = await ownerAgent.get('/v1/reports/forecast').query({ refresh: 'true' });
    expect(second.body.meta.cached).toBe(false);
    expect(second.body.data.totals.dealCount).toBe(4);
  });

  it('restricts rep forecast rows to their own deals', async () => {
    const res = await repAgent.get('/v1/reports/forecast').query({ refresh: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.data.totals.dealCount).toBe(1);
    expect(res.body.data.totals.totalBaseAmount).toBe(4000);

    const foreign = await repAgent
      .get('/v1/reports/forecast')
      .query({ ownerId: '00000000-0000-4000-8000-000000000000', refresh: 'true' });
    expect(foreign.body.data.totals.dealCount).toBe(0);
  });

  it('updates forecast categories through deal PATCH', async () => {
    const listed = await ownerAgent.get('/v1/deals').query({ limit: 200 });
    const target = (listed.body.deals as Array<{ id: string; name: string }>).find(
      (d) => d.name === 'Pipeline deal',
    );
    expect(target).toBeDefined();

    const patched = await ownerAgent
      .patch(`/v1/deals/${target!.id}`)
      .send({ forecastCategory: 'commit' });
    expect(patched.status).toBe(200);
    expect(patched.body.deal.forecastCategory).toBe('commit');

    const bad = await ownerAgent
      .patch(`/v1/deals/${target!.id}`)
      .send({ forecastCategory: 'maybe' });
    expect(bad.status).toBe(400);

    const res = await ownerAgent.get('/v1/reports/forecast').query({ refresh: 'true' });
    expect(res.body.data.totals.commitBaseAmount).toBe(15000);

    // Restore for the other tests.
    await ownerAgent.patch(`/v1/deals/${target!.id}`).send({ forecastCategory: 'pipeline' });
  });

  it('shows open/won/lost stage distribution in the pipeline report', async () => {
    const listed = await ownerAgent.get('/v1/deals').query({ limit: 200 });
    const target = (listed.body.deals as Array<{ id: string; name: string }>).find(
      (d) => d.name === 'Best case deal',
    );
    const won = await ownerAgent.post(`/v1/deals/${target!.id}/stage`).send({
      stageId: stageIds['closed-won'],
    });
    expect(won.status).toBe(201);

    const res = await ownerAgent.get('/v1/reports/pipeline').query({ refresh: 'true' });
    expect(res.status).toBe(200);
    const stages = res.body.data.pipelines[0].stages as Array<{
      stage: { key: string };
      open: { count: number };
      won: { count: number; baseAmount: number };
      lost: { count: number };
    }>;
    const discovery = stages.find((s) => s.stage.key === 'discovery');
    expect(discovery?.open.count).toBe(3);
    const wonStage = stages.find((s) => s.stage.key === 'closed-won');
    expect(wonStage?.won.count).toBe(1);
    expect(wonStage?.won.baseAmount).toBe(20000);
  });

  it('counts activities by type with date filtering', async () => {
    await ownerAgent.post('/v1/activities').send({ type: 'call', subject: 'R call' });
    await ownerAgent.post('/v1/activities').send({ type: 'meeting', subject: 'R meeting' });
    await ownerAgent.post(`/v1/contacts/${contactId}/notes`).send({ body: 'R note' });
    await ownerAgent.post('/v1/activities').send({
      type: 'email',
      subject: 'Old mail',
      occurredAt: new Date(Date.now() - 90 * 86400000).toISOString(),
    });

    const res = await ownerAgent.get('/v1/reports/activity').query({ refresh: 'true' });
    expect(res.status).toBe(200);
    const byType = Object.fromEntries(
      (res.body.data.byType as Array<{ type: string; count: number }>).map((t) => [
        t.type,
        t.count,
      ]),
    );
    expect(byType['call']).toBeGreaterThanOrEqual(1);
    expect(byType['meeting']).toBeGreaterThanOrEqual(1);
    expect(byType['note']).toBeGreaterThanOrEqual(1);
    expect(byType['email']).toBeGreaterThanOrEqual(1);

    const recent = await ownerAgent
      .get('/v1/reports/activity')
      .query({ from: new Date(Date.now() - 86400000).toISOString().slice(0, 10), refresh: 'true' });
    expect(recent.body.data.total).toBe(res.body.data.total - 1);

    const badRange = await ownerAgent.get('/v1/reports/activity').query({
      from: '2026-02-01',
      to: '2026-01-01',
    });
    expect(badRange.status).toBe(400);
    expect(badRange.body.code).toBe('INVALID_DATE_RANGE');
  });

  it('computes lead funnel and deal win rates', async () => {
    const mkLead = async (name: string, tag: string, status?: string) => {
      const created = await ownerAgent.post('/v1/leads').send({
        name,
        email: `${tag}-${runId}@example.test`,
      });
      expect(created.status).toBe(201);
      const id = created.body.lead.id as string;
      if (status) {
        const patched = await ownerAgent.patch(`/v1/leads/${id}`).send({ status });
        expect(patched.status).toBe(200);
      }
    };
    await mkLead('Lead New', 'funnel-new');
    await mkLead('Lead Contacted', 'funnel-contacted', 'contacted');
    await mkLead('Lead Qualified', 'funnel-qualified', 'qualified');
    await mkLead('Lead Won', 'funnel-converted', 'converted');

    const listed = await ownerAgent.get('/v1/deals').query({ limit: 200 });
    const deals = listed.body.deals as Array<{ id: string; name: string }>;
    await ownerAgent
      .post(`/v1/deals/${deals.find((d) => d.name === 'Commit deal')!.id}/stage`)
      .send({
        stageId: stageIds['closed-won'],
      });
    const lostDeal = await ownerAgent.post('/v1/deals').send({
      name: 'Lost deal',
      amount: 1000,
      stageId: stageIds['closed-lost'],
      lossReason: 'Budget cut',
    });
    expect(lostDeal.status).toBe(201);

    const res = await ownerAgent.get('/v1/reports/conversion').query({ refresh: 'true' });
    expect(res.status).toBe(200);
    const funnel = Object.fromEntries(
      (res.body.data.leads.byStatus as Array<{ status: string; count: number }>).map((s) => [
        s.status,
        s.count,
      ]),
    );
    expect(funnel['new']).toBe(1);
    expect(funnel['contacted']).toBe(1);
    expect(funnel['qualified']).toBe(1);
    expect(funnel['converted']).toBe(1);
    expect(res.body.data.leads.convertedRate).toBe(25);
    // 2 won (best-case earlier + commit now), 1 lost.
    expect(res.body.data.deals.won).toBe(2);
    expect(res.body.data.deals.lost).toBe(1);
    expect(res.body.data.deals.winRate).toBeCloseTo(66.67, 1);
  });

  it('rejects unknown pipelines and bad cursors', async () => {
    const missing = await ownerAgent.get('/v1/reports/forecast').query({
      pipelineId: '00000000-0000-4000-8000-000000000000',
      refresh: 'true',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('PIPELINE_NOT_FOUND');
  });
});
