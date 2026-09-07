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

async function mailpitSubjects(toFragment: string): Promise<string[]> {
  const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=100`);
  const data = (await res.json()) as {
    messages?: Array<{ Subject: string; To?: Array<{ Address: string }> }>;
  };
  return (data.messages ?? [])
    .filter((m) => m.To?.some((t) => t.Address.includes(toFragment)))
    .map((m) => m.Subject);
}

describe('sequences cadences with reply auto-pause', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@sequences.test`;
  const person = (tag: string): string => `${tag}-${runId}@example.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let contactId: string;
  let sequenceId: string;

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
        orgName: `Sequences Org ${runId}`,
        name: 'Sally Owner',
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

    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Cadence Prospect',
      email: person('cadence'),
    });
    contactId = contact.body.contact.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('validates sequence definitions', async () => {
    const empty = await ownerAgent.post('/v1/sequences').send({ name: 'Empty', steps: [] });
    expect(empty.status).toBe(400);

    const badEmail = await ownerAgent.post('/v1/sequences').send({
      name: 'Bad step',
      steps: [{ kind: 'send_email' }],
    });
    expect(badEmail.status).toBe(400);

    const repAgent = await loginAgent(server, email('rep'), 'member-pass-12');
    const repList = await repAgent.get('/v1/sequences');
    expect(repList.status).toBe(200);

    const viewerAddr = email('viewer');
    await inviteAndAccept(server, ownerAgent, {
      email: viewerAddr,
      roleKey: 'viewer',
      name: 'Vera Viewer',
    });
    const viewerAgent = await loginAgent(server, viewerAddr, 'member-pass-12');
    const viewerBlocked = await viewerAgent.post('/v1/sequences').send({
      name: 'Sneaky',
      steps: [{ kind: 'wait', days: 1 }],
    });
    expect(viewerBlocked.status).toBe(403);
  });

  it('enrolls contacts and advances send and wait steps', async () => {
    const created = await ownerAgent.post('/v1/sequences').send({
      name: `Drip ${runId}`,
      steps: [
        { kind: 'send_email', subject: `Hello ${runId} {{contactName}}`, body: 'Step one here.' },
        { kind: 'wait', days: 30 },
        { kind: 'send_email', subject: `Bump ${runId}`, body: 'Step two here.' },
      ],
    });
    expect(created.status).toBe(201);
    sequenceId = created.body.sequence.id as string;

    const duplicate = await ownerAgent
      .post(`/v1/sequences/${sequenceId}/enrollments`)
      .send({ contactId });
    expect(duplicate.status).toBe(201);

    const again = await ownerAgent
      .post(`/v1/sequences/${sequenceId}/enrollments`)
      .send({ contactId });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('ALREADY_ENROLLED');

    const firstScan = await ownerAgent.post('/v1/sequences/due-scan').send();
    expect(firstScan.status).toBe(201);
    expect(firstScan.body.advanced).toBeGreaterThanOrEqual(1);

    const delivered = await findEmail(person('cadence'), `Hello ${runId} Cadence Prospect`);
    expect(delivered.Text).toContain('Step one here.');

    const enrollments = await ownerAgent.get(`/v1/sequences/${sequenceId}/enrollments`);
    const enrollment = (
      enrollments.body as Array<{ contact: { id: string }; currentStep: number; status: string }>
    ).find((e) => e.contact.id === contactId);
    expect(enrollment?.currentStep).toBe(1);

    // Wait step executes on the next scan, pushing the run 30 days out.
    const secondScan = await ownerAgent.post('/v1/sequences/due-scan').send();
    expect(secondScan.body.advanced).toBeGreaterThanOrEqual(1);
    const after = await ownerAgent.get(`/v1/sequences/${sequenceId}/enrollments`);
    const same = (after.body as Array<{ contact: { id: string }; nextRunAt: string }>).find(
      (e) => e.contact.id === contactId,
    );
    expect(new Date(same!.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);

    // Nothing left due: scans go quiet.
    const quiet = await ownerAgent.post('/v1/sequences/due-scan').send();
    expect(quiet.body.advanced).toBe(0);
  });

  it('auto-pauses enrollments when the contact replies', async () => {
    // Seed a thread the reply can match: sync the outbound first leg.
    await ownerAgent.post('/v1/emails/sync').send({
      provider: 'gmail',
      externalId: `seq-thread-${runId}`,
      from: email('owner'),
      to: [person('cadence')],
      subject: `Thread ${runId}`,
    });

    const reply = await ownerAgent.post('/v1/emails/sync').send({
      provider: 'gmail',
      externalId: `seq-reply-${runId}`,
      from: person('cadence'),
      to: [email('owner')],
      subject: `Re: Thread ${runId}`,
    });
    expect(reply.status).toBe(201);
    expect(reply.body.replyToId).toBeTruthy();

    const enrollments = await ownerAgent.get(`/v1/sequences/${sequenceId}/enrollments`);
    const enrollment = (
      enrollments.body as Array<{ contact: { id: string }; status: string }>
    ).find((e) => e.contact.id === contactId);
    expect(enrollment?.status).toBe('paused');
  });

  it('links reply chains and completes sequences', async () => {
    // Reply linkage is surfaced on the activity payload.
    const reply = await ownerAgent.post('/v1/emails/sync').send({
      provider: 'gmail',
      externalId: `seq-reply2-${runId}`,
      from: person('cadence'),
      to: [email('owner')],
      subject: `Re: Thread ${runId}`,
    });
    expect(reply.body.activity).toBeDefined();

    // Resume and fast-forward: backdate nextRunAt past the wait.
    const enrollments = await ownerAgent.get(`/v1/sequences/${sequenceId}/enrollments`);
    const enrollment = (enrollments.body as Array<{ id: string }>).find(() => true);
    await authDb.query(
      `UPDATE sequence_enrollments SET next_run_at = now() - interval '1 hour', status = 'active', current_step = 2 WHERE id = $1`,
      [enrollment!.id],
    );
    const scan = await ownerAgent.post('/v1/sequences/due-scan').send();
    expect(scan.body.advanced).toBeGreaterThanOrEqual(1);

    const subjects = await mailpitSubjects(person('cadence'));
    expect(subjects.some((s) => s.includes(`Bump ${runId}`))).toBe(true);

    const done = await ownerAgent.get(`/v1/sequences/${sequenceId}/enrollments`);
    const finished = (done.body as Array<{ contact: { id: string }; status: string }>).find(
      (e) => e.contact.id === contactId,
    );
    expect(finished?.status).toBe('completed');
  });

  it('parks failing enrollments instead of spinning', async () => {
    const doomed = await ownerAgent.post('/v1/sequences').send({
      name: `Doomed ${runId}`,
      steps: [{ kind: 'send_email', templateId: '00000000-0000-4000-8000-000000000000' }],
    });
    expect(doomed.status).toBe(201);
    const doomedId = doomed.body.sequence.id as string;
    await ownerAgent.post(`/v1/sequences/${doomedId}/enrollments`).send({ contactId });

    const scan = await ownerAgent.post('/v1/sequences/due-scan').send();
    expect(scan.body.failed).toBeGreaterThanOrEqual(1);

    const enrollments = await ownerAgent.get(`/v1/sequences/${doomedId}/enrollments`);
    expect((enrollments.body as Array<{ status: string }>)[0]?.status).toBe('paused');
  });
});
