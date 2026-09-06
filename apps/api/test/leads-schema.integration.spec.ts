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
const APP_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://nexus_app:nexus_app@localhost:5433/nexus';

describe('module 3 leads schema & rbac seeds', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@leads-schema.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  let appDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    authDb = new Pool({ connectionString: AUTH_DATABASE_URL });
    appDb = new Pool({ connectionString: APP_DATABASE_URL });

    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Leads ${runId}`,
        name: 'Logan Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await appDb.end();
    await app.close();
  });

  it('seeds lead and notification scopes on system roles', async () => {
    const res = await ownerAgent.get('/v1/roles');
    expect(res.status).toBe(200);
    const rolesList = Array.isArray(res.body) ? res.body : (res.body as { roles: any[] }).roles;
    const rolesByKey = new Map<string, { scopes: string[]; recordAccess: Record<string, string> }>(
      rolesList.map((r: { key: string; permissions: { scopes: string[]; recordAccess: Record<string, string> } }) => [r.key, r.permissions]),
    );

    // Owner
    const ownerPerms = rolesByKey.get('owner')!;
    expect(ownerPerms.scopes).toContain('*');
    expect(ownerPerms.recordAccess['lead']).toBe('all');

    // Admin
    const adminPerms = rolesByKey.get('admin')!;
    expect(adminPerms.scopes).toContain('leads:read');
    expect(adminPerms.scopes).toContain('leads:manage');
    expect(adminPerms.scopes).toContain('lead_routing:manage');
    expect(adminPerms.scopes).toContain('notifications:read');
    expect(adminPerms.recordAccess['lead']).toBe('all');

    // Manager
    const mgrPerms = rolesByKey.get('manager')!;
    expect(mgrPerms.scopes).toContain('leads:read');
    expect(mgrPerms.scopes).toContain('leads:manage');
    expect(mgrPerms.scopes).toContain('lead_routing:manage');
    expect(mgrPerms.scopes).toContain('notifications:read');
    expect(mgrPerms.recordAccess['lead']).toBe('all');

    // Rep
    const repPerms = rolesByKey.get('rep')!;
    expect(repPerms.scopes).toContain('leads:read');
    expect(repPerms.scopes).toContain('leads:manage');
    expect(repPerms.scopes).not.toContain('lead_routing:manage');
    expect(repPerms.scopes).toContain('notifications:read');
    expect(repPerms.recordAccess['lead']).toBe('own');

    // Viewer
    const viewerPerms = rolesByKey.get('viewer')!;
    expect(viewerPerms.scopes).toContain('leads:read');
    expect(viewerPerms.scopes).not.toContain('leads:manage');
    expect(viewerPerms.scopes).not.toContain('lead_routing:manage');
    expect(viewerPerms.scopes).toContain('notifications:read');
    expect(viewerPerms.recordAccess['lead']).toBe('own');
  });


  it('enforces RLS and tenant isolation across leads, routing, and notification tables', async () => {
    const org1Id = orgIds[0]!;

    // Create a second tenant org2
    const signup2 = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Leads Other ${runId}`,
        name: 'Other Owner',
        email: email('other-owner'),
        password: 'correct-horse-12',
      });
    expect(signup2.status).toBe(201);
    const org2Id = signup2.body.org.id as string;
    orgIds.push(org2Id);

    // Using appDb with tenant context org1Id
    const client = await appDb.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL app.tenant_id = '${org1Id}'`);

      // 1. Insert lead
      const leadRes = await client.query(
        `INSERT INTO leads (org_id, name, email, company, status, source)
         VALUES ($1, 'Acme Lead', 'lead@acme.com', 'Acme Inc', 'new', 'website')
         RETURNING id`,
        [org1Id],
      );
      const leadId = leadRes.rows[0].id;
      expect(leadId).toBeDefined();

      // 2. Insert lead routing rule
      const ruleRes = await client.query(
        `INSERT INTO lead_routing_rules (org_id, name, strategy, is_active)
         VALUES ($1, 'Default Round Robin', 'round_robin', true)
         RETURNING id`,
        [org1Id],
      );
      const ruleId = ruleRes.rows[0].id;
      expect(ruleId).toBeDefined();

      // 3. Insert notification
      const userRes = await client.query('SELECT id FROM users WHERE org_id = $1 LIMIT 1', [org1Id]);
      const userId = userRes.rows[0].id;

      const notifRes = await client.query(
        `INSERT INTO notifications (org_id, user_id, type, title, body)
         VALUES ($1, $2, 'lead_assigned', 'New Lead Assigned', 'You were assigned Acme Lead')
         RETURNING id`,
        [org1Id, userId],
      );
      expect(notifRes.rows[0].id).toBeDefined();

      // 4. Insert rep availability
      await client.query(
        `INSERT INTO rep_availability (org_id, user_id, is_available)
         VALUES ($1, $2, true)`,
        [org1Id, userId],
      );

      // Verify org1 sees the records
      const countOrg1 = await client.query('SELECT count(*)::int as count FROM leads WHERE id = $1', [leadId]);
      expect(countOrg1.rows[0].count).toBe(1);

      // Switch to org2 tenant context within same session
      await client.query(`SET LOCAL app.tenant_id = '${org2Id}'`);

      // Org2 cannot see Org1's lead
      const countOrg2 = await client.query('SELECT count(*)::int as count FROM leads WHERE id = $1', [leadId]);
      expect(countOrg2.rows[0].count).toBe(0);

      // Org2 cannot see Org1's routing rule
      const ruleOrg2 = await client.query('SELECT count(*)::int as count FROM lead_routing_rules WHERE id = $1', [ruleId]);
      expect(ruleOrg2.rows[0].count).toBe(0);

      // Org2 cannot see Org1's notifications
      const notifOrg2 = await client.query('SELECT count(*)::int as count FROM notifications WHERE org_id = $1', [org1Id]);
      expect(notifOrg2.rows[0].count).toBe(0);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
