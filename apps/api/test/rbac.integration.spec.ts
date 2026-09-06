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

describe('rbac (scopes, record rules, field rules, roles)', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@rbac.test`;

  let app: INestApplication;
  let server: Server;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let ownerId: string;
  let orgId: string;
  let managerId: string;
  let managerAgent: request.Agent;
  let repId: string;
  let repAgent: request.Agent;
  let viewerAgent: request.Agent;

  let otherOrgUserId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();

    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `RBAC ${runId}`,
        name: 'Rita Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    ownerId = signup.body.user.id as string;
    orgId = signup.body.org.id as string;
    orgIds.push(orgId);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const manager = await inviteAndAccept(server, ownerAgent, {
      email: email('manager'),
      roleKey: 'manager',
      name: 'Manny Manager',
    });
    managerId = manager.id;
    managerAgent = await loginAgent(server, email('manager'), 'member-pass-12');

    const rep = await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Randy Rep',
    });
    repId = rep.id;
    repAgent = await loginAgent(server, email('rep'), 'member-pass-12');

    await inviteAndAccept(server, ownerAgent, {
      email: email('viewer'),
      roleKey: 'viewer',
      name: 'Vicky Viewer',
    });
    viewerAgent = await loginAgent(server, email('viewer'), 'member-pass-12');

    const other = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `RBAC Other ${runId}`,
        name: 'Otto Other',
        email: email('other'),
        password: 'correct-horse-12',
      });
    orgIds.push(other.body.org.id as string);
    otherOrgUserId = other.body.user.id as string;
  });

  afterAll(async () => {
    const db = new Pool({ connectionString: AUTH_DATABASE_URL });
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  it('lists the full directory for owner/manager, self-only for rep, 403 for viewer', async () => {
    const ownerList = await ownerAgent.get('/v1/users');
    expect(ownerList.status).toBe(200);
    expect(ownerList.body).toHaveLength(4);

    const managerList = await managerAgent.get('/v1/users');
    expect(managerList.status).toBe(200);
    expect(managerList.body).toHaveLength(4);

    const repList = await repAgent.get('/v1/users');
    expect(repList.status).toBe(200);
    expect(repList.body).toHaveLength(1);
    expect(repList.body[0].id).toBe(repId);

    const viewerList = await viewerAgent.get('/v1/users');
    expect(viewerList.status).toBe(403);
    expect(viewerList.body.code).toBe('SCOPE_FORBIDDEN');
  });

  it('enforces record rules on detail: rep sees self, not others', async () => {
    const self = await repAgent.get(`/v1/users/${repId}`);
    expect(self.status).toBe(200);
    expect(self.body.email).toBe(email('rep'));

    const other = await repAgent.get(`/v1/users/${managerId}`);
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('RECORD_FORBIDDEN');
  });

  it('returns 404 (not 403) for users in another org — no existence oracle', async () => {
    const res = await ownerAgent.get(`/v1/users/${otherOrgUserId}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('USER_NOT_FOUND');
  });

  it('allows self-edit, owner-edit of others, and blocks rep-edit of others', async () => {
    const selfEdit = await repAgent.patch(`/v1/users/${repId}`).send({ name: 'Randy Updated' });
    expect(selfEdit.status).toBe(200);
    expect(selfEdit.body.name).toBe('Randy Updated');

    const crossEdit = await repAgent.patch(`/v1/users/${managerId}`).send({ name: 'Hacked' });
    expect(crossEdit.status).toBe(403);
    expect(crossEdit.body.code).toBe('SCOPE_FORBIDDEN');

    const ownerEdit = await ownerAgent
      .patch(`/v1/users/${repId}`)
      .send({ name: 'Randy Rep', timezone: 'America/New_York' });
    expect(ownerEdit.status).toBe(200);
    expect(ownerEdit.body.timezone).toBe('America/New_York');
  });

  it('rejects privileged fields on profile update', async () => {
    const res = await ownerAgent.patch(`/v1/users/${repId}`).send({ roleId: 'whatever' });
    expect(res.status).toBe(400);
  });

  it('changes roles, guards self-change, and protects the last owner', async () => {
    const changer = await inviteAndAccept(server, ownerAgent, {
      email: email('promote'),
      roleKey: 'rep',
      name: 'Pam Promote',
    });
    const promoted = await ownerAgent
      .patch(`/v1/users/${changer.id}/role`)
      .send({ roleKey: 'manager' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role.key).toBe('manager');

    const selfChange = await ownerAgent.patch(`/v1/users/${ownerId}/role`).send({ roleKey: 'rep' });
    expect(selfChange.status).toBe(403);
    expect(selfChange.body.code).toBe('SELF_ROLE_CHANGE_FORBIDDEN');

    await inviteAndAccept(server, ownerAgent, {
      email: email('owner2'),
      roleKey: 'owner',
      name: 'Owen Two',
    });
    const owner2Agent = await loginAgent(server, email('owner2'), 'member-pass-12');
    const owner2Me = await owner2Agent.get('/v1/auth/me');
    const owner2Id = owner2Me.body.user.id as string;

    await inviteAndAccept(server, ownerAgent, {
      email: email('admin2'),
      roleKey: 'admin',
      name: 'Al Admin',
    });
    const adminAgent = await loginAgent(server, email('admin2'), 'member-pass-12');

    // Two owners exist: demoting the other owner is allowed.
    const demoteOther = await ownerAgent
      .patch(`/v1/users/${owner2Id}/role`)
      .send({ roleKey: 'manager' });
    expect(demoteOther.status).toBe(200);

    // Only one owner remains: an admin cannot demote them.
    const demoteLast = await adminAgent
      .patch(`/v1/users/${ownerId}/role`)
      .send({ roleKey: 'manager' });
    expect(demoteLast.status).toBe(409);
    expect(demoteLast.body.code).toBe('LAST_OWNER');

    const owners = await ownerAgent.get('/v1/users');
    const ownerRow = owners.body.find((u: { id: string }) => u.id === ownerId);
    expect(ownerRow.role.key).toBe('owner');
  });

  it('manages custom roles: create, Guard system roles, delete with in-use protection', async () => {
    const listed = await ownerAgent.get('/v1/roles');
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(5);

    const managerRoles = await managerAgent.get('/v1/roles');
    expect(managerRoles.status).toBe(403);

    const repCreate = await repAgent
      .post('/v1/roles')
      .send({ key: 'nope', name: 'Nope', permissions: { version: 1, scopes: [] } });
    expect(repCreate.status).toBe(403);

    const created = await ownerAgent.post('/v1/roles').send({
      key: 'support',
      name: 'Support',
      permissions: {
        version: 1,
        scopes: ['users:read'],
        recordAccess: { user: 'all' },
        fields: { 'user.email': 'none' },
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.key).toBe('support');

    const dupe = await ownerAgent.post('/v1/roles').send({
      key: 'support',
      name: 'Support Again',
      permissions: { version: 1, scopes: [] },
    });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('ROLE_KEY_TAKEN');

    const invalid = await ownerAgent.post('/v1/roles').send({
      key: 'broken',
      name: 'Broken',
      permissions: { version: 1, scopes: ['not a scope'] },
    });
    expect(invalid.status).toBe(400);

    const systemRoleId = listed.body.find((r: { key: string }) => r.key === 'rep').id as string;
    const patchSystem = await ownerAgent.patch(`/v1/roles/${systemRoleId}`).send({ name: 'X' });
    expect(patchSystem.status).toBe(403);
    expect(patchSystem.body.code).toBe('ROLE_SYSTEM_IMMUTABLE');

    const renamed = await ownerAgent
      .patch(`/v1/roles/${created.body.id}`)
      .send({ name: 'Support Team' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Support Team');

    const deleteSystem = await ownerAgent.delete(`/v1/roles/${systemRoleId}`);
    expect(deleteSystem.status).toBe(403);

    const supportUser = await inviteAndAccept(server, ownerAgent, {
      email: email('support'),
      roleKey: 'support',
      name: 'Sally Support',
    });
    const inUse = await ownerAgent.delete(`/v1/roles/${created.body.id}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('ROLE_IN_USE');
    expect(supportUser.id).toBeDefined();
  });

  it('applies field-level rules per role on read', async () => {
    const supportAgent = await loginAgent(server, email('support'), 'member-pass-12');
    const list = await supportAgent.get('/v1/users');
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(1);
    for (const entry of list.body) {
      expect(entry).not.toHaveProperty('email');
      expect(entry.name).toBeDefined();
    }
    const ownerList = await ownerAgent.get('/v1/users');
    const ownerSeesEmail = ownerList.body.find((u: { id: string }) => u.id === repId);
    expect(ownerSeesEmail.email).toBe(email('rep'));
  });

  it('enforces field-level edit rules from the role', async () => {
    const created = await ownerAgent.post('/v1/roles').send({
      key: 'noedit',
      name: 'No Edit',
      permissions: {
        version: 1,
        scopes: ['users:read'],
        recordAccess: { user: 'own' },
        fields: { 'user.name': 'read' },
      },
    });
    expect(created.status).toBe(201);
    const member = await inviteAndAccept(server, ownerAgent, {
      email: email('noedit'),
      roleKey: 'noedit',
      name: 'Nina Noedit',
    });
    const memberAgent = await loginAgent(server, email('noedit'), 'member-pass-12');
    const blocked = await memberAgent.patch(`/v1/users/${member.id}`).send({ name: 'Nina X' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('FIELD_NOT_EDITABLE');
    const allowed = await memberAgent.patch(`/v1/users/${member.id}`).send({ timezone: 'UTC' });
    expect(allowed.status).toBe(200);
  });

  it('suspends via endpoint and refuses self-suspend', async () => {
    const selfSuspend = await ownerAgent.post(`/v1/users/${ownerId}/suspend`);
    expect(selfSuspend.status).toBe(403);
    expect(selfSuspend.body.code).toBe('SELF_SUSPEND_FORBIDDEN');

    const repSuspend = await repAgent.post(`/v1/users/${managerId}/suspend`);
    expect(repSuspend.status).toBe(403);
  });

  it('exposes the effective permissions on /me', async () => {
    const me = await repAgent.get('/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role.permissions.scopes).toContain('users:read');
  });
});
