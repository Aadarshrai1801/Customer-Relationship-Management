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

describe('custom field definitions', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@fields.test`;

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
        orgName: `Fields ${runId}`,
        name: 'Fiona Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  it('seeds custom_fields scopes on system roles', async () => {
    const me = await ownerAgent.get('/v1/auth/me');
    // Owner holds the '*' wildcard, which grants every scope.
    expect(me.body.user.role.permissions.scopes).toContain('*');

    await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const repMe = await repAgent.get('/v1/auth/me');
    expect(repMe.body.user.role.permissions.scopes).toContain('custom_fields:read');
    expect(repMe.body.user.role.permissions.scopes).not.toContain('custom_fields:manage');
  });

  it('creates definitions for every field type', async () => {
    const cases: Array<{
      key: string;
      type: string;
      options?: Record<string, unknown>;
      required?: boolean;
    }> = [
      { key: 'nickname', type: 'text' },
      { key: 'score', type: 'number', required: true },
      { key: 'birthday', type: 'date' },
      { key: 'tier', type: 'picklist', options: { options: ['gold', 'silver'] } },
      { key: 'interests', type: 'multi_select', options: { options: ['a', 'b'] } },
      { key: 'vip', type: 'checkbox' },
      { key: 'arr', type: 'currency', options: { currency: 'EUR' } },
    ];
    for (const field of cases) {
      const res = await ownerAgent.post('/v1/custom-fields').send({
        entityType: 'contact',
        label: field.key,
        ...field,
      });
      expect(res.status).toBe(201);
      expect(res.body.key).toBe(field.key);
    }
    const total = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'total',
      label: 'Total',
      type: 'formula',
      options: { expression: '{score} * 2' },
    });
    expect(total.status).toBe(201);

    const listed = await ownerAgent.get('/v1/custom-fields').query({ entityType: 'contact' });
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(8);
  });

  it('rejects bad definitions explicitly', async () => {
    const badKey = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'Has Space',
      label: 'Bad',
      type: 'text',
    });
    // Lowercased by schema, still rejected for the space.
    expect(badKey.status).toBe(400);

    const dupe = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'nickname',
      label: 'Dupe',
      type: 'text',
    });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('FIELD_KEY_TAKEN');

    const noOptions = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'empty_pick',
      label: 'Empty',
      type: 'picklist',
      options: {},
    });
    expect(noOptions.status).toBe(400);

    const badFormula = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'broken',
      label: 'Broken',
      type: 'formula',
      options: { expression: '{score} + ' },
    });
    expect(badFormula.status).toBe(400);
    expect(badFormula.body.code).toBe('FORMULA_INVALID');

    const unknownRef = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'mystery',
      label: 'Mystery',
      type: 'formula',
      options: { expression: '{nope} * 2' },
    });
    expect(unknownRef.status).toBe(400);
    expect(unknownRef.body.code).toBe('FORMULA_UNKNOWN_FIELD');

    const selfRef = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'loopy',
      label: 'Loopy',
      type: 'formula',
      options: { expression: '{loopy} + 1' },
    });
    expect(selfRef.status).toBe(400);
    expect(selfRef.body.code).toBe('FORMULA_SELF_REFERENCE');

    const chained = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'double_total',
      label: 'Double',
      type: 'formula',
      options: { expression: '{total} * 2' },
    });
    expect(chained.status).toBe(400);
    expect(chained.body.code).toBe('FORMULA_CHAINED');
  });

  it('enforces manage scope on writes and isolates tenants', async () => {
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const read = await repAgent.get('/v1/custom-fields').query({ entityType: 'contact' });
    expect(read.status).toBe(200);
    expect(read.body.length).toBeGreaterThan(0);

    const write = await repAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'rep_field',
      label: 'Rep',
      type: 'text',
    });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('SCOPE_FORBIDDEN');

    // Admins hold the explicit manage scope (not just the owner wildcard).
    await inviteAndAccept(server, ownerAgent, {
      email: email('admin'),
      roleKey: 'admin',
      name: 'Ada Admin',
    });
    const adminAgent = await loginAgent(server, email('admin'), 'member-pass-12');
    const adminWrite = await adminAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'admin_field',
      label: 'Admin',
      type: 'text',
    });
    expect(adminWrite.status).toBe(201);

    const other = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Fields Other ${runId}`,
        name: 'O',
        email: email('other'),
        password: 'correct-horse-12',
      });
    orgIds.push(other.body.org.id as string);
    const otherAgent = await loginAgent(server, email('other'), 'correct-horse-12');
    const foreign = await otherAgent.get('/v1/custom-fields').query({ entityType: 'contact' });
    expect(foreign.body).toEqual([]);
  });

  it('updates labels and formula expressions, then deletes', async () => {
    const created = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'account',
      key: 'temp_field',
      label: 'Temp',
      type: 'number',
    });
    expect(created.status).toBe(201);

    const renamed = await ownerAgent
      .patch(`/v1/custom-fields/${created.body.id as string}`)
      .send({ label: 'Temporary', required: true });
    expect(renamed.status).toBe(200);
    expect(renamed.body.label).toBe('Temporary');
    expect(renamed.body.required).toBe(true);

    const total = await ownerAgent.get('/v1/custom-fields').query({ entityType: 'contact' });
    const totalField = (total.body as Array<{ key: string; id: string }>).find(
      (f) => f.key === 'total',
    )!;
    const repointed = await ownerAgent
      .patch(`/v1/custom-fields/${totalField.id}`)
      .send({ options: { expression: '{score} * 3' } });
    expect(repointed.status).toBe(200);

    const badRepoint = await ownerAgent
      .patch(`/v1/custom-fields/${totalField.id}`)
      .send({ options: { expression: '{missing} * 3' } });
    expect(badRepoint.status).toBe(400);

    const removed = await ownerAgent.delete(`/v1/custom-fields/${created.body.id as string}`);
    expect(removed.status).toBe(200);
    const missing = await ownerAgent.patch(`/v1/custom-fields/${created.body.id as string}`).send({
      label: 'X',
    });
    expect(missing.status).toBe(404);
  });
});
