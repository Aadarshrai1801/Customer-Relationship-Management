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

describe('tasks core crud, scoping, reminders, and activity logging', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@tasks.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let repAgent: request.Agent;
  let ownerId: string;
  let repId: string;
  let contactId: string;
  let taskId: string;

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
        orgName: `Tasks Org ${runId}`,
        name: 'Tina Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerId = signup.body.user.id as string;
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const rep = await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    repId = rep.id;
    repAgent = await loginAgent(server, email('rep'), 'member-pass-12');

    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Tasky Person',
      email: `tasky-${runId}@example.test`,
    });
    expect(contact.status).toBe(201);
    contactId = contact.body.contact.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('creates a task defaulting ownership to the caller', async () => {
    const created = await ownerAgent.post('/v1/tasks').send({
      title: 'Follow up on proposal',
      contactId,
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(created.status).toBe(201);
    taskId = created.body.task.id as string;
    expect(created.body.task.title).toBe('Follow up on proposal');
    expect(created.body.task.status).toBe('open');
    expect(created.body.task.priority).toBe('normal');
    expect(created.body.task.overdue).toBe(false);
    expect(created.body.task.contact?.id).toBe(contactId);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'task.created', entityId: taskId });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('rejects invalid task input', async () => {
    const blank = await ownerAgent.post('/v1/tasks').send({ title: '' });
    expect(blank.status).toBe(400);

    const badStatus = await ownerAgent.post('/v1/tasks').send({ title: 'x', status: 'done' });
    expect(badStatus.status).toBe(400);

    const badLink = await ownerAgent.post('/v1/tasks').send({
      title: 'x',
      contactId: '00000000-0000-4000-8000-000000000000',
    });
    expect(badLink.status).toBe(404);

    const nonMember = await ownerAgent.post('/v1/tasks').send({
      title: 'x',
      ownerId: '00000000-0000-4000-8000-000000000000',
    });
    expect(nonMember.status).toBe(400);
    expect(nonMember.body.code).toBe('OWNER_NOT_MEMBER');
  });

  it('enforces own/all record scoping between owner and rep', async () => {
    const repTask = await repAgent.post('/v1/tasks').send({ title: 'Rep private task' });
    expect(repTask.status).toBe(201);
    const repTaskId = repTask.body.task.id as string;

    // Rep cannot see the owner's task.
    const blocked = await repAgent.get(`/v1/tasks/${taskId}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('RECORD_FORBIDDEN');

    // Owner (all) can see the rep's task.
    const visible = await ownerAgent.get(`/v1/tasks/${repTaskId}`);
    expect(visible.status).toBe(200);

    // Rep listing only returns their own.
    const listed = await repAgent.get('/v1/tasks');
    expect(listed.status).toBe(200);
    const ids = (listed.body.tasks as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain(repTaskId);
    expect(ids).not.toContain(taskId);

    // Rep cannot assign tasks to others without users:manage.
    const escalate = await repAgent.post('/v1/tasks').send({ title: 'sneaky', ownerId });
    expect(escalate.status).toBe(403);
    expect(escalate.body.code).toBe('SCOPE_FORBIDDEN');
  });

  it('completes idempotently and auto-logs a task activity', async () => {
    const first = await ownerAgent.post(`/v1/tasks/${taskId}/complete`).send();
    expect(first.status).toBe(201);
    expect(first.body.changed).toBe(true);
    expect(first.body.task.status).toBe('completed');
    expect(first.body.task.completedAt).not.toBeNull();

    const second = await ownerAgent.post(`/v1/tasks/${taskId}/complete`).send();
    expect(second.status).toBe(201);
    expect(second.body.changed).toBe(false);

    const logged = await ownerAgent.get('/v1/activities').query({ taskId });
    expect(logged.status).toBe(200);
    expect(logged.body.activities.length).toBe(1);
    expect(logged.body.activities[0].type).toBe('task');
  });

  it('filters overdue and due reminders', async () => {
    const overdue = await ownerAgent.post('/v1/tasks').send({
      title: 'Overdue item',
      dueAt: new Date(Date.now() - 3600000).toISOString(),
    });
    expect(overdue.status).toBe(201);
    expect(overdue.body.task.overdue).toBe(true);

    const reminder = await ownerAgent.post('/v1/tasks').send({
      title: 'Reminder item',
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      remindAt: new Date(Date.now() - 60000).toISOString(),
    });
    expect(reminder.status).toBe(201);
    expect(reminder.body.task.reminderDue).toBe(true);

    const overdueList = await ownerAgent.get('/v1/tasks').query({ overdue: 'true' });
    expect(overdueList.status).toBe(200);
    const overdueTitles = (overdueList.body.tasks as Array<{ title: string }>).map((t) => t.title);
    expect(overdueTitles).toContain('Overdue item');
    expect(overdueTitles).not.toContain('Follow up on proposal');

    const reminderList = await ownerAgent.get('/v1/tasks').query({ remindersDue: 'true' });
    expect(reminderList.status).toBe(200);
    const reminderTitles = (reminderList.body.tasks as Array<{ title: string }>).map(
      (t) => t.title,
    );
    expect(reminderTitles).toContain('Reminder item');

    const badCursor = await ownerAgent.get('/v1/tasks').query({ cursor: 'nope' });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.code).toBe('INVALID_CURSOR');
  });

  it('logs call and meeting activities against a contact', async () => {
    const call = await ownerAgent.post('/v1/activities').send({
      type: 'call',
      subject: 'Discovery call',
      body: 'Discussed requirements.',
      contactId,
    });
    expect(call.status).toBe(201);
    expect(call.body.activity.type).toBe('call');

    const meeting = await ownerAgent.post('/v1/activities').send({
      type: 'meeting',
      subject: 'Onsite workshop',
      contactId,
    });
    expect(meeting.status).toBe(201);

    const badType = await ownerAgent.post('/v1/activities').send({ type: 'carrier-pigeon' });
    expect(badType.status).toBe(400);

    const listed = await ownerAgent.get('/v1/activities').query({ contactId, type: 'call' });
    expect(listed.status).toBe(200);
    expect(listed.body.activities.length).toBe(1);
    expect(listed.body.activities[0].subject).toBe('Discovery call');

    const repSeesNothing = await repAgent.get('/v1/activities').query({ contactId });
    expect(repSeesNothing.status).toBe(200);
    expect(repSeesNothing.body.activities.length).toBe(0);
  });

  it('soft-deletes tasks and hides them from lists', async () => {
    const created = await ownerAgent.post('/v1/tasks').send({ title: 'Doomed task' });
    const doomedId = created.body.task.id as string;
    const removed = await ownerAgent.delete(`/v1/tasks/${doomedId}`).send();
    expect(removed.status).toBe(200);

    const gone = await ownerAgent.get(`/v1/tasks/${doomedId}`);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('TASK_NOT_FOUND');

    const listed = await ownerAgent.get('/v1/tasks').query({ limit: 200 });
    expect(listed.status).toBe(200);
    const ids = (listed.body.tasks as Array<{ id: string }>).map((t) => t.id);
    expect(ids).not.toContain(doomedId);
  });

  it('surfaces logged activities on the contact timeline', async () => {
    const logged = await ownerAgent.post('/v1/activities').send({
      type: 'meeting',
      subject: 'Timeline sync check',
      contactId,
    });
    expect(logged.status).toBe(201);

    const timeline = await ownerAgent.get(`/v1/contacts/${contactId}/timeline`);
    expect(timeline.status).toBe(200);
    const entry = (
      timeline.body.items as Array<{ type: string; summary: string; data: Record<string, unknown> }>
    ).find((i) => i.type === 'activity_logged');
    expect(entry).toBeDefined();
    expect(entry!.summary).toContain('Timeline sync check');
    expect(entry!.data['activityType']).toBe('meeting');
  });
});
