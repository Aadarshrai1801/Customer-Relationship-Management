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

describe('billing seats, proration, and invoices', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@billing.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;

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
        orgName: `Billing Org ${runId}`,
        name: 'Bella Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('starts on trial with headcount seats and zero MRR', async () => {
    const res = await ownerAgent.get('/v1/billing/subscription');
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('trial');
    // Owner + invited rep = headcount of 2.
    expect(res.body.seats).toBe(2);
    expect(res.body.activeUsers).toBe(2);
    expect(res.body.mrr).toBe(0);
    expect(res.body.provider).toBe('stub');
  });

  it('previews full-cycle upgrades with plan uplift and added seats', async () => {
    const preview = await ownerAgent.post('/v1/billing/seats/preview').send({
      plan: 'growth',
      seats: 3,
    });
    expect(preview.status).toBe(201);
    expect(preview.body.daysRemainingInCycle).toBe(30);
    // Uplift on 2 kept seats (30-0)*2 + 1 added seat * 30.
    expect(preview.body.proratedCharge).toBe(90);
    expect(preview.body.newMrr).toBe(90);
    expect(preview.body.previousSeats).toBe(2);
  });

  it('prorates mid-cycle by days remaining', async () => {
    const orgId = (
      await authDb.query(`SELECT id FROM organizations WHERE name = 'Billing Org ${runId}'`)
    ).rows[0].id as string;
    await authDb.query(
      `UPDATE subscriptions SET cycle_start = now() - interval '15 days' WHERE org_id = $1`,
      [orgId],
    );

    const preview = await ownerAgent.post('/v1/billing/seats/preview').send({
      plan: 'growth',
      seats: 3,
    });
    expect(preview.status).toBe(201);
    expect(preview.body.daysRemainingInCycle).toBe(15);
    expect(preview.body.proratedCharge).toBeCloseTo(45, 1);
  });

  it('applies seat changes with a paid invoice and audit trail', async () => {
    const applied = await ownerAgent.post('/v1/billing/seats').send({
      plan: 'growth',
      seats: 3,
    });
    expect(applied.status).toBe(201);
    expect(applied.body.subscription.plan).toBe('growth');
    expect(applied.body.subscription.seats).toBe(3);
    expect(applied.body.charged).toBeCloseTo(45, 1);
    expect(applied.body.invoice.status).toBe('paid');
    expect(Number(applied.body.invoice.amount)).toBeCloseTo(applied.body.charged as number, 2);
    expect(applied.body.invoice.providerRef).toMatch(/^stub:/);

    const invoices = await ownerAgent.get('/v1/billing/invoices');
    expect(invoices.status).toBe(200);
    expect(
      (invoices.body as Array<{ id: string }>).some((i) => i.id === applied.body.invoice.id),
    ).toBe(true);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'subscription.updated', entityId: applied.body.subscription.id });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('credits removals without invoicing', async () => {
    const applied = await ownerAgent.post('/v1/billing/seats').send({ seats: 2 });
    expect(applied.status).toBe(201);
    expect(applied.body.charged).toBe(0);
    expect(applied.body.invoice).toBeNull();
    expect(applied.body.subscription.seats).toBe(2);
  });

  it('guards headcount, validation, and scopes', async () => {
    const below = await ownerAgent.post('/v1/billing/seats/preview').send({ seats: 1 });
    expect(below.status).toBe(400);
    expect(below.body.code).toBe('SEATS_BELOW_HEADCOUNT');

    const zero = await ownerAgent.post('/v1/billing/seats').send({ seats: 0 });
    expect(zero.status).toBe(400);

    const badPlan = await ownerAgent.post('/v1/billing/seats/preview').send({
      seats: 2,
      plan: 'plutonium',
    });
    expect(badPlan.status).toBe(400);

    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const blocked = await repAgent.post('/v1/billing/seats/preview').send({ seats: 2 });
    expect(blocked.status).toBe(403);

    const blind = await repAgent.get('/v1/billing/subscription');
    expect(blind.status).toBe(403);
  });
});
