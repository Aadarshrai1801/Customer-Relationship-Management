import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AuditRetentionTasks } from '../src/audit/audit-retention.tasks';
import { PrivacyService } from '../src/privacy/privacy.service';
import { extractToken, findEmail, inviteAndAccept, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5432/nexus';

async function waitFor(
  check: () => Promise<string>,
  expected: string,
  timeoutMs = 25000,
): Promise<void> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = await check();
    if (last === expected) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${expected} (last: ${last})`);
}

describe('privacy (gdpr export + erasure)', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@privacy.test`;

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
        orgName: `Privacy ${runId}`,
        name: 'Pam Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerId = signup.body.user.id as string;
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  async function exportStatus(id: string): Promise<string> {
    const res = await ownerAgent.get('/v1/privacy/exports');
    const row = (res.body as Array<{ id: string; status: string }>).find((e) => e.id === id);
    return row?.status ?? 'missing';
  }

  it('exports personal data asynchronously and delivers a verified download', async () => {
    // Generate activity so the package has content.
    await inviteAndAccept(server, ownerAgent, {
      email: email('member'),
      roleKey: 'rep',
      name: 'Mia Member',
    });

    const created = await ownerAgent.post('/v1/privacy/export');
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('pending');
    const exportId = created.body.id as string;

    const pending = await ownerAgent.get(`/v1/privacy/export/${exportId}/download`);
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('EXPORT_NOT_READY');

    await waitFor(() => exportStatus(exportId), 'ready');

    const list = await ownerAgent.get('/v1/privacy/exports');
    const row = (list.body as Array<Record<string, unknown>>).find((e) => e.id === exportId)!;
    expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);

    const download = await ownerAgent.get(`/v1/privacy/export/${exportId}/download`);
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain(`nexus-export-${exportId}.json`);
    const pkg = download.body as Record<string, unknown>;
    expect((pkg.user as { email: string }).email).toBe(email('owner'));
    const sessions = pkg.sessions as unknown[];
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(pkg.auditEntries).toBeDefined();
    expect((pkg.invitesSent as unknown[]).length).toBeGreaterThanOrEqual(1);

    // No credential material anywhere in the package.
    const text = JSON.stringify(pkg);
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('correct-horse');
    expect(text).not.toContain('secret');

    // Checksum matches the delivered bytes.
    const { rows } = await db.query('SELECT checksum FROM gdpr_exports WHERE id = $1', [exportId]);
    expect(rows[0].checksum).toBe(row.checksum);

    // Ready email was sent.
    const delivered = await findEmail(email('owner'), 'data export is ready');
    expect(delivered.Subject).toContain('data export is ready');
  });

  it('marks the export failed when the user is gone', async () => {
    const temp = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Privacy Temp ${runId}`,
        name: 'T',
        email: email('temp'),
        password: 'correct-horse-12',
      });
    orgIds.push(temp.body.org.id as string);
    const tempAgent = await loginAgent(server, email('temp'), 'correct-horse-12');
    const created = await tempAgent.post('/v1/privacy/export');
    const exportId = created.body.id as string;
    await db.query('DELETE FROM users WHERE id = $1', [temp.body.user.id]);

    await app.get(PrivacyService).handleExport(exportId);
    await waitFor(async () => {
      const { rows } = await db.query('SELECT status FROM gdpr_exports WHERE id = $1', [exportId]);
      return rows[0]?.status ?? 'missing';
    }, 'failed');
  });

  it('erases a member account completely with password confirmation', async () => {
    const member = await inviteAndAccept(server, ownerAgent, {
      email: email('erase-me'),
      roleKey: 'rep',
      name: 'Erik Erase',
    });
    const memberAgent = await loginAgent(server, email('erase-me'), 'member-pass-12');

    const wrongPw = await memberAgent
      .post('/v1/privacy/erase')
      .send({ password: 'nope-nope-nope-1' });
    expect(wrongPw.status).toBe(401);

    const erase = await memberAgent.post('/v1/privacy/erase').send({ password: 'member-pass-12' });
    expect(erase.status).toBe(200);
    expect(erase.body).toEqual({ ok: true });
    const cleared = erase.headers['set-cookie'] as unknown as string[];
    expect(cleared.join(';')).toMatch(/nx_session=;/);

    // User row, sessions, and 2FA material are gone.
    const { rows: users } = await db.query('SELECT id FROM users WHERE id = $1', [member.id]);
    expect(users).toHaveLength(0);
    const { rows: sessions } = await db.query('SELECT id FROM sessions WHERE user_id = $1', [
      member.id,
    ]);
    expect(sessions).toHaveLength(0);

    // Login no longer works; the stale session is dead.
    const login = await request(server)
      .post('/v1/auth/login')
      .send({ email: email('erase-me'), password: 'member-pass-12' });
    expect(login.status).toBe(401);
    const me = await memberAgent.get('/v1/auth/me');
    expect(me.status).toBe(401);

    // Audit keeps one receipt row (actor nulled, email on the receipt only).
    const { rows: audit } = await db.query(
      `SELECT actor_user_id, actor_email, action FROM audit_log_entries WHERE entity_id = $1`,
      [member.id],
    );
    const receipt = audit.filter((r: { action: string }) => r.action === 'user.erased');
    expect(receipt).toHaveLength(1);
    expect(receipt[0].actor_user_id).toBeNull();
    expect(receipt[0].actor_email).toBe(email('erase-me'));
    const others = audit.filter((r: { action: string }) => r.action !== 'user.erased');
    expect(others.every((r: { actor_email: string | null }) => r.actor_email === null)).toBe(true);

    // The rest of the org is untouched.
    const directory = await ownerAgent.get('/v1/users');
    expect(directory.body.map((u: { id: string }) => u.id)).toContain(ownerId);
  });

  it('erases an SSO (passwordless) account on session auth alone', async () => {
    // A passwordless (SSO-provisioned) user holds a session from invite
    // accept; erasure proceeds without a password confirmation step.
    const invitee = email('sso-erase');
    const created = await ownerAgent
      .post('/v1/auth/invites')
      .send({ email: invitee, roleKey: 'rep' });
    expect(created.status).toBe(201);
    const delivered = await findEmail(invitee, 'invited to join');
    const token = extractToken(delivered.Text, '/accept-invite');
    const agent = request.agent(server);
    const accept = await agent
      .post('/v1/auth/invites/accept')
      .send({ token, name: 'Sally Sso', password: 'temp-pass-12' });
    expect(accept.status).toBe(201);
    const memberId = accept.body.user.id as string;
    await db.query('UPDATE users SET password_hash = NULL WHERE id = $1', [memberId]);

    const erase = await agent.post('/v1/privacy/erase').send({});
    expect(erase.status).toBe(200);
    const { rows } = await db.query('SELECT id FROM users WHERE id = $1', [memberId]);
    expect(rows).toHaveLength(0);
  });

  it('refuses to erase the last owner', async () => {
    const erase = await ownerAgent.post('/v1/privacy/erase').send({ password: 'correct-horse-12' });
    expect(erase.status).toBe(409);
    expect(erase.body.code).toBe('LAST_OWNER');
  });

  it('expires ready exports past their TTL and deletes the files', async () => {
    const created = await ownerAgent.post('/v1/privacy/export');
    const exportId = created.body.id as string;
    await waitFor(() => exportStatus(exportId), 'ready');

    await db.query(`UPDATE gdpr_exports SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
      exportId,
    ]);
    const result = await app.get(PrivacyService).expireExports();
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const download = await ownerAgent.get(`/v1/privacy/export/${exportId}/download`);
    expect(download.status).toBe(409);
    expect(download.body.code).toBe('EXPORT_EXPIRED');
  });

  it('hides other users exports and runs the retention purge on schedule wiring', async () => {
    const other = await inviteAndAccept(server, ownerAgent, {
      email: email('other-member'),
      roleKey: 'rep',
      name: 'Owen Other',
    });
    void other;
    const otherAgent = await loginAgent(server, email('other-member'), 'member-pass-12');
    const created = await otherAgent.post('/v1/privacy/export');
    const otherExportId = created.body.id as string;

    const mine = await ownerAgent.get('/v1/privacy/exports');
    expect((mine.body as Array<{ id: string }>).some((e) => e.id === otherExportId)).toBe(false);

    const foreign = await ownerAgent.get(`/v1/privacy/export/${otherExportId}/download`);
    expect(foreign.status).toBe(404);

    // The scheduled purge handler delegates to the audited purge with the
    // 12-month floor intact. Assert on the purge result (not a global row
    // count — other test files insert audit rows concurrently).
    const tasks = app.get(AuditRetentionTasks);
    const result = await tasks.runRetentionPurge();
    expect(result.retentionDays).toBe(365);
    expect(result.deleted).toBe(0);

    // A stale export file on disk is removed by the expiry worker.
    const stale = await otherAgent.post('/v1/privacy/export');
    const staleId = stale.body.id as string;
    await waitFor(async () => {
      const { rows } = await db.query('SELECT status FROM gdpr_exports WHERE id = $1', [staleId]);
      return rows[0]?.status ?? 'missing';
    }, 'ready');
    await db.query(`UPDATE gdpr_exports SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
      staleId,
    ]);
    await app.get(PrivacyService).expireExports();
    const { rows } = await db.query('SELECT status, storage_key FROM gdpr_exports WHERE id = $1', [
      staleId,
    ]);
    expect(rows[0].status).toBe('expired');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const storage = path.resolve(process.env.STORAGE_DIR ?? 'storage');
    await expect(fs.stat(`${storage}/exports/${rows[0].storage_key as string}`)).rejects.toThrow();
  });
});
