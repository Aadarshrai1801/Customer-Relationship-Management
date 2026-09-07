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

describe('scheduling links and public booking', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@scheduling.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];
  let ownerAgent: request.Agent;
  let slug: string;

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
        orgName: `Scheduling Org ${runId}`,
        name: 'Sam Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const created = await ownerAgent.post('/v1/booking-links').send({
      name: `Intro Call ${runId}`,
      durationMinutes: 30,
    });
    expect(created.status).toBe(201);
    slug = created.body.link.slug as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('enforces unique slugs per org', async () => {
    const listed = await ownerAgent.get('/v1/booking-links');
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ slug: string }>).some((l) => l.slug === slug)).toBe(true);

    const clash = await ownerAgent.post('/v1/booking-links').send({
      name: `Intro Call ${runId}`,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLUG_TAKEN');
  });

  it('serves future weekday availability for the public slug', async () => {
    const avail = await request(server).get(`/v1/book/${slug}/availability`);
    expect(avail.status).toBe(200);
    const slots = avail.body.slots as Array<{ startsAt: string; endsAt: string }>;
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots.slice(0, 5)) {
      const start = new Date(slot.startsAt);
      expect(start.getTime()).toBeGreaterThan(Date.now());
      expect([1, 2, 3, 4, 5]).toContain(start.getUTCDay());
      expect(new Date(slot.endsAt).getTime() - start.getTime()).toBe(30 * 60000);
    }
  });

  it('books a slot, then rejects a double-booking and past slots', async () => {
    const avail = await request(server).get(`/v1/book/${slug}/availability`);
    const first = (avail.body.slots as Array<{ startsAt: string }>)[0] as { startsAt: string };

    const booked = await request(server)
      .post(`/v1/book/${slug}`)
      .send({
        name: 'Prospect Pam',
        email: `pam-${runId}@example.com`,
        startsAt: first.startsAt,
      });
    expect(booked.status).toBe(201);
    expect(booked.body.booking.status).toBe('scheduled');

    // The taken slot disappears from availability and re-booking conflicts.
    const retry = await request(server)
      .post(`/v1/book/${slug}`)
      .send({
        name: 'Late Larry',
        email: `larry-${runId}@example.com`,
        startsAt: first.startsAt,
      });
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('SLOT_TAKEN');

    const past = await request(server)
      .post(`/v1/book/${slug}`)
      .send({
        name: 'Past Pete',
        email: `pete-${runId}@example.com`,
        startsAt: new Date(Date.now() - 3600000).toISOString(),
      });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('SLOT_PAST');

    // Booking created the contact and a meeting activity for them.
    const contacts = await ownerAgent.get('/v1/contacts').query({ q: `pam-${runId}` });
    expect(contacts.status).toBe(200);
    expect(
      (contacts.body.contacts as Array<{ email: string }>).some(
        (c) => c.email === `pam-${runId}@example.com`,
      ),
    ).toBe(true);
  });

  it('hides deactivated links from the public scheduler', async () => {
    const links = await ownerAgent.get('/v1/booking-links');
    const link = (links.body as Array<{ id: string; slug: string }>).find((l) => l.slug === slug);
    expect(link).toBeDefined();
    const updated = await ownerAgent
      .patch(`/v1/booking-links/${link?.id}`)
      .send({ isActive: false });
    expect(updated.status).toBe(200);
    expect(
      await request(server)
        .get(`/v1/book/${slug}/availability`)
        .then((r) => r.status),
    ).toBe(404);
    const reactivated = await ownerAgent
      .patch(`/v1/booking-links/${link?.id}`)
      .send({ isActive: true });
    expect(reactivated.status).toBe(200);
    expect(
      await request(server)
        .get(`/v1/book/${slug}/availability`)
        .then((r) => r.status),
    ).toBe(200);
  });
});

describe('approvals with quote discount gate', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@approvals.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let adminAgent: request.Agent;
  let dealId: string;
  let quoteId: string;

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
        orgName: `Approvals Org ${runId}`,
        name: 'Amy Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    await inviteAndAccept(server, ownerAgent, {
      email: email('admin'),
      roleKey: 'admin',
      name: 'Adam Admin',
    });
    adminAgent = await loginAgent(server, email('admin'), 'member-pass-12');

    const product = await ownerAgent.post('/v1/products').send({
      name: 'Big Block',
      unitPrice: 10000,
      currency: 'USD',
    });
    expect(product.status).toBe(201);
    const deal = await ownerAgent
      .post('/v1/deals')
      .send({ name: `Big Deal ${runId}`, amount: 10000 });
    dealId = deal.body.deal.id as string;
    await ownerAgent.post(`/v1/deals/${dealId}/line-items`).send({
      productId: product.body.product.id as string,
      quantity: 1,
    });
    const quote = await ownerAgent.post('/v1/quotes').send({ dealId, discountRate: 0.5 });
    expect(quote.status).toBe(201);
    quoteId = quote.body.quote.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('blocks high-discount sends until approved', async () => {
    const blocked = await ownerAgent.post(`/v1/quotes/${quoteId}/send`).send({});
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('APPROVAL_REQUIRED');

    const requested = await ownerAgent.post('/v1/approvals').send({
      entityType: 'quote',
      entityId: quoteId,
      action: 'quote_discount',
      payload: { discountRate: 0.5 },
    });
    expect(requested.status).toBe(201);
    const approvalId = requested.body.approval.id as string;

    const duplicate = await ownerAgent.post('/v1/approvals').send({
      entityType: 'quote',
      entityId: quoteId,
      action: 'quote_discount',
    });
    expect(duplicate.status).toBe(409);

    // Requesters cannot self-approve, not even the owner.
    const selfApproved = await ownerAgent.post(`/v1/approvals/${approvalId}/approve`).send({});
    expect(selfApproved.status).toBe(403);
    expect(selfApproved.body.code).toBe('SELF_APPROVAL');

    const approved = await adminAgent.post(`/v1/approvals/${approvalId}/approve`).send({});
    expect(approved.status).toBe(201);
    expect(approved.body.approval.status).toBe('approved');

    const sent = await ownerAgent
      .post(`/v1/quotes/${quoteId}/send`)
      .send({ to: `buyer-${runId}@example.com` });
    expect(sent.status).toBe(201);
    expect(sent.body.quote.status).toBe('sent');
  });

  it('lists approvals for reviewers only', async () => {
    const listed = await adminAgent.get('/v1/approvals').query({ status: 'approved' });
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ id: string }>).length).toBeGreaterThanOrEqual(1);

    const repAddr = email('rep');
    await inviteAndAccept(server, ownerAgent, {
      email: repAddr,
      roleKey: 'rep',
      name: 'Rita Rep',
    });
    const repAgent = await loginAgent(server, repAddr, 'member-pass-12');
    const blocked = await repAgent.get('/v1/approvals');
    expect(blocked.status).toBe(403);
  });
});
