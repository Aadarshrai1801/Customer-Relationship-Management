import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { findEmail, loginAgent } from './helpers';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';

describe('quotes lifecycle with client acceptance', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@quotes.test`;
  const person = (tag: string): string => `${tag}-${runId}@example.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let dealId: string;
  let contactId: string;
  let quoteId: string;
  let publicToken: string;

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
        orgName: `Quotes Org ${runId}`,
        name: 'Quinn Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Quincy Client',
      email: person('quincy'),
    });
    contactId = contact.body.contact.id as string;

    const product = await ownerAgent.post('/v1/products').send({
      name: 'Consulting Day',
      unitPrice: 1000,
      currency: 'USD',
      taxRate: 0.1,
    });
    const productId = product.body.product.id as string;

    const deal = await ownerAgent.post('/v1/deals').send({
      name: `Quoted Deal ${runId}`,
      amount: 1000,
      contactId,
    });
    dealId = deal.body.deal.id as string;
    await ownerAgent.post(`/v1/deals/${dealId}/line-items`).send({
      productId,
      quantity: 2,
      discountRate: 0.1,
    });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('snapshots line items into totals with quote discount', async () => {
    const created = await ownerAgent.post('/v1/quotes').send({
      dealId,
      discountRate: 0.05,
      validUntilDays: 14,
    });
    expect(created.status).toBe(201);
    quoteId = created.body.quote.id as string;
    publicToken = created.body.quote.publicToken as string;
    // Line pre-tax net: 2 x 1000 x (1-0.10) = 1800 subtotal.
    expect(created.body.quote.subtotal).toBe(1800);
    expect(created.body.quote.discountTotal).toBe(90);
    // Tax on the discounted net: 1800 x 0.10 x (1710/1800) = 171.
    expect(created.body.quote.taxTotal).toBe(171);
    expect(created.body.quote.total).toBe(1881);
    expect(created.body.quote.status).toBe('draft');
    expect(created.body.quote.number).toMatch(/^Q-[0-9A-F]{8}$/);

    const bare = await ownerAgent.post('/v1/quotes').send({
      dealId: '00000000-0000-4000-8000-000000000000',
    });
    expect(bare.status).toBe(404);
  });

  it('sends quotes by email and serves a redacted public view', async () => {
    const sent = await ownerAgent.post(`/v1/quotes/${quoteId}/send`).send({});
    expect(sent.status).toBe(201);
    expect(sent.body.quote.status).toBe('sent');

    const delivered = await findEmail(person('quincy'), sent.body.quote.number as string);
    expect(delivered.Text).toContain('1881');

    const resend = await ownerAgent.post(`/v1/quotes/${quoteId}/send`).send({});
    expect(resend.status).toBe(409);
    expect(resend.body.code).toBe('QUOTE_LOCKED');

    const pub = await request(server).get(`/v1/quotes-public/${publicToken}`);
    expect(pub.status).toBe(200);
    expect(pub.body.total).toBe(1881);
    expect(pub.body.signature).toBeNull();
    expect(pub.body.deal).toBeNull();

    const missing = await request(server).get('/v1/quotes-public/nope-not-real');
    expect(missing.status).toBe(404);
  });

  it('records client acceptance as a stub signature', async () => {
    const accepted = await request(server).post(`/v1/quotes-public/${publicToken}/accept`).send({
      name: 'Quincy Client',
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.status).toBe('accepted');
    expect(accepted.body.signature.name).toBe('Quincy Client');
    expect(accepted.body.signature.provider).toBe('stub');

    const again = await request(server).post(`/v1/quotes-public/${publicToken}/accept`).send({
      name: 'Quincy Client',
    });
    expect(again.status).toBe(409);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'quote.accepted', entityId: dealId });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('supports decline and expiry', async () => {
    const second = await ownerAgent.post('/v1/quotes').send({ dealId });
    const secondId = second.body.quote.id as string;
    const secondToken = second.body.quote.publicToken as string;
    await ownerAgent.post(`/v1/quotes/${secondId}/send`).send({});

    const declined = await request(server).post(`/v1/quotes-public/${secondToken}/decline`).send({
      reason: 'Too expensive',
    });
    expect(declined.status).toBe(201);
    expect(declined.body.status).toBe('declined');

    // Backdate validity: reads report expired without a worker.
    await authDb.query(
      `UPDATE quotes SET valid_until = now() - interval '1 day', status = 'sent' WHERE id = $1`,
      [secondId],
    );
    const view = await request(server).get(`/v1/quotes-public/${secondToken}`);
    expect(view.body.status).toBe('expired');
    expect(view.body.expired).toBe(true);
    const late = await request(server).post(`/v1/quotes-public/${secondToken}/accept`).send({
      name: 'Late Larry',
    });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('QUOTE_EXPIRED');
  });

  it('isolates quotes by org and deal access', async () => {
    const otherSignup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Quotes Foreign ${runId}`,
        name: 'Fiona Owner',
        email: email('foreign'),
        password: 'correct-horse-12',
      });
    expect(otherSignup.status).toBe(201);
    orgIds.push(otherSignup.body.org.id as string);
    const otherAgent = await loginAgent(server, email('foreign'), 'correct-horse-12');

    const foreignView = await otherAgent.get(`/v1/quotes/${quoteId}`);
    expect(foreignView.status).toBe(404);

    const foreignList = await otherAgent.get('/v1/quotes');
    expect(foreignList.body).toEqual([]);
  });
});
