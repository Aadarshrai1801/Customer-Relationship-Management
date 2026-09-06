import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { generateSync } from 'otplib';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { inviteAndAccept, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5432/nexus';

describe('two-factor authentication (TOTP + backup codes + org policy)', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@tfa.test`;

  let app: INestApplication;
  let server: Server;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let ownerId: string;
  let ownerSecret = '';
  let mandatedSecret = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();

    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `TFA ${runId}`,
        name: 'Tina Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    expect(signup.body.twoFactor).toEqual({ enrolled: false, required: false, verified: true });
    orgIds.push(signup.body.org.id as string);
    ownerId = signup.body.user.id as string;
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterAll(async () => {
    const db = new Pool({ connectionString: AUTH_DATABASE_URL });
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  it('enrolls via setup + enable and reports enrollment on /me', async () => {
    const setup = await ownerAgent.post('/v1/auth/2fa/setup');
    expect(setup.status).toBe(201);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    ownerSecret = setup.body.secret as string;

    const wrong = await ownerAgent.post('/v1/auth/2fa/enable').send({ code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_TWO_FACTOR_CODE');

    const code = generateSync({ secret: setup.body.secret as string });
    const enable = await ownerAgent.post('/v1/auth/2fa/enable').send({ code });
    expect(enable.status).toBe(200);
    expect(enable.body.backupCodes).toHaveLength(10);
    expect(enable.body.verified).toBe(true);

    const me = await ownerAgent.get('/v1/auth/me');
    expect(me.body.user.twoFactorEnrolled).toBe(true);
    expect(me.body.user.id).toBe(ownerId);
  });

  it('requires a second factor at login once enrolled', async () => {
    const agent = request.agent(server);
    const login = await agent
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'correct-horse-12' });
    expect(login.status).toBe(200);
    expect(login.body.twoFactor).toMatchObject({ enrolled: true, required: true, verified: false });

    const me = await agent.get('/v1/auth/me');
    expect(me.status).toBe(403);
    expect(me.body.code).toBe('TWO_FACTOR_REQUIRED');

    const code = generateSync({ secret: ownerSecret });
    const verify = await agent.post('/v1/auth/2fa/verify').send({ code });
    expect(verify.status).toBe(200);

    const meAfter = await agent.get('/v1/auth/me');
    expect(meAfter.status).toBe(200);
  });

  it('throttles repeated bad verification codes', async () => {
    const agent = request.agent(server);
    await agent
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'correct-horse-12' });
    for (let i = 0; i < 5; i += 1) {
      const res = await agent.post('/v1/auth/2fa/verify').send({ code: '000000' });
      expect(res.status).toBe(401);
    }
    const blocked = await agent.post('/v1/auth/2fa/verify').send({ code: '000000' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('TWO_FACTOR_THROTTLED');
  });

  it('accepts a backup code once, then rejects the reuse', async () => {
    const codesAgent = request.agent(server);
    await codesAgent
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'correct-horse-12' });

    const setup = await ownerAgent.post('/v1/auth/2fa/setup');
    const fresh = generateSync({ secret: setup.body.secret as string });
    const enable = await ownerAgent.post('/v1/auth/2fa/enable').send({ code: fresh });
    const codes = enable.body.backupCodes as string[];

    const first = await codesAgent.post('/v1/auth/2fa/verify').send({ backupCode: codes[0] });
    expect(first.status).toBe(200);

    const agent2 = request.agent(server);
    await agent2
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'correct-horse-12' });
    const reuse = await agent2.post('/v1/auth/2fa/verify').send({ backupCode: codes[0] });
    expect(reuse.status).toBe(401);
    const second = await agent2.post('/v1/auth/2fa/verify').send({ backupCode: codes[1] });
    expect(second.status).toBe(200);
  });

  it('regenerates backup codes with password confirmation and invalidates old ones', async () => {
    const setup = await ownerAgent.post('/v1/auth/2fa/setup');
    const fresh = generateSync({ secret: setup.body.secret as string });
    const enable = await ownerAgent.post('/v1/auth/2fa/enable').send({ code: fresh });
    const oldCodes = enable.body.backupCodes as string[];

    const wrongPw = await ownerAgent
      .post('/v1/auth/2fa/backup-codes/regenerate')
      .send({ password: 'wrong-password-99' });
    expect(wrongPw.status).toBe(401);

    const regen = await ownerAgent
      .post('/v1/auth/2fa/backup-codes/regenerate')
      .send({ password: 'correct-horse-12' });
    expect(regen.status).toBe(200);
    expect(regen.body.backupCodes).toHaveLength(10);

    const agent = request.agent(server);
    await agent
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'correct-horse-12' });
    const stale = await agent.post('/v1/auth/2fa/verify').send({ backupCode: oldCodes[2] });
    expect(stale.status).toBe(401);
    const current = await agent
      .post('/v1/auth/2fa/verify')
      .send({ backupCode: (regen.body.backupCodes as string[])[0] });
    expect(current.status).toBe(200);
  });

  it('disables 2FA with password confirmation and stops requiring it', async () => {
    const wrongPw = await ownerAgent
      .post('/v1/auth/2fa/disable')
      .send({ password: 'nope-nope-nope-1' });
    expect(wrongPw.status).toBe(401);

    const disable = await ownerAgent
      .post('/v1/auth/2fa/disable')
      .send({ password: 'correct-horse-12' });
    expect(disable.status).toBe(200);

    const login = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'correct-horse-12' });
    expect(login.status).toBe(200);
    expect(login.body.twoFactor).toMatchObject({
      enrolled: false,
      required: false,
      verified: true,
    });

    const verify = await ownerAgent.post('/v1/auth/2fa/verify').send({ code: '000000' });
    expect(verify.status).toBe(409);
    expect(verify.body.code).toBe('TWO_FACTOR_NOT_ENROLLED');
  });

  it('rejects enable without a prior setup', async () => {
    await inviteAndAccept(server, ownerAgent, {
      email: email('fresh'),
      roleKey: 'rep',
      name: 'Fred Fresh',
    });
    const freshAgent = await loginAgent(server, email('fresh'), 'member-pass-12');
    const enable = await freshAgent.post('/v1/auth/2fa/enable').send({ code: '000000' });
    expect(enable.status).toBe(409);
    expect(enable.body.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
  });

  it('enforces org-required 2FA for users who never enrolled', async () => {
    const policy = await ownerAgent.patch('/v1/org/security').send({ twoFactorPolicy: 'required' });
    expect(policy.status).toBe(200);

    const org = await ownerAgent.get('/v1/org');
    expect(org.body.securitySettings.twoFactorPolicy).toBe('required');

    await inviteAndAccept(server, ownerAgent, {
      email: email('mandated'),
      roleKey: 'rep',
      name: 'Mona Mandated',
    });
    const mandatedAgent = request.agent(server);
    const login = await mandatedAgent
      .post('/v1/auth/login')
      .send({ email: email('mandated'), password: 'member-pass-12' });
    expect(login.status).toBe(200);
    expect(login.body.twoFactor).toMatchObject({
      enrolled: false,
      required: true,
      verified: false,
    });

    const me = await mandatedAgent.get('/v1/auth/me');
    expect(me.status).toBe(403);

    // The unverified session is allowed to complete enrollment, nothing else.
    const setup = await mandatedAgent.post('/v1/auth/2fa/setup');
    expect(setup.status).toBe(201);
    mandatedSecret = setup.body.secret as string;
    const code = generateSync({ secret: mandatedSecret });
    const enable = await mandatedAgent.post('/v1/auth/2fa/enable').send({ code });
    expect(enable.status).toBe(200);
    const meAfter = await mandatedAgent.get('/v1/auth/me');
    expect(meAfter.status).toBe(200);

    const inviteBlocked = await mandatedAgent.post('/v1/auth/invites').send({
      email: email('blocked'),
      roleKey: 'rep',
    });
    expect(inviteBlocked.status).toBe(403);
    expect(inviteBlocked.body.code).toBe('SCOPE_FORBIDDEN');
  });

  it('lets non-managers read nothing of the org and never change the security policy', async () => {
    const repAgent = request.agent(server);
    await repAgent
      .post('/v1/auth/login')
      .send({ email: email('mandated'), password: 'member-pass-12' });
    const verified = await repAgent
      .post('/v1/auth/2fa/verify')
      .send({ code: generateSync({ secret: mandatedSecret }) });
    expect(verified.status).toBe(200);

    const read = await repAgent.get('/v1/org');
    expect(read.status).toBe(403);
    expect(read.body.code).toBe('SCOPE_FORBIDDEN');

    const write = await repAgent.patch('/v1/org/security').send({ twoFactorPolicy: 'optional' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('SCOPE_FORBIDDEN');
  });

  it('disables enrollment entirely when the org policy is off', async () => {
    const policy = await ownerAgent.patch('/v1/org/security').send({ twoFactorPolicy: 'off' });
    expect(policy.status).toBe(200);

    const setup = await ownerAgent.post('/v1/auth/2fa/setup');
    expect(setup.status).toBe(403);
    expect(setup.body.code).toBe('TWO_FACTOR_DISABLED');

    // Enrolled users bypass verification while the policy is off.
    const agent = request.agent(server);
    const login = await agent
      .post('/v1/auth/login')
      .send({ email: email('mandated'), password: 'member-pass-12' });
    expect(login.status).toBe(200);
    expect(login.body.twoFactor).toMatchObject({ enrolled: true, required: false, verified: true });
  });
});
