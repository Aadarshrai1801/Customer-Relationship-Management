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
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5432/nexus';

describe('accounts', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@accounts.test`;

  let app: INestApplication;
  let server: Server;
  let db: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    db = new Pool({ connectionString: AUTH_DATABASE_URL });

    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Accounts ${runId}`,
        name: 'Ava Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'account',
      key: 'employees',
      label: 'Employees',
      type: 'number',
    });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  it('creates an account with domains, custom fields, and audit', async () => {
    const res = await ownerAgent.post('/v1/accounts').send({
      name: 'Acme Inc',
      website: 'https://acme.test',
      domains: ['acme.test', 'ACME.test'],
      industry: 'Software',
      customFields: { employees: 120 },
    });
    expect(res.status).toBe(201);
    expect(res.body.account.domains).toEqual(['acme.test']);
    expect(res.body.account.contactCount).toBe(0);
    expect(res.body.account.children).toEqual([]);
    expect(res.body.warnings).toEqual([]);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'account.created', entityId: res.body.account.id });
    expect(audit.body.entries).toHaveLength(1);
  });

  it('validates input and custom fields', async () => {
    const missing = await ownerAgent.post('/v1/accounts').send({ industry: 'X' });
    expect(missing.status).toBe(400);

    const badDomain = await ownerAgent.post('/v1/accounts').send({
      name: 'X',
      domains: ['not a domain!!'],
    });
    expect(badDomain.status).toBe(400);

    const badCustom = await ownerAgent.post('/v1/accounts').send({
      name: 'X',
      customFields: { employees: 'many' },
    });
    expect(badCustom.status).toBe(400);
    expect(badCustom.body.code).toBe('VALIDATION_ERROR');
  });

  it('builds parent-child hierarchies and rejects cycles', async () => {
    const parent = await ownerAgent.post('/v1/accounts').send({ name: 'Parent Co' });
    const child = await ownerAgent.post('/v1/accounts').send({
      name: 'Child Co',
      parentId: parent.body.account.id as string,
    });
    expect(child.status).toBe(201);
    expect(child.body.account.parent).toMatchObject({ id: parent.body.account.id });

    const detail = await ownerAgent.get(`/v1/accounts/${parent.body.account.id as string}`);
    expect(detail.body.children).toHaveLength(1);
    expect(detail.body.children[0].name).toBe('Child Co');

    const selfParent = await ownerAgent
      .patch(`/v1/accounts/${parent.body.account.id as string}`)
      .send({ parentId: parent.body.account.id as string });
    expect(selfParent.status).toBe(409);
    expect(selfParent.body.code).toBe('ACCOUNT_CYCLE');

    const cycle = await ownerAgent
      .patch(`/v1/accounts/${parent.body.account.id as string}`)
      .send({ parentId: child.body.account.id as string });
    expect(cycle.status).toBe(409);

    const grandchild = await ownerAgent.post('/v1/accounts').send({
      name: 'Grandchild Co',
      parentId: child.body.account.id as string,
    });
    const deepCycle = await ownerAgent
      .patch(`/v1/accounts/${parent.body.account.id as string}`)
      .send({ parentId: grandchild.body.account.id as string });
    expect(deepCycle.status).toBe(409);

    const unknownParent = await ownerAgent.post('/v1/accounts').send({
      name: 'Orphan',
      parentId: '00000000-0000-0000-0000-000000000000',
    });
    expect(unknownParent.status).toBe(404);
  });

  it('links contacts and reports the live contact count', async () => {
    const account = await ownerAgent.post('/v1/accounts').send({ name: 'Counted Co' });
    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Counted Person',
      email: `counted-${runId}@example.test`,
      accountId: account.body.account.id as string,
    });
    expect(contact.status).toBe(201);
    expect(contact.body.contact.account).toMatchObject({ id: account.body.account.id });

    const detail = await ownerAgent.get(`/v1/accounts/${account.body.account.id as string}`);
    expect(detail.body.contactCount).toBe(1);

    await ownerAgent.delete(`/v1/contacts/${contact.body.contact.id as string}`);
    const after = await ownerAgent.get(`/v1/accounts/${account.body.account.id as string}`);
    expect(after.body.contactCount).toBe(0);
  });

  it('enforces own/all record scoping on accounts', async () => {
    await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const mine = await repAgent.post('/v1/accounts').send({ name: 'Rep Account' });
    expect(mine.status).toBe(201);

    const repList = await repAgent.get('/v1/accounts');
    expect(repList.body.accounts.map((a: { id: string }) => a.id)).toEqual([mine.body.account.id]);

    const ownerList = await ownerAgent.get('/v1/accounts');
    expect(ownerList.body.accounts.length).toBeGreaterThan(1);

    const foreign = ownerList.body.accounts.find(
      (a: { id: string }) => a.id !== (mine.body.account.id as string),
    ) as { id: string };
    const denied = await repAgent.get(`/v1/accounts/${foreign.id}`);
    expect(denied.status).toBe(403);
  });

  it('updates, validates, and soft-deletes', async () => {
    const created = await ownerAgent.post('/v1/accounts').send({ name: 'Mutable Co' });
    const id = created.body.account.id as string;
    const updated = await ownerAgent.patch(`/v1/accounts/${id}`).send({
      industry: 'Finance',
      domains: ['mutable.test'],
      customFields: { employees: 50 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.industry).toBe('Finance');

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'account.updated', entityId: id });
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0].newValues.industry).toBe('Finance');

    const removed = await ownerAgent.delete(`/v1/accounts/${id}`);
    expect(removed.status).toBe(200);
    const gone = await ownerAgent.get(`/v1/accounts/${id}`);
    expect(gone.status).toBe(404);
  });

  it('requires accounts:manage for writes', async () => {
    await inviteAndAccept(server, ownerAgent, {
      email: email('viewer'),
      roleKey: 'viewer',
      name: 'Vicky Viewer',
    });
    const viewerAgent = await loginAgent(server, email('viewer'), 'member-pass-12');
    const create = await viewerAgent.post('/v1/accounts').send({ name: 'X' });
    expect(create.status).toBe(403);
  });
});
