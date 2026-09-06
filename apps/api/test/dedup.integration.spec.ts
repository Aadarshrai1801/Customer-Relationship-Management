import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { DedupService } from '../src/dedup/dedup.service';
import { inviteAndAccept, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5432/nexus';

describe('dedup (matching, candidates, merge)', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@dedup.test`;
  const contactEmail = (tag: string): string => `${tag}-${runId}@example.test`;

  let app: INestApplication;
  let server: Server;
  let db: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
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
        orgName: `Dedup ${runId}`,
        name: 'Dana Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgId = signup.body.org.id as string;
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

  async function createContact(body: Record<string, unknown>): Promise<{ id: string }> {
    const res = await ownerAgent.post('/v1/contacts').send(body);
    expect(res.status).toBe(201);
    return { id: res.body.contact.id as string };
  }

  it('records an exact candidate on duplicate email and warns without blocking', async () => {
    const first = await createContact({ name: 'Exact One', email: contactEmail('exact') });
    const second = await ownerAgent.post('/v1/contacts').send({
      name: 'Exact Two',
      email: contactEmail('exact'),
    });
    expect(second.status).toBe(201);
    expect(second.body.warnings.map((w: { code: string }) => w.code)).toEqual(['DUPLICATE_EMAIL']);

    const list = await ownerAgent.get('/v1/duplicates').query({ entityType: 'contact' });
    const pair = (list.body as Array<{ records: Array<{ id: string }>; confidence: string }>).find(
      (c) => c.records.some((r) => r.id === first.id),
    );
    expect(pair?.confidence).toBe('exact');
  });

  it('documents the phone normalization limit (exact digits only)', async () => {
    const first = await createContact({
      name: 'Quentin Zebra',
      email: contactEmail('phone-one'),
      phone: '+1 (415) 555-0100',
    });
    const second = await ownerAgent.post('/v1/contacts').send({
      name: 'Xavier Yak',
      email: contactEmail('phone-two'),
      phone: '4155550100',
    });
    // Normalized digits differ (+1 prefix), so no high-confidence match fires.
    // Cross-format equivalence is a documented V1 limitation.
    expect(second.status).toBe(201);
    expect(second.body.warnings).toEqual([]);
    void first;
  });

  it('matches identical normalized phones with high confidence', async () => {
    await createContact({
      name: 'Phife Dawg',
      email: contactEmail('phife'),
      phone: '(415) 555-0199',
    });
    const second = await ownerAgent.post('/v1/contacts').send({
      name: 'Phife Different',
      email: contactEmail('phife-two'),
      phone: '415-555-0199',
    });
    const warnings = second.body.warnings as Array<{ code: string; confidence?: string }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'POSSIBLE_DUPLICATE', confidence: 'high' });
  });

  it('detects fuzzy name matches within the same domain', async () => {
    const first = await createContact({ name: 'Jon Smith', email: contactEmail('jon') });
    const second = await ownerAgent.post('/v1/contacts').send({
      name: 'John Smith',
      email: `john.smith-${runId}@example.test`,
    });
    expect(second.status).toBe(201);
    const warnings = second.body.warnings as Array<{ code: string; confidence?: string }>;
    const fuzzy = warnings.find((w) => w.code === 'POSSIBLE_DUPLICATE');
    expect(fuzzy?.confidence).toBe('medium');

    const list = await ownerAgent.get('/v1/duplicates').query({ entityType: 'contact' });
    const pair = (list.body as Array<{ records: Array<{ id: string }>; confidence: string }>).find(
      (c) => c.records.some((r) => r.id === first.id),
    );
    expect(pair?.confidence).toBe('medium');
  });

  it('ignores distinct records', async () => {
    const res = await ownerAgent.post('/v1/contacts').send({
      name: 'Zelda Unique',
      email: `zelda-${runId}@other-domain.test`,
      phone: '+44 20 7946 0000',
    });
    expect(res.body.warnings).toEqual([]);
  });

  it('dismisses candidates and never re-adds them on rescan', async () => {
    const list = await ownerAgent.get('/v1/duplicates').query({ entityType: 'contact' });
    expect((list.body as unknown[]).length).toBeGreaterThan(0);
    const first = (list.body as Array<{ id: string }>)[0]!;
    const dismissed = await ownerAgent.post(`/v1/duplicates/${first.id}/dismiss`);
    expect(dismissed.status).toBe(200);

    const stats = await app.get(DedupService).runNightlyScan();
    expect(stats.orgs).toBeGreaterThanOrEqual(1);
    const relist = await ownerAgent
      .get('/v1/duplicates')
      .query({ entityType: 'contact', status: 'pending' });
    const ids = (relist.body as Array<{ id: string }>).map((c) => c.id);
    expect(ids).not.toContain(first.id);
  });

  it('finds pairs created outside the create hook via the nightly scan', async () => {
    const { rows } = await db.query(
      `INSERT INTO contacts (org_id, owner_id, name, email) VALUES
        ($1, (SELECT id FROM users WHERE org_id = $1 LIMIT 1), 'Scan Alpha', 'scan-alpha-${runId}@example.test'),
        ($1, (SELECT id FROM users WHERE org_id = $1 LIMIT 1), 'Scan Alpha', 'scan-alpha-${runId}@example.test')
       RETURNING id`,
      [orgId],
    );
    const ids = rows.map((r: { id: string }) => r.id);
    await app.get(DedupService).runNightlyScan();
    const list = await ownerAgent.get('/v1/duplicates').query({ entityType: 'contact' });
    const pair = (list.body as Array<{ records: Array<{ id: string }> }>).find((c) =>
      ids.every((id: string) => c.records.some((r) => r.id === id)),
    );
    expect(pair).toBeDefined();
  });

  it('previews conflicts and merges with per-field choices', async () => {
    const winner = await createContact({
      name: 'Merge Winner',
      email: contactEmail('winner'),
      phone: '111',
      title: 'VP',
      tags: ['a'],
      lifecycleStage: 'lead',
    });
    const loser = await createContact({
      name: 'Merge Loser',
      email: contactEmail('loser'),
      phone: '222',
      title: 'Director',
      tags: ['b'],
      lifecycleStage: 'sql',
    });
    await ownerAgent.post(`/v1/contacts/${loser.id}/notes`).send({ body: 'loser note' });

    const preview = await ownerAgent.get(`/v1/contacts/${winner.id}/merge-preview`).query({
      loserId: loser.id,
    });
    expect(preview.status).toBe(200);
    const fields = preview.body.fields as Array<{ field: string; conflict: boolean }>;
    const conflicts = fields.filter((f) => f.conflict).map((f) => f.field);
    expect(conflicts).toContain('phone');
    expect(conflicts).toContain('title');
    // Different emails are a legitimate conflict with an explicit choice.
    expect(conflicts).toContain('email');
    expect(preview.body.notesMoved).toBe(1);

    const incomplete = await ownerAgent.post(`/v1/contacts/${winner.id}/merge`).send({
      loserId: loser.id,
      fieldChoices: { phone: 'loser' },
    });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.code).toBe('MERGE_CHOICE_INVALID');

    const choices: Record<string, 'winner' | 'loser'> = {};
    for (const field of conflicts) choices[field] = field === 'email' ? 'winner' : 'loser';
    const merged = await ownerAgent.post(`/v1/contacts/${winner.id}/merge`).send({
      loserId: loser.id,
      fieldChoices: choices,
    });
    expect(merged.status).toBe(201);
    expect(merged.body.contact.phone).toBe('222');
    expect(merged.body.contact.title).toBe('Director');
    expect(merged.body.contact.lifecycleStage).toBe('sql');
    expect(merged.body.contact.email).toBe(contactEmail('winner'));
    expect(merged.body.contact.tags.sort()).toEqual(['a', 'b']);

    const loserGone = await ownerAgent.get(`/v1/contacts/${loser.id}`);
    expect(loserGone.status).toBe(404);

    const timeline = await ownerAgent.get(`/v1/contacts/${winner.id}/timeline`);
    const types = (timeline.body.items as Array<{ type: string }>).map((i) => i.type);
    expect(types).toContain('contact_merged');
    expect(types).toContain('note_added');

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'contact.merged', entityId: winner.id });
    expect(audit.body.entries).toHaveLength(1);
    expect(audit.body.entries[0].newValues.loserEmail).toBe(contactEmail('loser'));
    expect(audit.body.entries[0].newValues.fieldChoices.phone).toBe('loser');
  });

  it('rejects self-merge, unknown fields, and unreadable pairs', async () => {
    const one = await createContact({ name: 'Selfie', email: contactEmail('selfie') });
    const self = await ownerAgent.post(`/v1/contacts/${one.id}/merge`).send({
      loserId: one.id,
      fieldChoices: {},
    });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('MERGE_SAME_RECORD');

    const two = await createContact({ name: 'Other', email: contactEmail('merge-other') });
    const unknown = await ownerAgent.post(`/v1/contacts/${one.id}/merge`).send({
      loserId: two.id,
      fieldChoices: { nope: 'winner' },
    });
    expect(unknown.status).toBe(400);

    const rep = await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    void rep;
    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const denied = await repAgent
      .post(`/v1/contacts/${one.id}/merge`)
      .send({ loserId: two.id, fieldChoices: {} });
    expect(denied.status).toBe(403);
  });

  it('detects and merges duplicate accounts', async () => {
    const first = await ownerAgent.post('/v1/accounts').send({
      name: 'Globex Corp',
      website: 'https://globex.test',
      phone: '555-0100',
    });
    expect(first.status).toBe(201);
    const second = await ownerAgent.post('/v1/accounts').send({
      name: 'Globex Corporation',
      website: 'https://globex.test/',
      domains: ['globex.test'],
    });
    expect(second.body.warnings.length).toBeGreaterThan(0);

    const list = await ownerAgent.get('/v1/duplicates').query({ entityType: 'account' });
    expect((list.body as unknown[]).length).toBeGreaterThan(0);

    const winnerId = first.body.account.id as string;
    const loserId = second.body.account.id as string;
    const preview = await ownerAgent
      .get(`/v1/accounts/${winnerId}/merge-preview`)
      .query({ loserId });
    expect(preview.status).toBe(200);
    const conflicts = (preview.body.fields as Array<{ field: string; conflict: boolean }>)
      .filter((f) => f.conflict)
      .map((f) => f.field);
    const choices: Record<string, 'winner' | 'loser'> = {};
    for (const field of conflicts) choices[field] = field === 'name' ? 'winner' : 'loser';
    const merged = await ownerAgent.post(`/v1/accounts/${winnerId}/merge`).send({
      loserId,
      fieldChoices: choices,
    });
    expect(merged.status).toBe(201);
    expect(merged.body.account.name).toBe('Globex Corp');
    expect(merged.body.account.domains).toContain('globex.test');

    const gone = await ownerAgent.get(`/v1/accounts/${loserId}`);
    expect(gone.status).toBe(404);
    void first;
  });
});
