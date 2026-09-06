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

describe('timeline and notes', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@timeline.test`;
  const contactEmail = (tag: string): string => `${tag}-${runId}@example.test`;

  let app: INestApplication;
  let server: Server;
  let db: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let contactId: string;

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
        orgName: `Timeline ${runId}`,
        name: 'Tina Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const created = await ownerAgent.post('/v1/contacts').send({
      name: 'Tim Timeline',
      email: contactEmail('tim'),
    });
    contactId = created.body.contact.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  it('shows the creation event for a fresh contact', async () => {
    const res = await ownerAgent.get(`/v1/contacts/${contactId}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].type).toBe('contact_created');
    expect(res.body.items[0].summary).toBe('Contact created');
    expect(res.body.items[0].actor.email).toBe(email('owner'));
    expect(res.body.nextCursor).toBeNull();
  });

  it('merges updates and notes newest-first without doubles', async () => {
    await ownerAgent.patch(`/v1/contacts/${contactId}`).send({ title: 'VP' });
    const note = await ownerAgent.post(`/v1/contacts/${contactId}/notes`).send({
      body: 'Called today, very interested.',
    });
    expect(note.status).toBe(201);
    expect(note.body.author.name).toBe('Tina Owner');

    const res = await ownerAgent.get(`/v1/contacts/${contactId}/timeline`);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items[0].type).toBe('note_added');
    expect(res.body.items[0].data.body).toBe('Called today, very interested.');
    expect(res.body.items[1].type).toBe('contact_updated');
    expect(res.body.items[1].summary).toBe('Updated title');
    expect(res.body.items[2].type).toBe('contact_created');
    // The note audit row must not appear as a second timeline item.
    expect(res.body.items.filter((i: { type: string }) => i.type === 'note_added')).toHaveLength(1);
  });

  it('paginates stably across inserts', async () => {
    for (let i = 0; i < 4; i += 1) {
      await ownerAgent.post(`/v1/contacts/${contactId}/notes`).send({ body: `Note ${i}` });
    }
    const first = await ownerAgent.get(`/v1/contacts/${contactId}/timeline`).query({ limit: 2 });
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await ownerAgent
      .get(`/v1/contacts/${contactId}/timeline`)
      .query({ limit: 2, cursor: first.body.nextCursor as string });
    expect(second.body.items).toHaveLength(2);
    const firstIds = (first.body.items as Array<{ id: string }>).map((i) => i.id);
    const secondIds = (second.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(secondIds.every((id) => !firstIds.includes(id))).toBe(true);

    const bad = await ownerAgent
      .get(`/v1/contacts/${contactId}/timeline`)
      .query({ cursor: 'bogus' });
    expect(bad.status).toBe(400);
  });

  it('supports note update and delete with author rules', async () => {
    const rep = await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    void rep;
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const ownContact = await repAgent.post('/v1/contacts').send({
      name: 'Rep Contact',
      email: contactEmail('rep-contact'),
    });
    const ownId = ownContact.body.contact.id as string;

    const note = await repAgent.post(`/v1/contacts/${ownId}/notes`).send({ body: 'mine' });
    const updated = await repAgent
      .patch(`/v1/contacts/${ownId}/notes/${note.body.id as string}`)
      .send({ body: 'mine edited' });
    expect(updated.status).toBe(200);
    expect(updated.body.body).toBe('mine edited');

    // Owner is not the author but holds users:manage via wildcard.
    const managerEdit = await ownerAgent
      .patch(`/v1/contacts/${ownId}/notes/${note.body.id as string}`)
      .send({ body: 'manager edited' });
    expect(managerEdit.status).toBe(200);

    const rep2 = await inviteAndAccept(server, ownerAgent, {
      email: email('rep2'),
      roleKey: 'rep',
      name: 'Randy Rep',
    });
    void rep2;
    const rep2Agent = await loginAgent(server, email('rep2'), 'member-pass-12');
    const forbidden = await rep2Agent
      .patch(`/v1/contacts/${ownId}/notes/${note.body.id as string}`)
      .send({ body: 'hijacked' });
    // rep2 cannot even read rep1's contact (own-scoped).
    expect([403, 404]).toContain(forbidden.status);

    const removed = await repAgent.delete(`/v1/contacts/${ownId}/notes/${note.body.id as string}`);
    expect(removed.status).toBe(200);
    const notes = await repAgent.get(`/v1/contacts/${ownId}/notes`);
    expect(notes.body).toEqual([]);
  });

  it('enforces record scoping and tenant isolation on timeline and notes', async () => {
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const blocked = await repAgent.get(`/v1/contacts/${contactId}/timeline`);
    expect(blocked.status).toBe(403);

    const other = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Timeline Other ${runId}`,
        name: 'O',
        email: email('other'),
        password: 'correct-horse-12',
      });
    orgIds.push(other.body.org.id as string);
    const otherAgent = await loginAgent(server, email('other'), 'correct-horse-12');
    const foreign = await otherAgent.get(`/v1/contacts/${contactId}/timeline`);
    expect(foreign.status).toBe(404);
    const foreignNote = await otherAgent
      .post(`/v1/contacts/${contactId}/notes`)
      .send({ body: 'x' });
    expect(foreignNote.status).toBe(404);
  });

  it('validates note bodies', async () => {
    const empty = await ownerAgent.post(`/v1/contacts/${contactId}/notes`).send({ body: '  ' });
    expect(empty.status).toBe(400);
    const missing = await ownerAgent.get('/v1/contacts/00000000-0000-0000-0000-000000000000/notes');
    expect(missing.status).toBe(404);
  });
});
