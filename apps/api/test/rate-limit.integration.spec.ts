import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';
const PREVIOUS_LIMIT = process.env.RATE_LIMIT_PER_MINUTE;

describe('global rate limiting headers', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@ratelimit.test`;

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
        orgName: `RateLimit Org ${runId}`,
        name: 'Rita Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterEach(() => {
    if (PREVIOUS_LIMIT === undefined) delete process.env.RATE_LIMIT_PER_MINUTE;
    else process.env.RATE_LIMIT_PER_MINUTE = PREVIOUS_LIMIT;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('emits X-RateLimit headers with a decrementing budget', async () => {
    const first = await ownerAgent.get('/v1/org');
    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-limit']).toBe('600');
    const remainingFirst = Number(first.headers['x-ratelimit-remaining']);
    expect(Number.isInteger(remainingFirst)).toBe(true);
    expect(Number(first.headers['x-ratelimit-reset'])).toBeGreaterThan(Date.now() / 1000);

    const second = await ownerAgent.get('/v1/org');
    expect(Number(second.headers['x-ratelimit-remaining'])).toBe(remainingFirst - 1);
  });

  it('rejects with 429 and Retry-After once the budget is spent', async () => {
    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `RateLimit Fresh ${runId}`,
        name: 'Frank Fresh',
        email: email('fresh'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    const freshAgent = await loginAgent(server, email('fresh'), 'correct-horse-12');

    // Tighten only after auth: the fresh user gets their own budget.
    process.env.RATE_LIMIT_PER_MINUTE = '2';
    expect((await freshAgent.get('/v1/org')).status).toBe(200);
    expect((await freshAgent.get('/v1/org')).status).toBe(200);
    const blocked = await freshAgent.get('/v1/org');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
  });
});
