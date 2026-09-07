import { createHmac, randomBytes } from 'node:crypto';
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

describe('team inbox triage', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@teaminbox.test`;

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
        orgName: `Inbox Org ${runId}`,
        name: 'Ivy Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const synced = await ownerAgent.post('/v1/emails/sync').send({
      provider: 'gmail',
      externalId: `msg-${runId}-inbox`,
      from: `stranger-${runId}@example.com`,
      to: [email('owner')],
      subject: 'Help needed',
    });
    expect(synced.status).toBe(201);
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('lists unclaimed inbound mail and claims it', async () => {
    const inbox = await ownerAgent.get('/v1/emails/inbox/list');
    expect(inbox.status).toBe(200);
    const messages = inbox.body.messages as Array<{ id: string; owner: unknown }>;
    const target = messages.find((m) =>
      JSON.stringify(m).includes(`stranger-${runId}@example.com`),
    );
    expect(target).toBeDefined();

    const claimed = await ownerAgent.post(`/v1/emails/inbox/${target?.id}/claim`).send({});
    expect(claimed.status).toBe(201);
    expect((claimed.body.activity.owner as { id: string } | null)?.id).toBeDefined();

    const missing = await ownerAgent
      .post('/v1/emails/inbox/00000000-0000-0000-0000-000000000000/claim')
      .send({});
    expect(missing.status).toBe(404);
  });
});

describe('territories and evaluation', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@territory.test`;

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
        orgName: `Territory Org ${runId}`,
        name: 'Tara Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('matches contacts by rule and rejects duplicates', async () => {
    const created = await ownerAgent.post('/v1/territories').send({
      name: 'EMEA',
      rules: [{ field: 'email_domain', operator: 'equals', value: 'acme.test' }],
    });
    expect(created.status).toBe(201);

    const duplicate = await ownerAgent.post('/v1/territories').send({
      name: 'EMEA',
      rules: [{ field: 'email_domain', operator: 'equals', value: 'other.test' }],
    });
    expect(duplicate.status).toBe(409);

    const insider = await ownerAgent.post('/v1/contacts').send({
      name: 'Acme Alice',
      email: `alice@acme.test`,
    });
    expect(insider.status).toBe(201);
    const outsider = await ownerAgent.post('/v1/contacts').send({
      name: 'Other Omar',
      email: `omar@other.test`,
    });
    expect(outsider.status).toBe(201);

    const matched = await ownerAgent
      .get('/v1/territories/evaluate')
      .query({ contactId: insider.body.contact.id as string });
    expect(matched.status).toBe(200);
    expect((matched.body.matches as Array<{ name: string }>).some((t) => t.name === 'EMEA')).toBe(
      true,
    );

    const unmatched = await ownerAgent
      .get('/v1/territories/evaluate')
      .query({ contactId: outsider.body.contact.id as string });
    expect(unmatched.status).toBe(200);
    expect((unmatched.body.matches as Array<{ name: string }>).some((t) => t.name === 'EMEA')).toBe(
      false,
    );

    const removed = await ownerAgent.delete(`/v1/territories/${created.body.territory.id}`).send();
    expect(removed.status).toBe(200);
  });
});

describe('contact enrichment', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@enrich.test`;

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
        orgName: `Enrich Org ${runId}`,
        name: 'Enid Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('links corporate domains to accounts and skips free providers', async () => {
    const corp = await ownerAgent.post('/v1/contacts').send({
      name: 'Corp Carl',
      email: `carl@globex-${runId}.com`,
    });
    expect(corp.status).toBe(201);
    const enriched = await ownerAgent.post(`/v1/contacts/${corp.body.contact.id}/enrich`).send({});
    expect(enriched.status).toBe(201);
    expect(enriched.body.applied.accountId).toBeDefined();
    expect(enriched.body.applied.tags).toBe('enriched');
    expect(enriched.body.contact.tags).toContain('enriched');

    // Idempotent: nothing left to apply.
    const again = await ownerAgent.post(`/v1/contacts/${corp.body.contact.id}/enrich`).send({});
    expect(again.status).toBe(201);
    expect(again.body.applied).toEqual({});

    const free = await ownerAgent.post('/v1/contacts').send({
      name: 'Free Fiona',
      email: `fiona.${runId}@gmail.com`,
    });
    expect(free.status).toBe(201);
    const skipped = await ownerAgent.post(`/v1/contacts/${free.body.contact.id}/enrich`).send({});
    expect(skipped.status).toBe(201);
    expect(skipped.body.applied.accountId).toBeUndefined();
    expect(skipped.body.contact.accountId ?? null).toBeNull();
  });
});

describe('signed inbound webhooks', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@inbound.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];
  let ownerAgent: request.Agent;
  let secret: string;

  const sign = (payload: unknown): string =>
    createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

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
        orgName: `Inbound Org ${runId}`,
        name: 'Nina Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const rotated = await ownerAgent.post('/v1/inbound/secret/rotate').send({});
    expect(rotated.status).toBe(201);
    secret = rotated.body.secret as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('rejects bad signatures and unknown sources', async () => {
    const payload = { event: 'contact.upserted', contact: { email: `x-${runId}@example.com` } };
    const bad = await request(server)
      .post('/v1/inbound/webform')
      .set('x-webhook-signature', 'deadbeef')
      .send(payload);
    expect(bad.status).toBe(401);

    const unknown = await request(server).post('/v1/inbound/BADSOURCE!!').send(payload);
    expect(unknown.status).toBe(400);
  });

  it('upserts contacts by email with dedupe', async () => {
    const payload = {
      event: 'contact.upserted',
      contact: { name: 'Hook Hank', email: `hank-${runId}@example.com` },
    };
    const first = await request(server)
      .post('/v1/inbound/webform')
      .set('x-webhook-signature', sign(payload))
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.deduped).toBe(false);

    const second = await request(server)
      .post('/v1/inbound/webform')
      .set('x-webhook-signature', sign(payload))
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);
    expect(second.body.id).toBe(first.body.id);
  });

  it('logs activities with externalId dedupe', async () => {
    const payload = {
      event: 'activity.logged',
      externalId: `evt-${runId}-1`,
      activity: { type: 'call', subject: 'Intro call', email: `hank-${runId}@example.com` },
    };
    const first = await request(server)
      .post('/v1/inbound/dialer')
      .set('x-webhook-signature', sign(payload))
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.deduped).toBe(false);

    const second = await request(server)
      .post('/v1/inbound/dialer')
      .set('x-webhook-signature', sign(payload))
      .send(payload);
    expect(second.status).toBe(200);
    expect(second.body.deduped).toBe(true);
  });
});

describe('devices and push registration', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@devices.test`;

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
        orgName: `Devices Org ${runId}`,
        name: 'Dev Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('registers idempotently, validates, lists, and removes', async () => {
    const token = `web-token-${runId}-abc123`;
    const first = await ownerAgent.post('/v1/devices').send({ token, platform: 'web' });
    expect(first.status).toBe(201);
    const again = await ownerAgent.post('/v1/devices').send({ token, platform: 'web' });
    expect(again.status).toBe(201);
    expect(again.body.device.id).toBe(first.body.device.id);

    const short = await ownerAgent.post('/v1/devices').send({ token: 'abc' });
    expect(short.status).toBe(400);

    const badPlatform = await ownerAgent
      .post('/v1/devices')
      .send({ token: `other-${runId}-token9`, platform: 'pager' });
    expect(badPlatform.status).toBe(400);

    const listed = await ownerAgent.get('/v1/devices');
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ id: string }>).some((d) => d.id === first.body.device.id)).toBe(
      true,
    );

    const removed = await ownerAgent.delete(`/v1/devices/${first.body.device.id}`).send();
    expect(removed.status).toBe(200);
    const relisted = await ownerAgent.get('/v1/devices');
    expect(
      (relisted.body as Array<{ id: string }>).some((d) => d.id === first.body.device.id),
    ).toBe(false);
  });
});

describe('sla policies, breaches, and cohort reports', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@slacohort.test`;

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
        orgName: `SLA Org ${runId}`,
        name: 'Sally Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('flags backdated open leads and deals as breaches', async () => {
    const policy = await ownerAgent.post('/v1/sla-policies').send({
      name: 'First touch 1h',
      entity: 'lead',
      metric: 'first_response',
      hours: 1,
    });
    expect(policy.status).toBe(201);

    const dealPolicy = await ownerAgent.post('/v1/sla-policies').send({
      name: 'Close in a day',
      entity: 'deal',
      metric: 'resolution',
      hours: 24,
    });
    expect(dealPolicy.status).toBe(201);

    const lead = await ownerAgent.post('/v1/leads').send({
      name: 'Stale Sal',
      email: `sal-${runId}@example.com`,
    });
    expect(lead.status).toBe(201);
    const deal = await ownerAgent
      .post('/v1/deals')
      .send({ name: `Stale Deal ${runId}`, amount: 5000 });
    expect(deal.status).toBe(201);

    await authDb.query(`UPDATE leads SET created_at = now() - interval '5 hours' WHERE id = $1`, [
      lead.body.lead.id as string,
    ]);
    await authDb.query(`UPDATE deals SET created_at = now() - interval '30 hours' WHERE id = $1`, [
      deal.body.deal.id as string,
    ]);

    const breaches = await ownerAgent.get('/v1/sla-policies/breaches/list');
    expect(breaches.status).toBe(200);
    const rows = breaches.body.breaches as Array<{
      entity: string;
      recordId: string;
      hoursOverdue: number;
    }>;
    const leadBreach = rows.find((b) => b.recordId === (lead.body.lead.id as string));
    expect(leadBreach).toBeDefined();
    expect(leadBreach?.hoursOverdue).toBeGreaterThan(3);
    const dealBreach = rows.find((b) => b.recordId === (deal.body.deal.id as string));
    expect(dealBreach).toBeDefined();
    expect(dealBreach?.hoursOverdue).toBeGreaterThan(5);

    const updated = await ownerAgent
      .patch(`/v1/sla-policies/${policy.body.policy.id}`)
      .send({ isActive: false });
    expect(updated.status).toBe(200);
    const quiet = await ownerAgent.get('/v1/sla-policies/breaches/list');
    expect(
      (quiet.body.breaches as Array<{ recordId: string }>).some(
        (b) => b.recordId === (lead.body.lead.id as string),
      ),
    ).toBe(false);
  });

  it('serves cohort and weekly trend aggregates', async () => {
    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Cohort Carl',
      email: `carl-${runId}@example.com`,
    });
    expect(contact.status).toBe(201);
    const cohorts = await ownerAgent.get('/v1/reports/cohorts');
    expect(cohorts.status).toBe(200);
    expect(Array.isArray(cohorts.body.data.cohorts)).toBe(true);
    expect(Array.isArray(cohorts.body.data.weeklyTrend)).toBe(true);
    expect(cohorts.body.data.cohorts.length).toBeGreaterThan(0);
    const current = (cohorts.body.data.cohorts as Array<{ size: number }>).reduce(
      (sum, c) => sum + c.size,
      0,
    );
    expect(current).toBeGreaterThanOrEqual(1);
  });

  it('exposes source mapping templates for imports', async () => {
    const templates = await ownerAgent.get('/v1/imports/mapping-templates');
    expect(templates.status).toBe(200);
    const sources = (templates.body as Array<{ source: string }>).map((t) => t.source);
    expect(sources).toEqual(expect.arrayContaining(['hubspot', 'pipedrive', 'salesforce']));
  });
});
