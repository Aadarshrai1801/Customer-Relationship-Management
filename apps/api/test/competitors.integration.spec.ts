import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';

describe('competitor catalog and deal links', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@competitors.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let otherAgent: request.Agent;
  let rivalId: string;
  let dealId: string;

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
        orgName: `Competitors Org ${runId}`,
        name: 'Cora Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const otherSignup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Competitors Other ${runId}`,
        name: 'Otto Owner',
        email: email('other'),
        password: 'correct-horse-12',
      });
    expect(otherSignup.status).toBe(201);
    orgIds.push(otherSignup.body.org.id as string);
    otherAgent = await loginAgent(server, email('other'), 'correct-horse-12');

    const deal = await ownerAgent
      .post('/v1/deals')
      .send({ name: `Rivalry ${runId}`, amount: 5000 });
    dealId = deal.body.deal.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('creates competitors with unique names and restores soft-deleted ones', async () => {
    const created = await ownerAgent.post('/v1/competitors').send({ name: 'Acme Rival' });
    expect(created.status).toBe(201);
    rivalId = created.body.competitor.id as string;

    const duplicate = await ownerAgent.post('/v1/competitors').send({ name: 'Acme Rival' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('COMPETITOR_NAME_TAKEN');

    const blank = await ownerAgent.post('/v1/competitors').send({ name: '   ' });
    expect(blank.status).toBe(400);

    const removed = await ownerAgent.delete(`/v1/competitors/${rivalId}`).send();
    expect(removed.status).toBe(200);

    const restored = await ownerAgent.post('/v1/competitors').send({ name: 'Acme Rival' });
    expect(restored.status).toBe(201);
    expect(restored.body.competitor.id).toBe(rivalId);
  });

  it('links competitors to deals and reports win/loss counts', async () => {
    const linked = await ownerAgent.patch(`/v1/deals/${dealId}`).send({ competitorId: rivalId });
    expect(linked.status).toBe(200);
    expect(linked.body.deal.competitor?.id).toBe(rivalId);
    expect(linked.body.deal.competitor?.name).toBe('Acme Rival');

    const badLink = await ownerAgent.patch(`/v1/deals/${dealId}`).send({
      competitorId: '00000000-0000-4000-8000-000000000000',
    });
    expect(badLink.status).toBe(404);
    expect(badLink.body.code).toBe('COMPETITOR_NOT_FOUND');

    const listed = await ownerAgent.get('/v1/competitors');
    expect(listed.status).toBe(200);
    const row = (listed.body as Array<{ id: string; openDeals: number; wonDeals: number }>).find(
      (c) => c.id === rivalId,
    );
    expect(row?.openDeals).toBe(1);
    expect(row?.wonDeals).toBe(0);

    const cleared = await ownerAgent.patch(`/v1/deals/${dealId}`).send({ competitorId: null });
    expect(cleared.body.deal.competitor).toBeNull();
  });

  it('isolates catalogs by org', async () => {
    const foreign = await otherAgent.get('/v1/competitors');
    expect(foreign.status).toBe(200);
    expect(foreign.body).toEqual([]);

    const steal = await otherAgent.patch(`/v1/deals/${dealId}`).send({ competitorId: rivalId });
    expect(steal.status).toBe(404);
  });
});
