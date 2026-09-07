import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';

describe('calendar sync ingestion', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@calsync.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let otherAgent: request.Agent;
  let contactId: string;
  let accountId: string;
  let eventId: string;

  const t0 = new Date(Date.now() - 3600000).toISOString();

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
        orgName: `CalSync Org ${runId}`,
        name: 'Cora Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const otherSignup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `CalSync Other ${runId}`,
        name: 'Otto Owner',
        email: email('other'),
        password: 'correct-horse-12',
      });
    expect(otherSignup.status).toBe(201);
    orgIds.push(otherSignup.body.org.id as string);
    otherAgent = await loginAgent(server, email('other'), 'correct-horse-12');

    const account = await ownerAgent.post('/v1/accounts').send({ name: `SyncCo ${runId}` });
    expect(account.status).toBe(201);
    accountId = account.body.account.id as string;

    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Sync Attendee',
      email: `attendee-${runId}@example.test`,
      accountId,
    });
    expect(contact.status).toBe(201);
    contactId = contact.body.contact.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('creates a meeting and auto-links the attendee contact and account', async () => {
    const synced = await ownerAgent.post('/v1/calendar-sync/events').send({
      provider: 'google',
      externalId: `evt-${runId}-1`,
      externalUpdatedAt: t0,
      subject: 'QBR Planning',
      attendeeEmails: [`attendee-${runId}@example.test`],
    });
    expect(synced.status).toBe(201);
    expect(synced.body.created).toBe(true);
    eventId = synced.body.activity.id as string;
    expect(synced.body.activity.type).toBe('meeting');
    expect(synced.body.activity.contact?.id).toBe(contactId);
    expect(synced.body.activity.account?.id).toBe(accountId);
    expect(synced.body.activity.provider).toBe('google');

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'activity.synced', entityId: eventId });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('keeps events with unknown attendees instead of dropping them', async () => {
    const synced = await ownerAgent.post('/v1/calendar-sync/events').send({
      provider: 'outlook',
      externalId: `evt-${runId}-stranger`,
      externalUpdatedAt: t0,
      subject: 'Cold intro',
      attendeeEmails: ['nobody-knows@example.test'],
    });
    expect(synced.status).toBe(201);
    expect(synced.body.created).toBe(true);
    expect(synced.body.activity.contact).toBeNull();
  });

  it('replays idempotently without duplicating', async () => {
    const replay = await ownerAgent.post('/v1/calendar-sync/events').send({
      provider: 'google',
      externalId: `evt-${runId}-1`,
      externalUpdatedAt: t0,
      subject: 'QBR Planning',
      attendeeEmails: [`attendee-${runId}@example.test`],
    });
    expect(replay.status).toBe(201);
    expect(replay.body.created).toBe(false);
    expect(replay.body.changed).toBe(false);
    expect(replay.body.activity.id).toBe(eventId);

    const listed = await ownerAgent.get('/v1/activities').query({ limit: 200 });
    const matches = (
      listed.body.activities as Array<{ provider: string | null; externalId: string | null }>
    ).filter((a) => a.provider === 'google' && a.externalId === `evt-${runId}-1`);
    expect(matches.length).toBe(1);
  });

  it('flags conflicts with most-recent-wins in both directions', async () => {
    const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
    const payload = (externalId: string, externalUpdatedAt: string, subject: string) => ({
      provider: 'google',
      externalId,
      externalUpdatedAt,
      subject,
      attendeeEmails: [`attendee-${runId}@example.test`],
    });

    // Provider-wins leg: incoming edit is newer than the local edit.
    const providerId = `evt-${runId}-conflict-provider`;
    const pCreate = await ownerAgent
      .post('/v1/calendar-sync/events')
      .send(payload(providerId, iso(-7200000), 'Sprint Review'));
    expect(pCreate.status).toBe(201);
    const pId = pCreate.body.activity.id as string;
    await ownerAgent.patch(`/v1/activities/${pId}`).send({ subject: 'Sprint Review (local)' });
    const providerWins = await ownerAgent
      .post('/v1/calendar-sync/events')
      .send(payload(providerId, iso(300000), 'Sprint Review (moved to Friday)'));
    expect(providerWins.status).toBe(201);
    expect(providerWins.body.changed).toBe(true);
    expect(providerWins.body.activity.conflictFlag).toBe(true);
    expect(providerWins.body.activity.subject).toBe('Sprint Review (moved to Friday)');

    // Local-wins leg: incoming edit is older than the local edit.
    const localId = `evt-${runId}-conflict-local`;
    const lCreate = await ownerAgent
      .post('/v1/calendar-sync/events')
      .send(payload(localId, iso(-7200000), 'Retro'));
    expect(lCreate.status).toBe(201);
    const lId = lCreate.body.activity.id as string;
    await ownerAgent.patch(`/v1/activities/${lId}`).send({ subject: 'Retro (final)' });
    const localWins = await ownerAgent
      .post('/v1/calendar-sync/events')
      .send(payload(localId, iso(-300000), 'Stale provider title'));
    expect(localWins.status).toBe(201);
    expect(localWins.body.changed).toBe(true);
    expect(localWins.body.activity.conflictFlag).toBe(true);
    expect(localWins.body.activity.subject).toBe('Retro (final)');
  });

  it('cancels provider-deleted events without deleting them', async () => {
    const cancelled = await ownerAgent.post('/v1/calendar-sync/events').send({
      provider: 'google',
      externalId: `evt-${runId}-1`,
      externalUpdatedAt: new Date(Date.now() + 180000).toISOString(),
      status: 'cancelled',
      attendeeEmails: [`attendee-${runId}@example.test`],
    });
    expect(cancelled.status).toBe(201);
    expect(cancelled.body.activity.syncStatus).toBe('cancelled');

    const fetched = await ownerAgent.get(`/v1/activities/${eventId}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.syncStatus).toBe('cancelled');
  });

  it('isolates synced events by org', async () => {
    const foreign = await otherAgent.post('/v1/calendar-sync/events').send({
      provider: 'google',
      externalId: `evt-${runId}-1`,
      externalUpdatedAt: t0,
      subject: 'Other org copy',
      attendeeEmails: [],
    });
    expect(foreign.status).toBe(201);
    expect(foreign.body.created).toBe(true);
    expect(foreign.body.activity.id).not.toBe(eventId);
    expect(foreign.body.activity.contact).toBeNull();
  });

  it('rejects invalid sync payloads', async () => {
    const badProvider = await ownerAgent.post('/v1/calendar-sync/events').send({
      provider: 'yahoo',
      externalId: 'x',
      externalUpdatedAt: t0,
    });
    expect(badProvider.status).toBe(400);

    const missing = await ownerAgent.post('/v1/calendar-sync/events').send({
      provider: 'google',
      externalUpdatedAt: t0,
    });
    expect(missing.status).toBe(400);
  });
});
