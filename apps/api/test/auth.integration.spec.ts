import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { extractToken, findEmail, inviteAndAccept, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5432/nexus';

describe('auth core (signup, login, sessions, reset, invites)', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@auth.test`;

  let app: INestApplication;
  let server: Server;
  const orgIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
  });

  afterAll(async () => {
    const db = new Pool({ connectionString: AUTH_DATABASE_URL });
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  async function signup(input: Record<string, string>): Promise<request.Response> {
    const res = await request(server).post('/v1/auth/signup').send(input);
    if (res.status === 201 && res.body.org?.id) orgIds.push(res.body.org.id as string);
    return res;
  }

  it('signs up a new org with an owner, sets a session cookie', async () => {
    const res = await signup({
      orgName: `Acme ${runId}`,
      name: 'Ada Owner',
      email: email('owner'),
      password: 'correct-horse-12',
    });
    expect(res.status).toBe(201);
    expect(res.body.org.slug).toMatch(/acme/);
    expect(res.body.user.email).toBe(email('owner'));
    expect(res.body.user.role.key).toBe('owner');
    expect(res.body.user.status).toBe('active');
    expect(res.body.user).not.toHaveProperty('passwordHash');
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.join(';')).toMatch(/nx_session=[^;]+;.*HttpOnly/i);
    expect(cookies.join(';')).toMatch(/SameSite=Lax/i);
  });

  it('rejects invalid signup input with structured errors', async () => {
    const res = await signup({
      orgName: 'X',
      name: '',
      email: 'not-an-email',
      password: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('allows the same email in two different orgs (uniqueness is per-org)', async () => {
    const first = await signup({
      orgName: `Org One ${runId}`,
      name: 'Sam Same',
      email: email('shared'),
      password: 'correct-horse-12',
    });
    const second = await signup({
      orgName: `Org Two ${runId}`,
      name: 'Sam Same',
      email: email('shared'),
      password: 'correct-horse-12',
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.org.id).not.toBe(second.body.org.id);
  });

  it('derives unique slugs for identical org names', async () => {
    const first = await signup({
      orgName: `Dupname ${runId}`,
      name: 'A',
      email: email('dup-a'),
      password: 'correct-horse-12',
    });
    const second = await signup({
      orgName: `Dupname ${runId}`,
      name: 'B',
      email: email('dup-b'),
      password: 'correct-horse-12',
    });
    expect(first.body.org.slug).not.toBe(second.body.org.slug);
  });

  it('logs in with email+password and serves /me off the cookie', async () => {
    const agent = request.agent(server);
    const login = await agent
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'correct-horse-12' });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe(email('owner'));
    const me = await agent.get('/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email('owner'));
    expect(me.body.org.slug).toBeDefined();
  });

  it('returns the same generic error for unknown email and wrong password', async () => {
    const unknown = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('nobody'), password: 'whatever-password-1' });
    const wrong = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'wrong-password-99' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it('throttles repeated failed logins and keeps blocking the correct password', async () => {
    const target = email('throttle');
    await signup({
      orgName: `Throttle ${runId}`,
      name: 'T',
      email: target,
      password: 'correct-horse-12',
    });
    for (let i = 0; i < 5; i += 1) {
      const res = await request(server)
        .post('/v1/auth/login')
        .send({ email: target, password: 'wrong-password-99' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(server)
      .post('/v1/auth/login')
      .send({ email: target, password: 'wrong-password-99' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('LOGIN_THROTTLED');
    const correctWhileBlocked = await request(server)
      .post('/v1/auth/login')
      .send({ email: target, password: 'correct-horse-12' });
    expect(correctWhileBlocked.status).toBe(429);
  });

  it('asks for a workspace choice when the email exists in multiple orgs', async () => {
    const ambiguous = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('shared'), password: 'correct-horse-12' });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.code).toBe('MULTIPLE_ORGS');
    expect(ambiguous.body.orgs).toHaveLength(2);
    const firstSlug = ambiguous.body.orgs[0].slug as string;
    const chosen = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('shared'), password: 'correct-horse-12', orgSlug: firstSlug });
    expect(chosen.status).toBe(200);
  });

  it('rejects /me without a cookie and with a forged cookie', async () => {
    const anon = await request(server).get('/v1/auth/me');
    expect(anon.status).toBe(401);
    expect(anon.body.code).toBe('UNAUTHENTICATED');
    const forged = await request(server)
      .get('/v1/auth/me')
      .set('Cookie', 'nx_session=forged-value');
    expect(forged.status).toBe(401);
  });

  it('logs out, revokes the session, and clears the cookie', async () => {
    const agent = request.agent(server);
    await agent
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'correct-horse-12' });
    const logout = await agent.post('/v1/auth/logout');
    expect(logout.status).toBe(200);
    const cleared = logout.headers['set-cookie'] as unknown as string[];
    expect(cleared.join(';')).toMatch(/nx_session=;/);
    const me = await agent.get('/v1/auth/me');
    expect(me.status).toBe(401);
  });

  it('blocks suspended users at login and on existing sessions', async () => {
    const ownerAgent = request.agent(server);
    const ownerSignup = await signup({
      orgName: `SuspendOrg ${runId}`,
      name: 'Olive Owner',
      email: email('suspend-owner'),
      password: 'correct-horse-12',
    });
    await ownerAgent
      .post('/v1/auth/login')
      .send({ email: email('suspend-owner'), password: 'correct-horse-12' });
    const target = await inviteAndAccept(server, ownerAgent, {
      email: email('suspend'),
      roleKey: 'rep',
      name: 'Sam Suspended',
    });
    const repAgent = await loginAgent(server, email('suspend'), 'member-pass-12');

    const suspended = await ownerAgent.post(`/v1/users/${target.id}/suspend`);
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('suspended');
    expect(ownerSignup.body.org.id).toBeDefined();

    const login = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('suspend'), password: 'member-pass-12' });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('ACCOUNT_SUSPENDED');
    // The pre-suspension session no longer resolves to a principal → unauthenticated.
    const me = await repAgent.get('/v1/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('UNAUTHENTICATED');

    const activated = await ownerAgent.post(`/v1/users/${target.id}/activate`);
    expect(activated.status).toBe(200);
    const relogin = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('suspend'), password: 'member-pass-12' });
    expect(relogin.status).toBe(200);
  });

  it('resets a password end-to-end via the emailed link and revokes old sessions', async () => {
    const target = email('reset');
    const ownerAgent = request.agent(server);
    await signup({
      orgName: `Reset ${runId}`,
      name: 'R',
      email: target,
      password: 'old-password-12',
    });
    await ownerAgent.post('/v1/auth/login').send({ email: target, password: 'old-password-12' });

    const req = await request(server).post('/v1/auth/password/request').send({ email: target });
    expect(req.status).toBe(200);
    const unknownReq = await request(server)
      .post('/v1/auth/password/request')
      .send({ email: email('ghost') });
    expect(unknownReq.status).toBe(200);

    const delivered = await findEmail(target, 'Reset your Nexus CRM password');
    const token = extractToken(delivered.Text, '/reset-password');

    const confirm = await request(server)
      .post('/v1/auth/password/confirm')
      .send({ token, newPassword: 'brand-new-pass-34' });
    expect(confirm.status).toBe(200);

    const oldLogin = await request(server)
      .post('/v1/auth/login')
      .send({ email: target, password: 'old-password-12' });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(server)
      .post('/v1/auth/login')
      .send({ email: target, password: 'brand-new-pass-34' });
    expect(newLogin.status).toBe(200);

    const staleSession = await ownerAgent.get('/v1/auth/me');
    expect(staleSession.status).toBe(401);

    const reuse = await request(server)
      .post('/v1/auth/password/confirm')
      .send({ token, newPassword: 'another-pass-56' });
    expect(reuse.status).toBe(410);
    expect(reuse.body.code).toBe('RESET_TOKEN_INVALID');
  });

  it('invites a user as admin and completes the accept flow', async () => {
    const ownerAgent = request.agent(server);
    const ownerSignup = await signup({
      orgName: `Invite ${runId}`,
      name: 'Ivy Owner',
      email: email('inviter'),
      password: 'correct-horse-12',
    });
    await ownerAgent
      .post('/v1/auth/login')
      .send({ email: email('inviter'), password: 'correct-horse-12' });

    const invitee = email('invitee');
    const created = await ownerAgent
      .post('/v1/auth/invites')
      .send({ email: invitee, roleKey: 'rep' });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe(invitee);

    const listed = await ownerAgent.get('/v1/auth/invites');
    expect(listed.status).toBe(200);
    expect(listed.body.map((i: { email: string }) => i.email)).toContain(invitee);

    const delivered = await findEmail(invitee, 'invited to join');
    const token = extractToken(delivered.Text, '/accept-invite');

    const preview = await request(server).get(`/v1/auth/invites/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.email).toBe(invitee);
    expect(preview.body.roleName).toBe('Sales Rep');

    const accept = await request(server)
      .post('/v1/auth/invites/accept')
      .send({ token, name: 'Ian Invitee', password: 'invitee-pass-12' });
    expect(accept.status).toBe(201);
    expect(accept.body.user.role.key).toBe('rep');
    expect(accept.body.org.id).toBe(ownerSignup.body.org.id);

    const secondAccept = await request(server)
      .post('/v1/auth/invites/accept')
      .send({ token, name: 'Ian Again', password: 'invitee-pass-12' });
    expect(secondAccept.status).toBe(404);
  });

  it('forbids invites from non-admin roles and duplicate member emails', async () => {
    const repAgent = request.agent(server);
    await repAgent
      .post('/v1/auth/login')
      .send({ email: email('invitee'), password: 'invitee-pass-12' });
    const forbidden = await repAgent
      .post('/v1/auth/invites')
      .send({ email: email('nope'), roleKey: 'rep' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('SCOPE_FORBIDDEN');

    const ownerAgent = request.agent(server);
    await ownerAgent
      .post('/v1/auth/login')
      .send({ email: email('inviter'), password: 'correct-horse-12' });
    const dupe = await ownerAgent
      .post('/v1/auth/invites')
      .send({ email: email('inviter'), roleKey: 'rep' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('USER_EXISTS');
  });
});
