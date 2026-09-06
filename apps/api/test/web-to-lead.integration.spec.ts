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

describe('web-to-lead ingestion and notifications', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@webtolead.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];
  let orgSlug: string;

  let ownerAgent: request.Agent;
  let repUser: { id: string; email: string };
  let repAgent: request.Agent;

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
        orgName: `WebToLead Org ${runId}`,
        name: 'Wanda Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    orgSlug = signup.body.org.slug as string;
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    // Invite a sales rep
    repUser = await inviteAndAccept(server, ownerAgent, {
      name: 'Rep Wendy',
      email: email('rep'),
      roleKey: 'rep',
    });
    repAgent = await loginAgent(server, email('rep'), 'member-pass-12');

    // Setup active round-robin rule with repWendy
    const ruleRes = await ownerAgent
      .post('/v1/lead-routing/rules')
      .send({
        name: 'Default Web Inbound Rule',
        strategy: 'round_robin',
        isActive: true,
        memberUserIds: [repUser.id],
      });
    expect(ruleRes.status).toBe(201);
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('ingests a lead via public endpoint with UTM attribution, assigns to rep, and dispatches notification', async () => {
    const ingestRes = await request(server)
      .post('/v1/web-to-lead')
      .send({
        token: orgSlug,
        name: 'Alice Inbound',
        email: email('lead-alice'),
        phone: '+1 555-123-4567',
        company: 'Wonderland Tech',
        title: 'VP Engineering',
        notes: 'Interested in enterprise plan demo',
        utmSource: 'google',
        utmMedium: 'cpc',
        utmCampaign: 'q3_growth',
        utmTerm: 'best crm software',
        utmContent: 'cta_button_top',
        referrerUrl: 'https://google.com/search',
      });

    expect(ingestRes.status).toBe(200);
    expect(ingestRes.body.success).toBe(true);
    expect(ingestRes.body.leadId).toBeDefined();
    expect(ingestRes.body.deduplicated).toBe(false);

    const leadId = ingestRes.body.leadId;

    // Verify lead details and attribution
    const leadDetail = await ownerAgent.get(`/v1/leads/${leadId}`);
    expect(leadDetail.status).toBe(200);
    expect(leadDetail.body.name).toBe('Alice Inbound');
    expect(leadDetail.body.company).toBe('Wonderland Tech');
    expect(leadDetail.body.ownerId).toBe(repUser.id);
    expect(leadDetail.body.utmSource).toBe('google');
    expect(leadDetail.body.utmMedium).toBe('cpc');
    expect(leadDetail.body.utmCampaign).toBe('q3_growth');

    // Verify assigned rep received in-app notification
    const repNotifs = await repAgent.get('/v1/notifications');
    expect(repNotifs.status).toBe(200);
    expect(repNotifs.body.unreadCount).toBeGreaterThanOrEqual(1);
    expect(repNotifs.body.items.length).toBeGreaterThanOrEqual(1);

    const targetNotif = repNotifs.body.items.find(
      (n: { link?: string }) => n.link === `/leads/${leadId}`,
    );
    expect(targetNotif).toBeDefined();
    expect(targetNotif.title).toContain('Alice Inbound');
    expect(targetNotif.type).toBe('lead_assigned');
    expect(targetNotif.readAt).toBeNull();
  });

  it('marks a notification as read and supports read-all', async () => {
    // List notifications for rep Wendy
    const notifs = await repAgent.get('/v1/notifications?unreadOnly=true');
    expect(notifs.status).toBe(200);
    expect(notifs.body.items.length).toBeGreaterThan(0);

    const first = notifs.body.items[0];

    // Mark single notification read
    const markRes = await repAgent.patch(`/v1/notifications/${first.id}/read`);
    expect(markRes.status).toBe(200);
    expect(markRes.body.readAt).not.toBeNull();

    // Mark all read
    const markAllRes = await repAgent.post('/v1/notifications/read-all');
    expect(markAllRes.status).toBe(200);

    // Verify unread count is now 0
    const afterAll = await repAgent.get('/v1/notifications?unreadOnly=true');
    expect(afterAll.status).toBe(200);
    expect(afterAll.body.unreadCount).toBe(0);
    expect(afterAll.body.items.length).toBe(0);
  });

  it('silently discards spam submissions filled with honeypot fields', async () => {
    const spamRes = await request(server)
      .post('/v1/web-to-lead')
      .send({
        token: orgSlug,
        name: 'Spam Bot',
        email: email('spambot'),
        notes: 'Buy cheap watches now!',
        _hp: 'I am a robot filling hidden inputs',
      });

    expect(spamRes.status).toBe(200);
    expect(spamRes.body.success).toBe(true);
    expect(spamRes.body.spam).toBe(true);
    expect(spamRes.body.leadId).toBeUndefined();

    // Verify no lead was created for spambot
    const checkLead = await ownerAgent.get(`/v1/leads?q=${email('spambot')}`);
    expect(checkLead.status).toBe(200);
    expect(checkLead.body.items.length).toBe(0);
  });

  it('enforces 5-minute de-duplication on rapid duplicate web-to-lead submissions', async () => {
    const firstRes = await request(server)
      .post('/v1/web-to-lead')
      .send({
        token: orgSlug,
        name: 'David Rapid',
        email: email('david-rapid'),
        company: 'Rapid Fire LLC',
        notes: 'Initial question',
      });

    expect(firstRes.status).toBe(200);
    expect(firstRes.body.deduplicated).toBe(false);
    const firstId = firstRes.body.leadId;

    // Immediately submit duplicate request with additional notes
    const secondRes = await request(server)
      .post('/v1/web-to-lead')
      .send({
        token: orgSlug,
        name: 'David Rapid',
        email: email('david-rapid'),
        company: 'Rapid Fire LLC',
        notes: 'Second follow-up note sent immediately',
      });

    expect(secondRes.status).toBe(200);
    expect(secondRes.body.deduplicated).toBe(true);
    expect(secondRes.body.leadId).toBe(firstId);

    // Verify notes appended, no second lead record created
    const leadDetail = await ownerAgent.get(`/v1/leads/${firstId}`);
    expect(leadDetail.status).toBe(200);
    expect(leadDetail.body.notes).toContain('Initial question');
    expect(leadDetail.body.notes).toContain('Second follow-up note');
  });

  it('generates an embeddable HTML web-to-lead snippet with tenant slug', async () => {
    const snippetRes = await ownerAgent.get('/v1/web-to-lead/snippet');
    expect(snippetRes.status).toBe(200);
    expect(snippetRes.body.slug).toBe(orgSlug);
    expect(snippetRes.body.html).toContain(`<input type="hidden" name="token" value="${orgSlug}"`);
    expect(snippetRes.body.html).toContain('name="_hp"');
    expect(snippetRes.body.html).toContain('form action=');
  });
});
