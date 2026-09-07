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

describe('onboarding checklist status', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@onboarding.test`;

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
        orgName: `Onboarding Org ${runId}`,
        name: 'Owen Owner',
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

  function byKey(body: { steps: Array<{ key: string; done: boolean }> }, key: string): boolean {
    return body.steps.find((s) => s.key === key)?.done ?? false;
  }

  it('starts empty for a fresh workspace', async () => {
    const res = await ownerAgent.get('/v1/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.doneCount).toBe(0);
    expect(res.body.complete).toBe(false);
    expect(res.body.steps.map((s: { key: string }) => s.key)).toEqual([
      'team',
      'pipeline',
      'contact',
      'deal',
      'customize',
    ]);
    expect(byKey(res.body, 'team')).toBe(false);
  });

  it('flips contact, deal, and pipeline steps through real usage', async () => {
    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'First Friend',
      email: `first-${runId}@example.test`,
    });
    expect(contact.status).toBe(201);

    const deal = await ownerAgent.post('/v1/deals').send({ name: 'First Deal', amount: 100 });
    expect(deal.status).toBe(201);
    const dealId = deal.body.deal.id as string;

    let res = await ownerAgent.get('/v1/onboarding/status');
    expect(byKey(res.body, 'contact')).toBe(true);
    expect(byKey(res.body, 'deal')).toBe(true);
    expect(byKey(res.body, 'pipeline')).toBe(false);
    expect(res.body.doneCount).toBe(2);

    // Moving the deal out of the first stage works the pipeline.
    const pipes = await ownerAgent.get('/v1/pipelines');
    const proposal = (pipes.body[0].stages as Array<{ key: string; id: string }>).find(
      (s) => s.key === 'proposal',
    );
    const moved = await ownerAgent.post(`/v1/deals/${dealId}/stage`).send({
      stageId: proposal!.id,
    });
    expect(moved.status).toBe(201);

    res = await ownerAgent.get('/v1/onboarding/status');
    expect(byKey(res.body, 'pipeline')).toBe(true);
  });

  it('flips team and customize steps, then completes', async () => {
    await inviteAndAccept(server, ownerAgent, {
      email: email('mate'),
      roleKey: 'rep',
      name: 'Marta Mate',
    });
    const field = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'nickname',
      label: 'Nickname',
      type: 'text',
    });
    expect(field.status).toBe(201);

    const res = await ownerAgent.get('/v1/onboarding/status');
    expect(byKey(res.body, 'team')).toBe(true);
    expect(byKey(res.body, 'customize')).toBe(true);
    expect(res.body.doneCount).toBe(5);
    expect(res.body.complete).toBe(true);
  });

  it('is visible to viewers without special scopes', async () => {
    const viewerAddr = email('viewer');
    await inviteAndAccept(server, ownerAgent, {
      email: viewerAddr,
      roleKey: 'viewer',
      name: 'Vera Viewer',
    });
    const viewerAgent = await loginAgent(server, viewerAddr, 'member-pass-12');
    const res = await viewerAgent.get('/v1/onboarding/status');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
  });
});
