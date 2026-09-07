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

describe('report CSV exports', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@export.test`;

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
        orgName: `Export Org ${runId}`,
        name: 'Ella Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    await inviteAndAccept(server, ownerAgent, {
      email: email('rep'),
      roleKey: 'rep',
      name: 'Rita Rep',
    });

    await ownerAgent.post('/v1/deals').send({ name: `Export Deal ${runId}`, amount: 10000 });
    await ownerAgent.post('/v1/activities').send({ type: 'call', subject: 'Export call' });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('exports forecast, pipeline, activity, and conversion as CSV', async () => {
    const forecast = await ownerAgent.get('/v1/reports/forecast/export');
    expect(forecast.status).toBe(200);
    expect(forecast.headers['content-type']).toContain('text/csv');
    expect(forecast.headers['content-disposition']).toContain('forecast-');
    expect(forecast.text).toContain(
      'owner,deals,pipeline_amount,best_case_amount,commit_amount,weighted',
    );
    expect(forecast.text).toContain('Ella Owner');
    expect(forecast.text).toContain('TOTAL,1,10000,0,0,1000');

    const pipeline = await ownerAgent.get('/v1/reports/pipeline/export');
    expect(pipeline.text).toContain('pipeline,stage,open_count,open_amount');
    expect(pipeline.text).toContain('Discovery');

    const activity = await ownerAgent.get('/v1/reports/activity/export');
    expect(activity.text).toContain('group,name,count');
    expect(activity.text).toContain('type,call,1');

    const conversion = await ownerAgent.get('/v1/reports/conversion/export');
    expect(conversion.text).toContain('metric,value');
    expect(conversion.text).toContain('deals_open,1');

    const unknown = await ownerAgent.get('/v1/reports/nonsense/export');
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('UNKNOWN_REPORT');
  });
});
