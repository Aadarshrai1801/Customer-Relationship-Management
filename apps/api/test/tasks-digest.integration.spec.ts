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

describe('task reminder digest batching', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@digest.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let repAgent: request.Agent;

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
        orgName: `Digest Org ${runId}`,
        name: 'Dana Owner',
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
    repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('batches due reminders and overdue tasks into one notification per owner', async () => {
    const past = new Date(Date.now() - 3600000).toISOString();
    const future = new Date(Date.now() + 86400000).toISOString();

    const reminder = await ownerAgent.post('/v1/tasks').send({
      title: 'Digest reminder',
      remindAt: past,
      dueAt: future,
    });
    expect(reminder.status).toBe(201);

    const overdue = await ownerAgent.post('/v1/tasks').send({
      title: 'Digest overdue',
      dueAt: past,
    });
    expect(overdue.status).toBe(201);

    const later = await ownerAgent.post('/v1/tasks').send({
      title: 'Not yet due',
      remindAt: future,
      dueAt: future,
    });
    expect(later.status).toBe(201);

    const dispatch = await ownerAgent.post('/v1/tasks/reminders/dispatch').send();
    expect(dispatch.status).toBe(201);
    expect(dispatch.body.ownersNotified).toBe(1);
    expect(dispatch.body.tasksIncluded).toBe(2);

    const notifs = await ownerAgent.get('/v1/notifications');
    expect(notifs.status).toBe(200);
    const digest = (notifs.body.items as Array<{ type: string; title: string; body: string }>).find(
      (n) => n.type === 'task_digest',
    );
    expect(digest).toBeDefined();
    expect(digest!.title).toContain('2 tasks');
    expect(digest!.body).toContain('Digest reminder');
    expect(digest!.body).toContain('Digest overdue');
    expect(digest!.body).not.toContain('Not yet due');

    const stamped = await ownerAgent.get(`/v1/tasks/${reminder.body.task.id as string}`);
    expect(stamped.body.reminderSentAt).not.toBeNull();
  });

  it('does not re-alert the same day (no spam)', async () => {
    const again = await ownerAgent.post('/v1/tasks/reminders/dispatch').send();
    expect(again.status).toBe(201);
    expect(again.body.ownersNotified).toBe(0);
    expect(again.body.tasksIncluded).toBe(0);

    const notifs = await ownerAgent.get('/v1/notifications');
    const digests = (notifs.body.items as Array<{ type: string }>).filter(
      (n) => n.type === 'task_digest',
    );
    expect(digests.length).toBe(1);
  });

  it('notifies each owner separately for their own tasks', async () => {
    const repTask = await repAgent.post('/v1/tasks').send({
      title: 'Rep reminder',
      remindAt: new Date(Date.now() - 60000).toISOString(),
    });
    expect(repTask.status).toBe(201);

    const dispatch = await ownerAgent.post('/v1/tasks/reminders/dispatch').send();
    expect(dispatch.body.ownersNotified).toBe(1);
    expect(dispatch.body.tasksIncluded).toBe(1);

    const repNotifs = await repAgent.get('/v1/notifications');
    const digest = (repNotifs.body.items as Array<{ type: string; body: string }>).find(
      (n) => n.type === 'task_digest',
    );
    expect(digest).toBeDefined();
    expect(digest!.body).toContain('Rep reminder');
  });

  it('requires task management scope to dispatch', async () => {
    const viewer = await inviteAndAcceptAgent();
    const blocked = await viewer.post('/v1/tasks/reminders/dispatch').send();
    expect(blocked.status).toBe(403);

    async function inviteAndAcceptAgent(): Promise<request.Agent> {
      const address = email('viewer');
      await inviteAndAccept(server, ownerAgent, {
        email: address,
        roleKey: 'viewer',
        name: 'Vera Viewer',
      });
      return loginAgent(server, address, 'member-pass-12');
    }
  });
});
