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

describe('dashboards crud, layout validation, and scoping', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@dashboards.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let repAgent: request.Agent;

  const layout = [
    { key: 'forecast', type: 'forecast-summary', title: 'Forecast' },
    { key: 'funnel', type: 'pipeline-funnel' },
  ];

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
        orgName: `Dashboards Org ${runId}`,
        name: 'Dora Owner',
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

  it('creates dashboards with validated widget layouts', async () => {
    const created = await ownerAgent.post('/v1/dashboards').send({
      name: 'Sales overview',
      isDefault: true,
      layout,
    });
    expect(created.status).toBe(201);
    expect(created.body.dashboard.layout.length).toBe(2);

    const badType = await ownerAgent.post('/v1/dashboards').send({
      name: 'Bad widgets',
      layout: [{ key: 'x', type: 'teleporter' }],
    });
    expect(badType.status).toBe(400);

    const dupKeys = await ownerAgent.post('/v1/dashboards').send({
      name: 'Dup keys',
      layout: [
        { key: 'same', type: 'forecast-summary' },
        { key: 'same', type: 'activity-chart' },
      ],
    });
    expect(dupKeys.status).toBe(400);
    expect(dupKeys.body.code).toBe('DUPLICATE_WIDGET_KEY');

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'dashboard.created', entityId: created.body.dashboard.id });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('moves the default flag between dashboards', async () => {
    const second = await ownerAgent.post('/v1/dashboards').send({
      name: 'Second board',
      isDefault: true,
      layout: [],
    });
    expect(second.status).toBe(201);

    const listed = await ownerAgent.get('/v1/dashboards');
    const boards = listed.body.dashboards as Array<{
      id: string;
      name: string;
      isDefault: boolean;
    }>;
    expect(boards.filter((b) => b.isDefault).length).toBe(1);
    expect(boards.find((b) => b.isDefault)?.name).toBe('Second board');
  });

  it('enforces own/all scoping and validates cursors', async () => {
    const repBoard = await repAgent.post('/v1/dashboards').send({
      name: 'Rep board',
      layout: [{ key: 'a', type: 'conversion-funnel' }],
    });
    expect(repBoard.status).toBe(201);
    const repId = repBoard.body.dashboard.id as string;

    const ownerSees = await ownerAgent.get('/v1/dashboards');
    const ownerIds = (ownerSees.body.dashboards as Array<{ id: string }>).map((d) => d.id);
    expect(ownerIds).toContain(repId);

    const repSees = await repAgent.get('/v1/dashboards');
    const repIds = (repSees.body.dashboards as Array<{ id: string }>).map((d) => d.id);
    expect(repIds).toEqual([repId]);

    const blocked = await repAgent.get(
      `/v1/dashboards/${(ownerSees.body.dashboards as Array<{ id: string; name: string }>).find((d) => d.name === 'Sales overview')!.id}`,
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('RECORD_FORBIDDEN');

    const badCursor = await ownerAgent.get('/v1/dashboards').query({ cursor: 'bogus' });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.code).toBe('INVALID_CURSOR');
  });

  it('updates layouts and soft-deletes', async () => {
    const listed = await ownerAgent.get('/v1/dashboards');
    const target = (listed.body.dashboards as Array<{ id: string; name: string }>).find(
      (d) => d.name === 'Second board',
    );
    expect(target).toBeDefined();

    const updated = await ownerAgent.patch(`/v1/dashboards/${target!.id}`).send({
      layout: [...layout, { key: 'tasks', type: 'overdue-tasks', title: 'Stalled' }],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.dashboard.layout.length).toBe(3);

    const removed = await ownerAgent.delete(`/v1/dashboards/${target!.id}`).send();
    expect(removed.status).toBe(200);

    const gone = await ownerAgent.get(`/v1/dashboards/${target!.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('DASHBOARD_NOT_FOUND');
  });

  it('requires dashboard scopes', async () => {
    const viewerAddr = email('viewer');
    await inviteAndAccept(server, ownerAgent, {
      email: viewerAddr,
      roleKey: 'viewer',
      name: 'Vera Viewer',
    });
    const viewerAgent = await loginAgent(server, viewerAddr, 'member-pass-12');

    const blocked = await viewerAgent.post('/v1/dashboards').send({ name: 'Sneaky' });
    expect(blocked.status).toBe(403);

    const readable = await viewerAgent.get('/v1/dashboards');
    expect(readable.status).toBe(200);
  });
});
