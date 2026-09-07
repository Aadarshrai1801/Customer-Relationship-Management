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

describe('stalled deals rot detection', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@stalled.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let freshId: string;
  let activeId: string;

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
        orgName: `Stalled Org ${runId}`,
        name: 'Stella Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    const orgId = signup.body.org.id as string;
    orgIds.push(orgId);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const fresh = await ownerAgent.post('/v1/deals').send({ name: `Fresh ${runId}`, amount: 100 });
    freshId = fresh.body.deal.id as string;
    const active = await ownerAgent
      .post('/v1/deals')
      .send({ name: `Active ${runId}`, amount: 200 });
    activeId = active.body.deal.id as string;

    // Age the fresh deal 20 days back across every activity source.
    await authDb.query(`UPDATE deals SET created_at = now() - interval '20 days' WHERE id = $1`, [
      freshId,
    ]);
    await authDb.query(
      `UPDATE deal_stage_history SET entered_at = now() - interval '20 days' WHERE deal_id = $1`,
      [freshId],
    );
    await authDb.query(
      `UPDATE audit_log_entries SET created_at = now() - interval '20 days' WHERE entity_type = 'deal' AND entity_id = $1`,
      [freshId],
    );
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('flags deals inactive beyond the default 14-day threshold', async () => {
    const res = await ownerAgent.get('/v1/deals/stalled');
    expect(res.status).toBe(200);
    expect(res.body.thresholdDays).toBe(14);
    const ids = (res.body.deals as Array<{ id: string }>).map((d) => d.id);
    expect(ids).toContain(freshId);
    expect(ids).not.toContain(activeId);

    const entry = (res.body.deals as Array<{ id: string; daysInactive: number }>).find(
      (d) => d.id === freshId,
    );
    expect(entry!.daysInactive).toBeGreaterThanOrEqual(20);
  });

  it('resets the clock on comments and honors custom thresholds', async () => {
    await ownerAgent.post('/v1/comments').send({
      entityType: 'deal',
      entityId: freshId,
      body: 'Still working it',
    });

    const res = await ownerAgent.get('/v1/deals/stalled');
    const ids = (res.body.deals as Array<{ id: string }>).map((d) => d.id);
    expect(ids).not.toContain(freshId);

    const zero = await ownerAgent.get('/v1/deals/stalled').query({ daysInactive: 0 });
    expect(zero.body.deals.length).toBeGreaterThanOrEqual(2);

    await ownerAgent.patch('/v1/org/settings').send({ staleDealDays: 30 });
    const configured = await ownerAgent.get('/v1/deals/stalled');
    expect(configured.body.thresholdDays).toBe(30);

    const bad = await ownerAgent.get('/v1/deals/stalled').query({ daysInactive: 400 });
    expect(bad.status).toBe(400);
  });

  it('sorts stalest first and scopes reps to their own deals', async () => {
    await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const repDeals = await repAgent.get('/v1/deals/stalled');
    expect(repDeals.status).toBe(200);
    expect(repDeals.body.deals).toEqual([]);

    // Age the active deal further than the fresh one; ordering follows.
    await authDb.query(`UPDATE deals SET created_at = now() - interval '40 days' WHERE id = $1`, [
      activeId,
    ]);
    await authDb.query(
      `UPDATE deal_stage_history SET entered_at = now() - interval '40 days' WHERE deal_id = $1`,
      [activeId],
    );
    await authDb.query(
      `UPDATE audit_log_entries SET created_at = now() - interval '40 days' WHERE entity_type = 'deal' AND entity_id = $1`,
      [activeId],
    );
    const res = await ownerAgent.get('/v1/deals/stalled').query({ daysInactive: 0 });
    const ids = (res.body.deals as Array<{ id: string }>).map((d) => d.id);
    // Fresh deal was commented recently; active deal is oldest.
    expect(ids[0]).toBe(activeId);
  });
});
