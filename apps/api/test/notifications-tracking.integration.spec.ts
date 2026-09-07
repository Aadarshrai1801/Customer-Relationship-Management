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
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

async function mailpitHtml(toFragment: string, subjectFragment: string): Promise<string> {
  const started = Date.now();
  for (;;) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=100`);
    const data = (await res.json()) as {
      messages?: Array<{ ID: string; Subject: string; To?: Array<{ Address: string }> }>;
    };
    const match = (data.messages ?? []).find(
      (m) =>
        m.To?.some((t) => t.Address.includes(toFragment)) && m.Subject.includes(subjectFragment),
    );
    if (match) {
      const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${match.ID}`)).json()) as {
        HTML?: string;
      };
      return full.HTML ?? '';
    }
    if (Date.now() - started > 15000) throw new Error('email not found in Mailpit');
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe('notification preferences', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@notifprefs.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let repAgent: request.Agent;
  let repEmail: string;

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
        orgName: `NotifPrefs Org ${runId}`,
        name: 'Nina Owner',
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
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('stores and validates channel preferences', async () => {
    const empty = await repAgent.get('/v1/notifications/preferences');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({});

    const set = await repAgent.post('/v1/notifications/preferences').send({
      type: 'mention',
      channels: ['inapp'],
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ type: 'mention', channels: ['inapp'] });

    const listed = await repAgent.get('/v1/notifications/preferences');
    expect(listed.body).toEqual({ mention: ['inapp'] });

    const badChannels = await repAgent.post('/v1/notifications/preferences').send({
      type: 'mention',
      channels: ['carrier-pigeon'],
    });
    expect(badChannels.status).toBe(400);

    const emptyChannels = await repAgent.post('/v1/notifications/preferences').send({
      type: 'mention',
      channels: [],
    });
    expect(emptyChannels.status).toBe(400);
  });

  it('suppresses opted-out mention channels only', async () => {
    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Mention Target',
      email: `mention-${runId}@example.test`,
    });
    const before = await repAgent.get('/v1/notifications');
    const beforeCount = (before.body.items as Array<{ type: string }>).filter(
      (n) => n.type === 'mention',
    ).length;

    await ownerAgent.post('/v1/comments').send({
      entityType: 'contact',
      entityId: contact.body.contact.id as string,
      body: `Hey @${repEmail}, look here ${runId}.`,
    });

    // In-app kept, email suppressed by the preference above.
    const after = await repAgent.get('/v1/notifications');
    const mentions = (after.body.items as Array<{ type: string }>).filter(
      (n) => n.type === 'mention',
    );
    expect(mentions.length).toBe(beforeCount + 1);

    // Re-enable email and confirm delivery resumes.
    await repAgent.post('/v1/notifications/preferences').send({
      type: 'mention',
      channels: ['inapp', 'email'],
    });
    const marker = `second ping ${runId}`;
    await ownerAgent.post('/v1/comments').send({
      entityType: 'contact',
      entityId: contact.body.contact.id as string,
      body: `Hey @${repEmail}, ${marker}.`,
    });
    const delivered = await findEmail(repEmail, 'mentioned you');
    expect(delivered.Text).toContain(marker);
  });

  it('skips digest owners opted out of in-app without stamping', async () => {
    await repAgent.post('/v1/notifications/preferences').send({
      type: 'task_digest',
      channels: ['email'],
    });
    const task = await repAgent.post('/v1/tasks').send({
      title: `Digest task ${runId}`,
      remindAt: new Date(Date.now() - 60000).toISOString(),
    });
    expect(task.status).toBe(201);

    const dispatch = await ownerAgent.post('/v1/tasks/reminders/dispatch').send();
    expect(dispatch.status).toBe(201);

    const notifs = await repAgent.get('/v1/notifications');
    const digests = (notifs.body.items as Array<{ type: string }>).filter(
      (n) => n.type === 'task_digest',
    );
    expect(digests.length).toBe(0);

    // Digest email still goes out (email channel on).
    const mailed = await findEmail(repEmail, 'Daily task digest');
    expect(mailed.Text).toContain(`Digest task ${runId}`);
  });
});

describe('email tracking pixel, clicks, and toggle', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@tracking.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];
  let ownerAgent: request.Agent;

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
        orgName: `Tracking Org ${runId}`,
        name: 'Tina Owner',
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
    await app.close();
  });

  it('embeds pixel and rewritten links, then records opens and clicks', async () => {
    const subject = `Tracked ${runId}`;
    const sent = await ownerAgent.post('/v1/emails/send').send({
      to: `reader-${runId}@example.test`,
      subject,
      body: `Read this https://example.test/docs/${runId} please.`,
    });
    expect(sent.status).toBe(201);
    const activityId = sent.body.activity.id as string;

    const html = await mailpitHtml(`reader-${runId}@example.test`, subject);
    expect(html).toContain('/email-tracking/open/');
    expect(html).toContain('/email-tracking/click/');
    expect(html).toContain(`docs%2F${runId}`);

    const pixelPath = html.match(/\/email-tracking\/open\/([A-Za-z0-9._-]+)/)?.[0];
    expect(pixelPath).toBeTruthy();
    const pixel = await request(server).get(`/v1${pixelPath}`);
    expect(pixel.status).toBe(200);
    expect(pixel.headers['content-type']).toContain('image/gif');

    const clickMatch = html.match(/\/email-tracking\/click\/([A-Za-z0-9._-]+)\?u=([^"&\s]+)/);
    expect(clickMatch).toBeTruthy();
    const click = await request(server)
      .get(`/v1${clickMatch![0].split('?')[0]}`)
      .query({ u: decodeURIComponent(clickMatch![2]!) })
      .redirects(0);
    expect(click.status).toBe(302);
    expect(click.headers['location']).toBe(`https://example.test/docs/${runId}`);

    const summary = await ownerAgent.get(`/v1/emails/${activityId}/tracking`);
    expect(summary.status).toBe(200);
    expect(summary.body.opens).toBeGreaterThanOrEqual(1);
    expect(summary.body.clicks).toBe(1);
  });

  it('ignores forged tokens and bad redirect targets', async () => {
    const pixel = await request(server).get('/v1/email-tracking/open/forged.token.here');
    expect(pixel.status).toBe(200);

    const badClick = await request(server).get('/v1/email-tracking/click/also.forged').query({
      u: 'https://example.test/',
    });
    expect(badClick.status).toBe(404);
  });

  it('honors the org tracking toggle', async () => {
    await ownerAgent.patch('/v1/org/settings').send({ emailTrackingEnabled: false });
    const subject = `Untracked ${runId}`;
    await ownerAgent.post('/v1/emails/send').send({
      to: `plain-${runId}@example.test`,
      subject,
      body: 'No tracking here.',
    });
    const html = await mailpitHtml(`plain-${runId}@example.test`, subject);
    expect(html).not.toContain('/email-tracking/');
    await ownerAgent.patch('/v1/org/settings').send({ emailTrackingEnabled: true });
  });
});
