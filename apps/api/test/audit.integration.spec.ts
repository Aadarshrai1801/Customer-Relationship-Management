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
import { AuditService, diffObjects, effectiveRetentionDays } from '../src/audit/audit.service';
import { inviteAndAccept, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5432/nexus';

interface AuditEntry {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  ipAddress: string | null;
}

describe('diffObjects + retention floor (unit)', () => {
  it('diffs only changed keys', () => {
    const { oldValues, newValues } = diffObjects(
      { name: 'A', timezone: 'UTC', extra: 1 },
      { name: 'B', timezone: 'UTC', extra: 1 },
    );
    expect(oldValues).toEqual({ name: 'A' });
    expect(newValues).toEqual({ name: 'B' });
  });

  it('returns empty diffs for identical snapshots', () => {
    const { oldValues, newValues } = diffObjects({ a: [1, 2] }, { a: [1, 2] });
    expect(oldValues).toEqual({});
    expect(newValues).toEqual({});
  });

  it('floors retention at 12 months', () => {
    expect(effectiveRetentionDays(undefined)).toBe(365);
    expect(effectiveRetentionDays(30)).toBe(365);
    expect(effectiveRetentionDays(364)).toBe(365);
    expect(effectiveRetentionDays(365)).toBe(365);
    expect(effectiveRetentionDays(730)).toBe(730);
  });
});

describe('audit log (capture, viewer, retention)', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@audit.test`;

  let app: INestApplication;
  let server: Server;
  let db: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let ownerId: string;
  let orgId: string;

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
        orgName: `Audit ${runId}`,
        name: 'Ava Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgId = signup.body.org.id as string;
    ownerId = signup.body.user.id as string;
    orgIds.push(orgId);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  async function entries(action?: string): Promise<AuditEntry[]> {
    const res = await ownerAgent.get('/v1/audit-log').query(action ? { action } : {});
    expect(res.status).toBe(200);
    return res.body.entries as AuditEntry[];
  }

  it('records signup with org + user entries and client IP', async () => {
    const created = (await entries('org.created')).filter((e) => e.entityId === orgId);
    expect(created).toHaveLength(1);
    expect(created[0]!.actorUserId).toBe(ownerId);
    expect(created[0]!.newValues).toMatchObject({ slug: expect.any(String) });
    expect(created[0]!.ipAddress).toBeTruthy();

    const users = (await entries('user.created')).filter((e) => e.entityId === ownerId);
    expect(users).toHaveLength(1);
    expect(JSON.stringify(users[0])).not.toContain('correct-horse');
  });

  it('records login success and failures without credential material', async () => {
    await request(server)
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'wrong-password-99' });
    const failed = await entries('auth.login.failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]!.newValues).toMatchObject({ reason: 'bad_password' });
    expect(JSON.stringify(failed)).not.toContain('wrong-password');

    const ok = (await entries('auth.login.success')).filter((e) => e.actorUserId === ownerId);
    expect(ok.length).toBeGreaterThanOrEqual(1);
  });

  it('records profile updates with field-level old/new diffs', async () => {
    const rep = await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    const updated = await ownerAgent
      .patch(`/v1/users/${rep.id}`)
      .send({ name: 'Rita Updated', timezone: 'America/New_York' });
    expect(updated.status).toBe(200);

    const res = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'user.updated', entityId: rep.id });
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].oldValues).toEqual({ name: 'Rita Rep', timezone: 'UTC' });
    expect(res.body.entries[0].newValues).toEqual({
      name: 'Rita Updated',
      timezone: 'America/New_York',
    });
  });

  it('records role changes, suspension, invites, and role admin without secrets', async () => {
    const rep = await inviteAndAccept(server, ownerAgent, {
      email: email('rep2'),
      roleKey: 'rep',
      name: 'Randy Rep',
    });
    const inviteCreated = (await entries('invite.created')).filter(
      (e) => e.newValues?.email === email('rep2'),
    );
    expect(inviteCreated).toHaveLength(1);
    expect(JSON.stringify(inviteCreated[0])).not.toMatch(/token/i);

    await ownerAgent.patch(`/v1/users/${rep.id}/role`).send({ roleKey: 'manager' });
    const roleChanged = (await entries('user.role_changed')).filter((e) => e.entityId === rep.id);
    expect(roleChanged).toHaveLength(1);
    expect(roleChanged[0]!.oldValues).toEqual({ roleKey: 'rep' });
    expect(roleChanged[0]!.newValues).toEqual({ roleKey: 'manager' });

    await ownerAgent.post(`/v1/users/${rep.id}/suspend`);
    const suspended = (await entries('user.status_changed')).filter((e) => e.entityId === rep.id);
    expect(suspended).toHaveLength(1);
    expect(suspended[0]!.newValues).toEqual({ status: 'suspended' });

    const role = await ownerAgent.post('/v1/roles').send({
      key: 'auditor',
      name: 'Auditor',
      permissions: { version: 1, scopes: ['audit:read'], recordAccess: {}, fields: {} },
    });
    expect(role.status).toBe(201);
    const roleCreated = (await entries('role.created')).filter((e) => e.entityId === role.body.id);
    expect(roleCreated).toHaveLength(1);
  });

  it('records 2FA lifecycle events', async () => {
    const setup = await ownerAgent.post('/v1/auth/2fa/setup');
    const code = generateSync({ secret: setup.body.secret as string });
    const enable = await ownerAgent.post('/v1/auth/2fa/enable').send({ code });
    expect(enable.status).toBe(200);

    const enabled = await entries('2fa.enabled');
    expect(enabled.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(enabled)).not.toContain(setup.body.secret as string);

    const agent = request.agent(server);
    await agent
      .post('/v1/auth/login')
      .send({ email: email('owner'), password: 'correct-horse-12' });
    await agent.post('/v1/auth/2fa/verify').send({ code: '000000' });
    const failed = await entries('auth.2fa.failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);

    const disable = await ownerAgent
      .post('/v1/auth/2fa/disable')
      .send({ password: 'correct-horse-12' });
    expect(disable.status).toBe(200);
    const disabled = await entries('2fa.disabled');
    expect(disabled.length).toBeGreaterThanOrEqual(1);
  });

  it('records SSO config changes without secrets and org security changes', async () => {
    const created = await ownerAgent.post('/v1/sso/configs').send({
      provider: 'saml',
      saml: {
        idpMetadataXml:
          '<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.audit.test/m"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>MIIB</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.audit.test/sso"/></md:IDPSSODescriptor></md:EntityDescriptor>',
      },
    });
    expect(created.status).toBe(201);
    const logged = (await entries('sso.config.created')).filter(
      (e) => e.entityId === (created.body.id as string),
    );
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).not.toContain('MIIB');

    await ownerAgent.patch(`/v1/sso/configs/${created.body.id as string}`).send({ enabled: true });
    const ssoUpdated = (await entries('sso.config.updated')).filter(
      (e) => e.entityId === (created.body.id as string),
    );
    expect(ssoUpdated).toHaveLength(1);
    expect(ssoUpdated[0]!.newValues).toMatchObject({ enabled: true });

    await ownerAgent.patch('/v1/org/security').send({ twoFactorPolicy: 'required' });
    const secUpdated = await entries('org.security_updated');
    expect(secUpdated.length).toBeGreaterThanOrEqual(1);
    expect(secUpdated[0]!.newValues).toMatchObject({ twoFactorPolicy: 'required' });
    await ownerAgent.patch('/v1/org/security').send({ twoFactorPolicy: 'optional' });
  });

  it('restricts the viewer to audit:read and isolates tenants', async () => {
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const forbidden = await repAgent.get('/v1/audit-log');
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('SCOPE_FORBIDDEN');

    const other = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Audit Other ${runId}`,
        name: 'O',
        email: email('other'),
        password: 'correct-horse-12',
      });
    orgIds.push(other.body.org.id as string);
    const otherAgent = await loginAgent(server, email('other'), 'correct-horse-12');
    const otherView = await otherAgent.get('/v1/audit-log');
    expect(otherView.status).toBe(200);
    const leaked = (otherView.body.entries as AuditEntry[]).filter(
      (e) => e.actorUserId === ownerId,
    );
    expect(leaked).toHaveLength(0);
  });

  it('paginates newest-first and filters by entity', async () => {
    const first = await ownerAgent.get('/v1/audit-log').query({ limit: 3 });
    expect(first.status).toBe(200);
    expect(first.body.entries).toHaveLength(3);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await ownerAgent
      .get('/v1/audit-log')
      .query({ limit: 3, cursor: first.body.nextCursor as string });
    expect(second.status).toBe(200);
    const firstIds = (first.body.entries as AuditEntry[]).map((e) => e.id);
    const secondIds = (second.body.entries as AuditEntry[]).map((e) => e.id);
    expect(secondIds.every((id) => !firstIds.includes(id))).toBe(true);
    expect((second.body.entries as AuditEntry[]).every((e) => e.id < Math.min(...firstIds))).toBe(
      true,
    );

    const badCursor = await ownerAgent.get('/v1/audit-log').query({ cursor: 'bogus' });
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.code).toBe('INVALID_CURSOR');
  });

  it('purges only entries older than the (floored) retention window', async () => {
    const audit = app.get(AuditService);
    const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000).toISOString();
    await db.query(
      `INSERT INTO audit_log_entries (org_id, action, entity_type, created_at) VALUES ($1, 'test.stale', 'test', $2), ($1, 'test.recent', 'test', $3)`,
      [orgId, oldDate, recentDate],
    );

    // Configured 30 days is floored to the 365-day minimum: the 300-day-old
    // row survives, the 400-day-old row is purged.
    const result = await audit.purge(30);
    expect(result.retentionDays).toBe(365);
    expect(result.deleted).toBe(1);

    const remaining = await db.query(
      `SELECT action FROM audit_log_entries WHERE org_id = $1 AND entity_type = 'test'`,
      [orgId],
    );
    expect(remaining.rows.map((r: { action: string }) => r.action)).toEqual(['test.recent']);

    const extended = await audit.purge(730);
    expect(extended.retentionDays).toBe(730);
    expect(extended.deleted).toBe(0);
  });
});
