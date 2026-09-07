import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PipelinesService } from '../src/pipelines/pipelines.service';

const AUTH_DATABASE_URL =
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5433/nexus';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://nexus_app:nexus_app@localhost:5433/nexus';

describe('pipelines schema, seeding, and currency snapshots', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@pipelines.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  let appDb: Pool;
  const orgIds: string[] = [];
  let orgAId: string;
  let orgBId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    authDb = new Pool({ connectionString: AUTH_DATABASE_URL });
    appDb = new Pool({ connectionString: DATABASE_URL });

    const signupA = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Pipelines Org A ${runId}`,
        name: 'Pippa Owner',
        email: email('owner-a'),
        password: 'correct-horse-12',
      });
    expect(signupA.status).toBe(201);
    orgAId = signupA.body.org.id as string;
    orgIds.push(orgAId);

    const signupB = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Pipelines Org B ${runId}`,
        name: 'Owen Owner',
        email: email('owner-b'),
        password: 'correct-horse-12',
      });
    expect(signupB.status).toBe(201);
    orgBId = signupB.body.org.id as string;
    orgIds.push(orgBId);
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await appDb.end();
    await app.close();
  });

  it('seeds a default pipeline with ordered stages on signup', async () => {
    const service = app.get(PipelinesService);
    const seeded = await service.listPipelines(orgAId);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.pipeline.slug).toBe('sales');
    expect(seeded[0]!.pipeline.isDefault).toBe(true);
    expect(
      seeded[0]!.stages.map((s) => [s.key, s.probability, s.isClosedWon, s.isClosedLost]),
    ).toEqual([
      ['discovery', 10, false, false],
      ['proposal', 50, false, false],
      ['negotiation', 75, false, false],
      ['closed-won', 100, true, false],
      ['closed-lost', 0, false, true],
    ]);

    const again = await service.ensureDefaultPipeline(orgAId);
    expect(again.pipeline.id).toBe(seeded[0]!.pipeline.id);
    const relisted = await service.listPipelines(orgAId);
    expect(relisted).toHaveLength(1);
  });

  it('isolates pipelines per tenant at the database layer', async () => {
    const service = app.get(PipelinesService);
    const mine = await service.listPipelines(orgBId);
    expect(mine).toHaveLength(1);
    const theirs = await service.listPipelines(orgAId);
    expect(mine[0]!.pipeline.id).not.toBe(theirs[0]!.pipeline.id);

    const withoutTenant = await appDb.query('SELECT count(*)::int AS n FROM pipelines');
    expect(withoutTenant.rows[0].n).toBe(0);
  });

  it('stores and resolves daily exchange-rate snapshots', async () => {
    const service = app.get(PipelinesService);
    const saved = await service.upsertExchangeRates(orgAId, {
      rateDate: '2026-09-07',
      baseCurrency: 'usd',
      rates: { eur: 0.92, gbp: 0.79 },
    });
    expect(saved).toMatchObject({ rateDate: '2026-09-07', baseCurrency: 'USD' });
    expect(saved.rates).toEqual({ EUR: 0.92, GBP: 0.79 });

    await expect(
      service.getExchangeRate(orgAId, {
        currency: 'EUR',
        baseCurrency: 'USD',
        rateDate: '2026-09-07',
      }),
    ).resolves.toMatchObject({ rate: 0.92 });
    await expect(
      service.getExchangeRate(orgAId, {
        currency: 'USD',
        baseCurrency: 'USD',
        rateDate: '2026-09-07',
      }),
    ).resolves.toMatchObject({ rate: 1 });
    await expect(
      service.getExchangeRate(orgAId, {
        currency: 'JPY',
        baseCurrency: 'USD',
        rateDate: '2026-09-07',
      }),
    ).rejects.toMatchObject({ response: { code: 'RATE_MISSING' } });
    await expect(
      service.getExchangeRate(orgAId, {
        currency: 'EUR',
        baseCurrency: 'USD',
        rateDate: '2026-09-06',
      }),
    ).rejects.toMatchObject({ response: { code: 'RATE_SNAPSHOT_MISSING' } });
  });

  it('rejects invalid currency snapshots', async () => {
    const service = app.get(PipelinesService);
    await expect(
      service.upsertExchangeRates(orgAId, {
        rateDate: '2026-09-07',
        baseCurrency: 'XX',
        rates: { EUR: 0.92 },
      }),
    ).rejects.toMatchObject({ response: { code: 'CURRENCY_INVALID' } });
    await expect(
      service.upsertExchangeRates(orgAId, {
        rateDate: '09/07/2026',
        baseCurrency: 'USD',
        rates: { EUR: 0.92 },
      }),
    ).rejects.toMatchObject({ response: { code: 'RATE_DATE_INVALID' } });
    await expect(
      service.upsertExchangeRates(orgAId, {
        rateDate: '2026-09-07',
        baseCurrency: 'USD',
        rates: { EUR: 0 },
      }),
    ).rejects.toMatchObject({ response: { code: 'RATE_INVALID' } });
  });
});
