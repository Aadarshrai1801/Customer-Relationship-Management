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

describe('products catalog and deal line items', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@products.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let otherAgent: request.Agent;
  let dealId: string;
  let productId: string;

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
        orgName: `Products Org ${runId}`,
        name: 'Pam Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    const otherSignup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Other Org ${runId}`,
        name: 'Owen Owner',
        email: email('other'),
        password: 'correct-horse-12',
      });
    expect(otherSignup.status).toBe(201);
    orgIds.push(otherSignup.body.org.id as string);
    otherAgent = await loginAgent(server, email('other'), 'correct-horse-12');

    const deal = await ownerAgent.post('/v1/deals').send({ name: 'Line Item Deal', amount: 5000 });
    expect(deal.status).toBe(201);
    dealId = deal.body.deal.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('creates, lists, updates, and deletes catalog products', async () => {
    const created = await ownerAgent.post('/v1/products').send({
      name: 'Implementation Package',
      sku: 'SVC-IMPL',
      unitPrice: 2500,
      currency: 'USD',
      taxRate: 0.1,
    });
    expect(created.status).toBe(201);
    productId = created.body.product.id as string;
    expect(created.body.product.name).toBe('Implementation Package');

    const list = await ownerAgent.get('/v1/products');
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).some((p) => p.id === productId)).toBe(true);

    const updated = await ownerAgent.patch(`/v1/products/${productId}`).send({ unitPrice: 3000 });
    expect(updated.status).toBe(200);
    expect(Number(updated.body.product.unitPrice)).toBe(3000);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'product.created', entityId: productId });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('rejects invalid product input', async () => {
    const blank = await ownerAgent.post('/v1/products').send({ name: '', unitPrice: 10 });
    expect(blank.status).toBe(400);

    const negative = await ownerAgent
      .post('/v1/products')
      .send({ name: 'Bad Price', unitPrice: -5 });
    expect(negative.status).toBe(400);

    const currency = await ownerAgent
      .post('/v1/products')
      .send({ name: 'Bad Currency', unitPrice: 5, currency: 'USDD' });
    expect(currency.status).toBe(400);
  });

  it('isolates the catalog by org', async () => {
    const foreign = await otherAgent.get('/v1/products');
    expect(foreign.status).toBe(200);
    expect((foreign.body as Array<{ id: string }>).some((p) => p.id === productId)).toBe(false);

    const steal = await otherAgent.patch(`/v1/products/${productId}`).send({ unitPrice: 1 });
    expect(steal.status).toBe(404);
    expect(steal.body.code).toBe('PRODUCT_NOT_FOUND');
  });

  it('adds a line item snapshotting the product and computing totals', async () => {
    const added = await ownerAgent.post(`/v1/deals/${dealId}/line-items`).send({
      productId,
      quantity: 2,
      discountRate: 0.1,
    });
    expect(added.status).toBe(201);
    const line = added.body.lineItem;
    // 2 x 3000 x (1 - 0.10) x (1 + 0.10) = 5940
    expect(Number(line.lineTotal)).toBe(5940);
    expect(line.name).toBe('Implementation Package');
    expect(line.productId).toBe(productId);

    const listed = await ownerAgent.get(`/v1/deals/${dealId}/line-items`);
    expect(listed.status).toBe(200);
    expect(listed.body.length).toBe(1);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'deal.line_item_added', entityId: dealId });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('adds a free-form line item without a product', async () => {
    const added = await ownerAgent.post(`/v1/deals/${dealId}/line-items`).send({
      name: 'Custom Onboarding',
      quantity: 1,
      unitPrice: 750,
      currency: 'USD',
    });
    expect(added.status).toBe(201);
    expect(Number(added.body.lineItem.lineTotal)).toBe(750);
    expect(added.body.lineItem.productId).toBeNull();

    const missing = await ownerAgent.post(`/v1/deals/${dealId}/line-items`).send({ quantity: 1 });
    expect(missing.status).toBe(400);
  });

  it('removes line items and guards cross-deal access', async () => {
    const listed = await ownerAgent.get(`/v1/deals/${dealId}/line-items`);
    const lines = listed.body as Array<{ id: string; name: string }>;
    expect(lines.length).toBe(2);
    // Remove the free-form line; the product-sourced line must survive for the
    // snapshot test below.
    const target = lines.find((l) => l.name === 'Custom Onboarding');
    expect(target).toBeDefined();
    const targetId = (target as { id: string }).id;

    const otherDeal = await ownerAgent.post('/v1/deals').send({ name: 'Other Deal', amount: 10 });
    const otherId = otherDeal.body.deal.id as string;
    const cross = await ownerAgent.delete(`/v1/deals/${otherId}/line-items/${targetId}`);
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe('LINE_ITEM_NOT_FOUND');

    const removed = await ownerAgent.delete(`/v1/deals/${dealId}/line-items/${targetId}`);
    expect(removed.status).toBe(200);

    const after = await ownerAgent.get(`/v1/deals/${dealId}/line-items`);
    expect((after.body as Array<{ id: string }>).some((l) => l.id === targetId)).toBe(false);
  });

  it('deletes a product while line items keep their snapshot', async () => {
    const deleted = await ownerAgent.delete(`/v1/products/${productId}`);
    expect(deleted.status).toBe(200);

    const listed = await ownerAgent.get(`/v1/deals/${dealId}/line-items`);
    const survivors = listed.body as Array<{ productId: string | null; name: string }>;
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.every((l) => l.productId === null)).toBe(true);
    expect(survivors.some((l) => l.name === 'Implementation Package')).toBe(true);
  });
});
