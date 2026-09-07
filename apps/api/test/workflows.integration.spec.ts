import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { findEmail, inviteAndAccept, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';

async function waitRuns(
  agent: request.Agent,
  workflowId: string,
  count: number,
  timeoutMs = 20000,
): Promise<Array<{ status: string; error: string | null }>> {
  const started = Date.now();
  for (;;) {
    const res = await agent.get(`/v1/workflows/${workflowId}/runs`).query({ limit: 100 });
    if (res.status === 200 && (res.body.runs as Array<unknown>).length >= count) {
      return res.body.runs as Array<{ status: string; error: string | null }>;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${count} runs (got ${res.status})`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('workflows automation engine', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@workflows.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;

  const webhookHits: Array<{ url: string; body: Record<string, unknown> }> = [];
  let hookServer: HttpServer;
  let hookPort = 0;

  beforeAll(async () => {
    hookServer = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => {
        try {
          webhookHits.push({ url: req.url ?? '', body: JSON.parse(data || '{}') });
        } catch {
          webhookHits.push({ url: req.url ?? '', body: {} });
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
    hookPort = (hookServer.address() as AddressInfo).port;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    authDb = new Pool({ connectionString: AUTH_DATABASE_URL });

    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Workflows Org ${runId}`,
        name: 'Wendy Owner',
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

    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Workflow Person',
      email: `wflow-${runId}@example.test`,
    });
    expect(contact.status).toBe(201);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => hookServer.close(() => resolve()));
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('validates workflow definitions and gates scopes', async () => {
    const created = await ownerAgent.post('/v1/workflows').send({
      name: 'Welcome tasks',
      trigger: { kind: 'record.created', entity: 'contact' },
      actions: [{ type: 'create_task', title: 'Welcome {{name}}' }],
    });
    expect(created.status).toBe(201);
    expect(created.body.workflow.trigger.kind).toBe('record.created');

    const noActions = await ownerAgent.post('/v1/workflows').send({
      name: 'Empty',
      trigger: { kind: 'record.created', entity: 'contact' },
      actions: [],
    });
    expect(noActions.status).toBe(400);

    const badTrigger = await ownerAgent.post('/v1/workflows').send({
      name: 'Bad',
      trigger: { kind: 'field.changed', entity: 'deal' },
      actions: [{ type: 'create_task', title: 'x' }],
    });
    expect(badTrigger.status).toBe(400);

    const badAction = await ownerAgent.post('/v1/workflows').send({
      name: 'Bad action',
      trigger: { kind: 'record.created', entity: 'contact' },
      actions: [{ type: 'launch_rockets' }],
    });
    expect(badAction.status).toBe(400);

    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const repBlocked = await repAgent.post('/v1/workflows').send({
      name: 'Sneaky',
      trigger: { kind: 'record.created', entity: 'contact' },
      actions: [{ type: 'create_task', title: 'x' }],
    });
    expect(repBlocked.status).toBe(403);

    const repList = await repAgent.get('/v1/workflows');
    expect(repList.status).toBe(403);
  });

  it('creates tasks when contacts are created', async () => {
    const rule = await ownerAgent.post('/v1/workflows').send({
      name: 'Contact welcome',
      trigger: { kind: 'record.created', entity: 'contact' },
      actions: [{ type: 'create_task', title: 'Welcome new contact', priority: 'high' }],
    });
    const workflowId = rule.body.workflow.id as string;

    const contact = await ownerAgent.post('/v1/contacts').send({
      name: `Trigger Person ${runId}`,
      email: `trigger-${runId}@example.test`,
    });
    expect(contact.status).toBe(201);

    const runs = await waitRuns(ownerAgent, workflowId, 1);
    expect(runs[0]!.status).toBe('success');

    const tasks = await ownerAgent.get('/v1/tasks').query({ limit: 200 });
    const titles = (tasks.body.tasks as Array<{ title: string }>).map((t) => t.title);
    expect(titles).toContain('Welcome new contact');
  });

  it('filters by conditions and updates deal fields', async () => {
    const rule = await ownerAgent.post('/v1/workflows').send({
      name: 'Big deal commit',
      trigger: { kind: 'field.changed', entity: 'deal', field: 'probability' },
      conditions: [{ field: 'amount', operator: 'greater_than', value: 100000 }],
      actions: [
        { type: 'update_field', entity: 'deal', field: 'forecastCategory', value: 'commit' },
      ],
    });
    const workflowId = rule.body.workflow.id as string;

    const small = await ownerAgent.post('/v1/deals').send({ name: `Small ${runId}`, amount: 10 });
    await ownerAgent.patch(`/v1/deals/${small.body.deal.id as string}`).send({ probability: 80 });
    // No run: condition fails.
    await new Promise((r) => setTimeout(r, 1500));
    const quiet = await ownerAgent.get(`/v1/workflows/${workflowId}/runs`);
    expect(quiet.body.runs.length).toBe(0);

    const big = await ownerAgent.post('/v1/deals').send({ name: `Big ${runId}`, amount: 200000 });
    const bigId = big.body.deal.id as string;
    await ownerAgent.patch(`/v1/deals/${bigId}`).send({ probability: 80 });

    const runs = await waitRuns(ownerAgent, workflowId, 1);
    expect(runs[0]!.status).toBe('success');

    const updated = await ownerAgent.get(`/v1/deals/${bigId}`);
    expect(updated.body.forecastCategory).toBe('commit');
  });

  it('sends owner email on stage changes into a target stage', async () => {
    const rule = await ownerAgent.post('/v1/workflows').send({
      name: 'Proposal alert',
      trigger: { kind: 'stage.changed', entity: 'deal', toStageKey: 'proposal' },
      actions: [
        { type: 'send_email', to: 'owner', subject: `Proposal ${runId}`, body: 'Deal moved.' },
      ],
    });
    const workflowId = rule.body.workflow.id as string;

    const pipes = await ownerAgent.get('/v1/pipelines');
    const proposal = (pipes.body[0].stages as Array<{ key: string; id: string }>).find(
      (s) => s.key === 'proposal',
    );
    const deal = await ownerAgent.post('/v1/deals').send({ name: `Stagey ${runId}`, amount: 5 });
    await ownerAgent.post(`/v1/deals/${deal.body.deal.id as string}/stage`).send({
      stageId: proposal!.id,
    });

    const runs = await waitRuns(ownerAgent, workflowId, 1);
    expect(runs[0]!.status).toBe('success');

    const delivered = await findEmail(email('owner'), `Proposal ${runId}`);
    expect(delivered.Text).toContain('Deal moved.');
  });

  it('calls webhooks with the event payload', async () => {
    const before = webhookHits.length;
    const rule = await ownerAgent.post('/v1/workflows').send({
      name: 'Deal webhook',
      trigger: { kind: 'record.created', entity: 'deal' },
      conditions: [{ field: 'name', operator: 'contains', value: `Hooky ${runId}` }],
      actions: [{ type: 'call_webhook', url: `http://127.0.0.1:${hookPort}/hook` }],
    });
    const workflowId = rule.body.workflow.id as string;

    await ownerAgent.post('/v1/deals').send({ name: `Hooky ${runId}`, amount: 7 });
    await waitRuns(ownerAgent, workflowId, 1);

    const hit = webhookHits.slice(before).find((h) => h.url === '/hook');
    expect(hit).toBeDefined();
    expect((hit!.body['event'] as Record<string, unknown>)['kind']).toBe('record.created');
    expect((hit!.body['workflow'] as Record<string, unknown>)['id']).toBe(workflowId);
  });

  it('records failed runs when actions are invalid', async () => {
    const rule = await ownerAgent.post('/v1/workflows').send({
      name: 'Bad writer',
      trigger: { kind: 'record.created', entity: 'task' },
      actions: [{ type: 'update_field', entity: 'task', field: 'ownerId', value: 'x' }],
    });
    const workflowId = rule.body.workflow.id as string;

    await ownerAgent.post('/v1/tasks').send({ title: `Failing ${runId}` });
    const runs = await waitRuns(ownerAgent, workflowId, 1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.error).toContain('not workflow-writable');

    const failed = await ownerAgent
      .get(`/v1/workflows/${workflowId}/runs`)
      .query({ status: 'failed' });
    expect((failed.body.runs as Array<unknown>).length).toBeGreaterThan(0);
  });

  it('stops self-triggering cascades at maxRuns', async () => {
    const rule = await ownerAgent.post('/v1/workflows').send({
      name: 'Priority echo',
      trigger: { kind: 'field.changed', entity: 'task', field: 'priority' },
      actions: [{ type: 'update_field', entity: 'task', field: 'priority', value: 'high' }],
      maxRuns: 2,
    });
    const workflowId = rule.body.workflow.id as string;

    const task = await ownerAgent.post('/v1/tasks').send({ title: `Echo ${runId}` });
    await ownerAgent.patch(`/v1/tasks/${task.body.task.id as string}`).send({ priority: 'low' });

    const runs = await waitRuns(ownerAgent, workflowId, 3);
    const statuses = runs.map((r) => r.status).sort();
    expect(statuses).toEqual(['skipped', 'success', 'success']);
  });

  it('fires time-based rules once per record via due scan', async () => {
    const task = await ownerAgent.post('/v1/tasks').send({ title: `Aging ${runId}` });
    const taskId = task.body.task.id as string;
    await authDb.query(`UPDATE tasks SET created_at = now() - interval '2 hours' WHERE id = $1`, [
      taskId,
    ]);

    const rule = await ownerAgent.post('/v1/workflows').send({
      name: 'Stale nudge',
      trigger: { kind: 'time.elapsed', entity: 'task', hoursAfter: 1 },
      conditions: [{ field: 'status', operator: 'equals', value: 'open' }],
      actions: [{ type: 'create_task', title: `Nudge ${runId}` }],
    });
    const workflowId = rule.body.workflow.id as string;

    const scan = await ownerAgent.post('/v1/workflows/due-scan').send();
    expect(scan.status).toBe(201);
    expect(scan.body.fired).toBeGreaterThanOrEqual(1);

    const runs = await waitRuns(ownerAgent, workflowId, 1);
    expect(runs[0]!.status).toBe('success');

    const again = await ownerAgent.post('/v1/workflows/due-scan').send();
    expect(again.status).toBe(201);
    const after = await ownerAgent.get(`/v1/workflows/${workflowId}/runs`);
    expect((after.body.runs as Array<unknown>).length).toBe(runs.length);
  });

  it('supports update, deactivation, and deletion', async () => {
    const rule = await ownerAgent.post('/v1/workflows').send({
      name: 'Toggle me',
      trigger: { kind: 'record.created', entity: 'contact' },
      actions: [{ type: 'create_task', title: 'Toggled' }],
    });
    const workflowId = rule.body.workflow.id as string;

    const updated = await ownerAgent.patch(`/v1/workflows/${workflowId}`).send({ isActive: false });
    expect(updated.status).toBe(200);
    expect(updated.body.workflow.isActive).toBe(false);

    await ownerAgent.post('/v1/contacts').send({
      name: `Quiet ${runId}`,
      email: `quiet-${runId}@example.test`,
    });
    await new Promise((r) => setTimeout(r, 1500));
    const runs = await ownerAgent.get(`/v1/workflows/${workflowId}/runs`);
    expect(runs.body.runs.length).toBe(0);

    const removed = await ownerAgent.delete(`/v1/workflows/${workflowId}`).send();
    expect(removed.status).toBe(200);
    const gone = await ownerAgent.get(`/v1/workflows/${workflowId}`);
    expect(gone.status).toBe(404);
  });
});
