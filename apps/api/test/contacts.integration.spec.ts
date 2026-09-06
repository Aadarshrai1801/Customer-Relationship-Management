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

describe('contacts', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@contacts.test`;
  const contactEmail = (tag: string): string => `${tag}-${runId}@example.test`;

  let app: INestApplication;
  let server: Server;
  let db: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let ownerId: string;

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
        orgName: `Contacts ${runId}`,
        name: 'Cora Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerId = signup.body.user.id as string;
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    // Custom fields used across tests.
    await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'score',
      label: 'Score',
      type: 'number',
    });
    await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'tier',
      label: 'Tier',
      type: 'picklist',
      options: { options: ['gold', 'silver'] },
    });
    await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'double_score',
      label: 'Double',
      type: 'formula',
      options: { expression: '{score} * 2' },
    });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  it('creates a contact with defaults and audits the creation', async () => {
    const res = await ownerAgent.post('/v1/contacts').send({
      name: 'Ada Prospect',
      email: contactEmail('ada'),
    });
    expect(res.status).toBe(201);
    expect(res.body.contact.email).toBe(contactEmail('ada'));
    expect(res.body.contact.lifecycleStage).toBe('lead');
    expect(res.body.contact.ownerId).toBe(ownerId);
    expect(res.body.warnings).toEqual([]);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'contact.created', entityId: res.body.contact.id });
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0].newValues).toMatchObject({ email: contactEmail('ada') });
  });

  it('validates required fields, email shape, lifecycle, and custom values', async () => {
    const missing = await ownerAgent.post('/v1/contacts').send({ name: 'No Email' });
    expect(missing.status).toBe(400);

    const badEmail = await ownerAgent
      .post('/v1/contacts')
      .send({ name: 'X', email: 'not-an-email' });
    expect(badEmail.status).toBe(400);

    const badStage = await ownerAgent
      .post('/v1/contacts')
      .send({ name: 'X', email: contactEmail('x'), lifecycleStage: 'nonsense' });
    expect(badStage.status).toBe(400);

    const badCustom = await ownerAgent.post('/v1/contacts').send({
      name: 'X',
      email: contactEmail('y'),
      customFields: { score: 'high', tier: 'bronze', bogus: 1, double_score: 5 },
    });
    expect(badCustom.status).toBe(400);
    const paths = (badCustom.body.errors as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('customFields.score');
    expect(paths).toContain('customFields.tier');
    expect(paths).toContain('customFields.bogus');
    expect(paths).toContain('customFields.double_score');
  });

  it('round-trips custom fields with normalization and computed formulas', async () => {
    const res = await ownerAgent.post('/v1/contacts').send({
      name: 'Cal Custom',
      email: contactEmail('cal'),
      customFields: { score: 21, tier: 'gold' },
    });
    expect(res.status).toBe(201);
    expect(res.body.contact.customFields).toMatchObject({ score: 21, tier: 'gold' });
    expect(res.body.contact.computedFields).toMatchObject({ double_score: 42 });
    expect(res.body.contact).not.toHaveProperty('formulaErrors');

    const fetched = await ownerAgent.get(`/v1/contacts/${res.body.contact.id as string}`);
    expect(fetched.body.computedFields).toMatchObject({ double_score: 42 });
  });

  it('warns on duplicate email without blocking, scoped per org', async () => {
    const first = await ownerAgent.post('/v1/contacts').send({
      name: 'Dup One',
      email: contactEmail('dupe'),
    });
    expect(first.body.warnings).toEqual([]);
    const second = await ownerAgent.post('/v1/contacts').send({
      name: 'Dup Two',
      email: contactEmail('dupe'),
    });
    expect(second.status).toBe(201);
    expect(second.body.warnings).toHaveLength(1);
    expect(second.body.warnings[0].code).toBe('DUPLICATE_EMAIL');
    expect(second.body.warnings[0].contactIds).toEqual([first.body.contact.id]);

    const other = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Contacts Other ${runId}`,
        name: 'O',
        email: email('other'),
        password: 'correct-horse-12',
      });
    orgIds.push(other.body.org.id as string);
    const otherAgent = await loginAgent(server, email('other'), 'correct-horse-12');
    const foreign = await otherAgent.post('/v1/contacts').send({
      name: 'Foreign',
      email: contactEmail('dupe'),
    });
    expect(foreign.body.warnings).toEqual([]);
  });

  it('enforces record-level visibility (rep sees own, manager sees all)', async () => {
    const rep = await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const mine = await repAgent.post('/v1/contacts').send({
      name: 'Rep Contact',
      email: contactEmail('rep-contact'),
    });
    expect(mine.status).toBe(201);

    const repList = await repAgent.get('/v1/contacts');
    expect(repList.body.contacts.map((c: { id: string }) => c.id)).toEqual([mine.body.contact.id]);

    const manager = await inviteAndAccept(server, ownerAgent, {
      email: email('manager'),
      roleKey: 'manager',
      name: 'Manny Manager',
    });
    void manager;
    const managerAgent = await loginAgent(server, email('manager'), 'member-pass-12');
    const managerList = await managerAgent.get('/v1/contacts');
    expect(managerList.body.contacts.length).toBeGreaterThan(1);

    const foreign = await repAgent.get(`/v1/contacts/${mine.body.contact.id as string}`);
    expect(foreign.status).toBe(200);
    void rep;
  });

  it('denies cross-owner access for own-scoped roles', async () => {
    const rep2 = await inviteAndAccept(server, ownerAgent, {
      email: email('rep2'),
      roleKey: 'rep',
      name: 'Randy Rep',
    });
    const rep2Agent = await loginAgent(server, email('rep2'), 'member-pass-12');
    const theirs = await ownerAgent.post('/v1/contacts').send({
      name: 'Owner Contact',
      email: contactEmail('owner-contact'),
    });
    const blocked = await rep2Agent.get(`/v1/contacts/${theirs.body.contact.id as string}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('RECORD_FORBIDDEN');
    void rep2;
  });

  it('hides none-ruled fields from list and detail', async () => {
    const created = await ownerAgent.post('/v1/roles').send({
      key: 'noemail',
      name: 'No Email',
      permissions: {
        version: 1,
        scopes: ['users:read', 'contacts:read', 'contacts:manage'],
        recordAccess: { user: 'own', contact: 'all' },
        fields: { 'contact.email': 'none' },
      },
    });
    expect(created.status).toBe(201);
    await inviteAndAccept(server, ownerAgent, {
      email: email('noemail'),
      roleKey: 'noemail',
      name: 'Nina Noemail',
    });
    const agent = await loginAgent(server, email('noemail'), 'member-pass-12');

    const list = await agent.get('/v1/contacts');
    expect(list.status).toBe(200);
    expect(list.body.contacts.length).toBeGreaterThan(0);
    for (const entry of list.body.contacts) {
      expect(entry).not.toHaveProperty('email');
      expect(entry.name).toBeDefined();
    }
    const first = list.body.contacts[0] as { id: string };
    const detail = await agent.get(`/v1/contacts/${first.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).not.toHaveProperty('email');
  });

  it('updates partially, merges custom fields, and audits the diff', async () => {
    const created = await ownerAgent.post('/v1/contacts').send({
      name: 'Uma Update',
      email: contactEmail('uma'),
      customFields: { score: 1 },
    });
    const id = created.body.contact.id as string;
    const updated = await ownerAgent.patch(`/v1/contacts/${id}`).send({
      title: 'VP Sales',
      tags: ['hot', 'hot'],
      customFields: { tier: 'silver', score: null },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.contact.title).toBe('VP Sales');
    expect(updated.body.contact.tags).toEqual(['hot']);
    expect(updated.body.contact.customFields).toEqual({ tier: 'silver' });

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'contact.updated', entityId: id });
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0].newValues.title).toBe('VP Sales');
  });

  it('validates account and owner references', async () => {
    const badAccount = await ownerAgent.post('/v1/contacts').send({
      name: 'X',
      email: contactEmail('bad-acct'),
      accountId: '00000000-0000-0000-0000-000000000000',
    });
    expect(badAccount.status).toBe(404);
    expect(badAccount.body.code).toBe('ACCOUNT_NOT_FOUND');

    const badOwner = await ownerAgent.post('/v1/contacts').send({
      name: 'X',
      email: contactEmail('bad-owner'),
      ownerId: '00000000-0000-0000-0000-000000000000',
    });
    expect(badOwner.status).toBe(400);
    expect(badOwner.body.code).toBe('OWNER_NOT_MEMBER');
  });

  it('soft-deletes and hides the contact afterwards', async () => {
    const created = await ownerAgent.post('/v1/contacts').send({
      name: 'Del Gone',
      email: contactEmail('del'),
    });
    const id = created.body.contact.id as string;
    const removed = await ownerAgent.delete(`/v1/contacts/${id}`);
    expect(removed.status).toBe(200);

    const gone = await ownerAgent.get(`/v1/contacts/${id}`);
    expect(gone.status).toBe(404);
    const list = await ownerAgent.get('/v1/contacts').query({ q: contactEmail('del') });
    expect(list.body.contacts).toEqual([]);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'contact.deleted', entityId: id });
    expect(audit.body.entries).toHaveLength(1);
  });

  it('requires contacts:manage for writes', async () => {
    const viewer = await inviteAndAccept(server, ownerAgent, {
      email: email('viewer'),
      roleKey: 'viewer',
      name: 'Vicky Viewer',
    });
    void viewer;
    const viewerAgent = await loginAgent(server, email('viewer'), 'member-pass-12');
    const create = await viewerAgent.post('/v1/contacts').send({
      name: 'X',
      email: contactEmail('viewer-create'),
    });
    expect(create.status).toBe(403);
  });
});
