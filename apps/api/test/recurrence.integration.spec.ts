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

describe('recurring tasks', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@recurrence.test`;

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
        orgName: `Recurrence Org ${runId}`,
        name: 'Rita Owner',
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

  it('validates recurrence rules', async () => {
    const badFreq = await ownerAgent.post('/v1/tasks').send({
      title: 'Bad rule',
      recurrence: { frequency: 'yearly' },
    });
    expect(badFreq.status).toBe(400);

    const badInterval = await ownerAgent.post('/v1/tasks').send({
      title: 'Bad interval',
      recurrence: { frequency: 'daily', interval: 99 },
    });
    expect(badInterval.status).toBe(400);
  });

  it('spawns the next daily occurrence on completion', async () => {
    const due = new Date('2026-03-10T09:00:00.000Z').toISOString();
    const created = await ownerAgent.post('/v1/tasks').send({
      title: `Standup ${runId}`,
      dueAt: due,
      recurrence: { frequency: 'daily', interval: 2 },
    });
    expect(created.status).toBe(201);
    expect(created.body.task.recurrence).toEqual({ frequency: 'daily', interval: 2 });
    const id = created.body.task.id as string;

    const done = await ownerAgent.post(`/v1/tasks/${id}/complete`).send();
    expect(done.status).toBe(201);
    expect(done.body.changed).toBe(true);
    expect(done.body.nextTaskId).not.toBeNull();

    const next = await ownerAgent.get(`/v1/tasks/${done.body.nextTaskId as string}`);
    expect(next.status).toBe(200);
    expect(next.body.status).toBe('open');
    expect(next.body.title).toBe(`Standup ${runId}`);
    expect(next.body.dueAt).toBe(new Date('2026-03-12T09:00:00.000Z').toISOString());
    expect(next.body.recurrence).toEqual({ frequency: 'daily', interval: 2 });
  });

  it('shifts monthly occurrences clamping to month-end', async () => {
    const created = await ownerAgent.post('/v1/tasks').send({
      title: `Month end ${runId}`,
      dueAt: new Date('2026-01-31T09:00:00.000Z').toISOString(),
      recurrence: { frequency: 'monthly' },
    });
    const done = await ownerAgent
      .post(`/v1/tasks/${created.body.task.id as string}/complete`)
      .send();
    const next = await ownerAgent.get(`/v1/tasks/${done.body.nextTaskId as string}`);
    // Feb 2026 has 28 days: clamped, not rolled into March.
    expect(new Date(next.body.dueAt as string).toISOString()).toBe(
      new Date('2026-02-28T09:00:00.000Z').toISOString(),
    );
  });

  it('does not recur without a rule and clears rules on PATCH', async () => {
    const plain = await ownerAgent.post('/v1/tasks').send({ title: `Plain ${runId}` });
    const done = await ownerAgent.post(`/v1/tasks/${plain.body.task.id as string}/complete`).send();
    expect(done.body.nextTaskId).toBeNull();

    const recurring = await ownerAgent.post('/v1/tasks').send({
      title: `Stoppable ${runId}`,
      recurrence: { frequency: 'weekly' },
    });
    const cleared = await ownerAgent
      .patch(`/v1/tasks/${recurring.body.task.id as string}`)
      .send({ recurrence: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.recurrence).toBeNull();
    const done2 = await ownerAgent
      .post(`/v1/tasks/${recurring.body.task.id as string}/complete`)
      .send();
    expect(done2.body.nextTaskId).toBeNull();
  });
});
