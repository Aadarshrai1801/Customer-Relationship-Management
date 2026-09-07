import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { findEmail, inviteAndAccept, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';

describe('comments with @mentions', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@comments.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let repAgent: request.Agent;
  let repEmail: string;
  let contactId: string;
  let dealId: string;
  let commentId: string;

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
        orgName: `Comments Org ${runId}`,
        name: 'Cora Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    repEmail = email('rep');
    await inviteAndAccept(server, ownerAgent, {
      email: repEmail,
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    repAgent = await loginAgent(server, repEmail, 'member-pass-12');

    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Chatty Person',
      email: `chatty-${runId}@example.test`,
    });
    contactId = contact.body.contact.id as string;

    const deal = await ownerAgent.post('/v1/deals').send({ name: 'Chatty Deal', amount: 100 });
    dealId = deal.body.deal.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('creates comments and notifies @mentioned members in-app and by email', async () => {
    const created = await ownerAgent.post('/v1/comments').send({
      entityType: 'contact',
      entityId: contactId,
      body: `Hey @${repEmail}, please review this contact.`,
    });
    expect(created.status).toBe(201);
    commentId = created.body.comment.id as string;
    expect(created.body.comment.mentionedUsers.map((u: { email: string }) => u.email)).toContain(
      repEmail,
    );

    const notifs = await repAgent.get('/v1/notifications');
    const mention = (
      notifs.body.items as Array<{ type: string; title: string; body: string }>
    ).find((n) => n.type === 'mention');
    expect(mention).toBeDefined();
    expect(mention!.title).toContain('Cora Owner');
    expect(mention!.body).toContain('please review');

    const delivered = await findEmail(repEmail, 'mentioned you');
    expect(delivered.Text).toContain('please review');

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'comment.created', entityId: contactId });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('ignores unknown @addresses and self-mentions', async () => {
    const created = await ownerAgent.post('/v1/comments').send({
      entityType: 'deal',
      entityId: dealId,
      body: `Looping in @ghost-${runId}@example.test and @${email('owner')} here.`,
    });
    expect(created.status).toBe(201);
    expect(created.body.comment.mentionedUsers).toEqual([]);
  });

  it('validates parents and comment input', async () => {
    const missing = await ownerAgent.post('/v1/comments').send({
      entityType: 'contact',
      entityId: '00000000-0000-4000-8000-000000000000',
      body: 'Hello?',
    });
    expect(missing.status).toBe(404);

    const badEntity = await ownerAgent.post('/v1/comments').send({
      entityType: 'planet',
      entityId: contactId,
      body: 'Hello?',
    });
    expect(badEntity.status).toBe(400);

    const blank = await ownerAgent.post('/v1/comments').send({
      entityType: 'contact',
      entityId: contactId,
      body: '   ',
    });
    expect(blank.status).toBe(400);
  });

  it('enforces parent-record scoping for reps', async () => {
    // Rep cannot see (or discuss) the owner's contact.
    const blocked = await repAgent.post('/v1/comments').send({
      entityType: 'contact',
      entityId: contactId,
      body: 'Sneaky comment',
    });
    expect([403, 404]).toContain(blocked.status);

    const listed = await repAgent
      .get('/v1/comments')
      .query({ entityType: 'contact', entityId: contactId });
    expect([403, 404]).toContain(listed.status);
  });

  it('edits with author rules and notifies only fresh mentions', async () => {
    // Another rep cannot edit the owner's comment.
    const otherAddr = email('other');
    await inviteAndAccept(server, ownerAgent, {
      email: otherAddr,
      roleKey: 'rep',
      name: 'Owen Other',
    });
    const otherAgent = await loginAgent(server, otherAddr, 'member-pass-12');
    const forbidden = await otherAgent.patch(`/v1/comments/${commentId}`).send({
      body: 'Hijacked',
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('COMMENT_FORBIDDEN');

    // Owner (users:manage) may moderate.
    const edited = await ownerAgent.patch(`/v1/comments/${commentId}`).send({
      body: `Updated: @${repEmail} take another look.`,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.comment.body).toContain('take another look');
  });

  it('surfaces comments on the contact timeline and lists by entity', async () => {
    const timeline = await ownerAgent.get(`/v1/contacts/${contactId}/timeline`);
    const entry = (
      timeline.body.items as Array<{ type: string; summary: string; data: Record<string, unknown> }>
    ).find((i) => i.type === 'comment_added');
    expect(entry).toBeDefined();
    expect(entry!.summary).toContain('Comment:');

    const listed = await ownerAgent
      .get('/v1/comments')
      .query({ entityType: 'contact', entityId: contactId });
    expect(listed.status).toBe(200);
    expect((listed.body.comments as Array<{ id: string }>).some((c) => c.id === commentId)).toBe(
      true,
    );

    const removed = await ownerAgent.delete(`/v1/comments/${commentId}`).send();
    expect(removed.status).toBe(200);
    const after = await ownerAgent
      .get('/v1/comments')
      .query({ entityType: 'contact', entityId: contactId });
    expect((after.body.comments as Array<{ id: string }>).some((c) => c.id === commentId)).toBe(
      false,
    );
  });
});
