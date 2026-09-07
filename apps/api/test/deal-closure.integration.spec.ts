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
import { loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';

describe('deal won/lost closed loop and deletion guards', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@closure.test`;
  const contactEmail = (tag: string): string => `${tag}-${runId}@example.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  const stageIds: Record<string, string> = {};

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
        orgName: `Closure Org ${runId}`,
        name: 'Cora Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const pipelines = await ownerAgent.get('/v1/pipelines');
    for (const stage of pipelines.body[0].stages as Array<{ key: string; id: string }>) {
      stageIds[stage.key] = stage.id;
    }
    void app.get(PipelinesService);
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('requires a loss reason to close as lost', async () => {
    const created = await ownerAgent.post('/v1/deals').send({ name: 'Doomed', amount: 5000 });
    const id = created.body.deal.id as string;

    const bare = await ownerAgent.post(`/v1/deals/${id}/stage`).send({
      stageId: stageIds['closed-lost'],
    });
    expect(bare.status).toBe(400);
    expect(bare.body.code).toBe('LOSS_REASON_REQUIRED');

    const closed = await ownerAgent.post(`/v1/deals/${id}/stage`).send({
      stageId: stageIds['closed-lost'],
      lossReason: 'Chose a competitor',
    });
    expect(closed.status).toBe(201);
    expect(closed.body.changed).toBe(true);
    expect(closed.body.deal.status).toBe('lost');
    expect(closed.body.deal.lossReason).toBe('Chose a competitor');
    expect(closed.body.deal.closedAt).not.toBeNull();
    expect(closed.body.deal.effectiveProbability).toBe(0);
  });

  it('accepts a previously stored loss reason without re-prompting', async () => {
    const created = await ownerAgent.post('/v1/deals').send({ name: 'Relapser', amount: 100 });
    const id = created.body.deal.id as string;
    await ownerAgent.post(`/v1/deals/${id}/stage`).send({
      stageId: stageIds['closed-lost'],
      lossReason: 'Budget frozen',
    });
    await ownerAgent.post(`/v1/deals/${id}/stage`).send({ stageId: stageIds['proposal'] });
    const relost = await ownerAgent.post(`/v1/deals/${id}/stage`).send({
      stageId: stageIds['closed-lost'],
    });
    expect(relost.status).toBe(201);
    expect(relost.body.deal.lossReason).toBe('Budget frozen');
  });

  it('rejects creating directly in Closed Lost without a reason', async () => {
    const bare = await ownerAgent.post('/v1/deals').send({
      name: 'Born Lost',
      amount: 10,
      stageId: stageIds['closed-lost'],
    });
    expect(bare.status).toBe(400);
    expect(bare.body.code).toBe('LOSS_REASON_REQUIRED');

    const explained = await ownerAgent.post('/v1/deals').send({
      name: 'Born Lost Explained',
      amount: 10,
      stageId: stageIds['closed-lost'],
      lossReason: 'Duplicate entry',
    });
    expect(explained.status).toBe(201);
    expect(explained.body.deal.status).toBe('lost');
  });

  it('logs the win on the contact timeline and advances lifecycle', async () => {
    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Winner Person',
      email: contactEmail('winner'),
      lifecycleStage: 'sql',
    });
    const deal = await ownerAgent.post('/v1/deals').send({
      name: 'Big Win',
      amount: 25000,
      contactId: contact.body.contact.id as string,
    });
    const id = deal.body.deal.id as string;

    const won = await ownerAgent.post(`/v1/deals/${id}/stage`).send({
      stageId: stageIds['closed-won'],
    });
    expect(won.status).toBe(201);
    expect(won.body.deal.status).toBe('won');

    const timeline = await ownerAgent.get(
      `/v1/contacts/${contact.body.contact.id as string}/timeline`,
    );
    const note = (
      timeline.body.items as Array<{ type: string; data: Record<string, unknown> }>
    ).find((i) => i.type === 'note_added');
    expect(note).toBeDefined();
    expect(note!.data['body']).toContain('Big Win');
    expect(note!.data['body']).toContain('25000');

    const updated = await ownerAgent.get(`/v1/contacts/${contact.body.contact.id as string}`);
    expect(updated.body.lifecycleStage).toBe('customer');

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'contact.updated', entityId: contact.body.contact.id });
    const lifecycle = audit.body.entries.find(
      (e: { newValues: Record<string, unknown> }) =>
        (e.newValues as Record<string, unknown>)?.lifecycleStage === 'customer',
    );
    expect(lifecycle).toBeDefined();
  });

  it('closes won without a contact cleanly', async () => {
    const deal = await ownerAgent.post('/v1/deals').send({ name: 'Solo Win', amount: 99 });
    const won = await ownerAgent
      .post(`/v1/deals/${deal.body.deal.id as string}/stage`)
      .send({ stageId: stageIds['closed-won'] });
    expect(won.status).toBe(201);
    expect(won.body.deal.status).toBe('won');
  });

  it('blocks account deletion while open deals exist', async () => {
    const account = await ownerAgent.post('/v1/accounts').send({ name: 'Guarded Co' });
    const accountId = account.body.account.id as string;
    await ownerAgent.post('/v1/deals').send({
      name: 'Guarded Deal',
      amount: 1000,
      accountId,
    });

    const blocked = await ownerAgent.delete(`/v1/accounts/${accountId}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ACCOUNT_HAS_OPEN_DEALS');

    const stillThere = await ownerAgent.get(`/v1/accounts/${accountId}`);
    expect(stillThere.status).toBe(200);
  });

  it('allows account deletion once its deals are closed', async () => {
    const account = await ownerAgent.post('/v1/accounts').send({ name: 'Free Co' });
    const accountId = account.body.account.id as string;
    const deal = await ownerAgent.post('/v1/deals').send({
      name: 'Finished Deal',
      amount: 1000,
      accountId,
    });
    await ownerAgent.post(`/v1/deals/${deal.body.deal.id as string}/stage`).send({
      stageId: stageIds['closed-won'],
    });

    const removed = await ownerAgent.delete(`/v1/accounts/${accountId}`);
    expect(removed.status).toBe(200);
  });

  it('warns on contact deletion with open deals and proceeds on confirm', async () => {
    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Guarded Person',
      email: contactEmail('guarded'),
    });
    const contactId = contact.body.contact.id as string;
    await ownerAgent.post('/v1/deals').send({
      name: 'Guarded Contact Deal',
      amount: 500,
      contactId,
    });

    const warned = await ownerAgent.delete(`/v1/contacts/${contactId}`);
    expect(warned.status).toBe(409);
    expect(warned.body.code).toBe('CONTACT_HAS_OPEN_DEALS');

    const confirmed = await ownerAgent.delete(`/v1/contacts/${contactId}?confirm=true`);
    expect(confirmed.status).toBe(200);
    const gone = await ownerAgent.get(`/v1/contacts/${contactId}`);
    expect(gone.status).toBe(404);
  });
});
