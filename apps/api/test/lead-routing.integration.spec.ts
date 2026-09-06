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

describe('lead routing and round-robin engine', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@routing.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let rep1User: { id: string; email: string };
  let rep2User: { id: string; email: string };
  let rep3User: { id: string; email: string };
  let rep1Agent: request.Agent;
  let rep2Agent: request.Agent;

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
        orgName: `Routing Org ${runId}`,
        name: 'Rhonda Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    // Invite 3 reps
    rep1User = await inviteAndAccept(server, ownerAgent, {
      name: 'Rep Alpha',
      email: email('rep1'),
      roleKey: 'rep',
    });
    rep1Agent = await loginAgent(server, email('rep1'), 'member-pass-12');

    rep2User = await inviteAndAccept(server, ownerAgent, {
      name: 'Rep Beta',
      email: email('rep2'),
      roleKey: 'rep',
    });
    rep2Agent = await loginAgent(server, email('rep2'), 'member-pass-12');

    rep3User = await inviteAndAccept(server, ownerAgent, {
      name: 'Rep Gamma',
      email: email('rep3'),
      roleKey: 'rep',
    });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('creates and manages routing rules', async () => {
    const createRes = await ownerAgent.post('/v1/lead-routing/rules').send({
      name: 'Inbound Round Robin',
      strategy: 'round_robin',
      isActive: true,
      memberUserIds: [rep1User.id, rep2User.id, rep3User.id],
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe('Inbound Round Robin');
    expect(createRes.body.strategy).toBe('round_robin');
    expect(createRes.body.members.length).toBe(3);
    const ruleId = createRes.body.id;

    // List rules
    const listRes = await ownerAgent.get('/v1/lead-routing/rules');
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((r: { id: string }) => r.id === ruleId)).toBe(true);

    // Update rule
    const updateRes = await ownerAgent.patch(`/v1/lead-routing/rules/${ruleId}`).send({
      name: 'Updated Round Robin',
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.name).toBe('Updated Round Robin');
  });

  it('distributes incoming unassigned leads in round-robin sequence', async () => {
    // We have 3 reps in order: rep1, rep2, rep3
    // Create 3 leads sequentially without ownerId
    const l1 = await ownerAgent.post('/v1/leads').send({
      name: 'Lead One',
      email: email('rr-lead-1'),
    });
    expect(l1.status).toBe(201);
    expect(l1.body.lead.ownerId).toBe(rep1User.id);

    const l2 = await ownerAgent.post('/v1/leads').send({
      name: 'Lead Two',
      email: email('rr-lead-2'),
    });
    expect(l2.status).toBe(201);
    expect(l2.body.lead.ownerId).toBe(rep2User.id);

    const l3 = await ownerAgent.post('/v1/leads').send({
      name: 'Lead Three',
      email: email('rr-lead-3'),
    });
    expect(l3.status).toBe(201);
    expect(l3.body.lead.ownerId).toBe(rep3User.id);

    // 4th lead wraps back to rep1
    const l4 = await ownerAgent.post('/v1/leads').send({
      name: 'Lead Four',
      email: email('rr-lead-4'),
    });
    expect(l4.status).toBe(201);
    expect(l4.body.lead.ownerId).toBe(rep1User.id);
  });

  it('respects rep availability / PTO and excludes unavailable reps', async () => {
    // Rep 2 marks themselves unavailable (e.g. PTO)
    const ptoRes = await rep2Agent.patch('/v1/lead-routing/availability').send({
      isAvailable: false,
      oooReason: 'Vacation in Hawaii',
      returnAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(ptoRes.status).toBe(200);
    expect(ptoRes.body.isAvailable).toBe(false);

    // Verify availability endpoint returns status
    const getPto = await rep2Agent.get('/v1/lead-routing/availability');
    expect(getPto.status).toBe(200);
    expect(getPto.body.isAvailable).toBe(false);
    expect(getPto.body.oooReason).toBe('Vacation in Hawaii');

    // Available rotation now only contains rep1 and rep3
    // Create next 2 leads: they should alternate between rep1 and rep3, skipping rep2!
    const nextLead1 = await ownerAgent.post('/v1/leads').send({
      name: 'PTO Skip Lead 1',
      email: email('pto-skip-1'),
    });
    expect(nextLead1.status).toBe(201);
    expect([rep1User.id, rep3User.id]).toContain(nextLead1.body.lead.ownerId);

    const nextLead2 = await ownerAgent.post('/v1/leads').send({
      name: 'PTO Skip Lead 2',
      email: email('pto-skip-2'),
    });
    expect(nextLead2.status).toBe(201);
    expect([rep1User.id, rep3User.id]).toContain(nextLead2.body.lead.ownerId);
    expect(nextLead2.body.lead.ownerId).not.toBe(nextLead1.body.lead.ownerId);

    // Restore Rep 2 availability
    await rep2Agent.patch('/v1/lead-routing/availability').send({ isAvailable: true });
  });

  it('routes to fallback queue when all rotation reps are unavailable (PTO/OOO)', async () => {
    // Mark rep1, rep2, rep3 all unavailable
    await ownerAgent.patch(`/v1/lead-routing/availability/${rep1User.id}`).send({ isAvailable: false });
    await ownerAgent.patch(`/v1/lead-routing/availability/${rep2User.id}`).send({ isAvailable: false });
    await ownerAgent.patch(`/v1/lead-routing/availability/${rep3User.id}`).send({ isAvailable: false });

    // Create lead
    const fallbackLead = await ownerAgent.post('/v1/leads').send({
      name: 'Emergency Lead',
      email: email('emergency-fallback'),
      company: 'Crisis Corp',
    });
    expect(fallbackLead.status).toBe(201);
    const leadId = fallbackLead.body.lead.id;

    // Check assignment history to confirm fallback strategy was logged
    const historyRes = await ownerAgent.get(`/v1/leads/${leadId}/assignment-history`);
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.length).toBeGreaterThanOrEqual(1);
    expect(historyRes.body[0].strategy).toBe('fallback');
    expect(historyRes.body[0].reason).toContain('unavailable');

    // Restore reps
    await ownerAgent.patch(`/v1/lead-routing/availability/${rep1User.id}`).send({ isAvailable: true });
    await ownerAgent.patch(`/v1/lead-routing/availability/${rep2User.id}`).send({ isAvailable: true });
    await ownerAgent.patch(`/v1/lead-routing/availability/${rep3User.id}`).send({ isAvailable: true });
  });

  it('supports admin manual reassignment and logs complete assignment audit history', async () => {
    const lead = await ownerAgent.post('/v1/leads').send({
      name: 'Reassign Lead',
      email: email('reassign-target'),
    });
    expect(lead.status).toBe(201);
    const leadId = lead.body.lead.id;

    // Admin manually overrides assignment to Rep 3
    const reassignRes = await ownerAgent.post(`/v1/leads/${leadId}/reassign`).send({
      assignedToUserId: rep3User.id,
      reason: 'Assigned based on enterprise account specialization',
    });
    expect(reassignRes.status).toBe(200);
    expect(reassignRes.body.assignedToUserId).toBe(rep3User.id);

    // Verify lead owner is updated
    const getLead = await ownerAgent.get(`/v1/leads/${leadId}`);
    expect(getLead.body.ownerId).toBe(rep3User.id);

    // Check assignment history
    const historyRes = await ownerAgent.get(`/v1/leads/${leadId}/assignment-history`);
    expect(historyRes.status).toBe(200);
    expect(historyRes.body.length).toBeGreaterThanOrEqual(2);
    expect(historyRes.body[0].strategy).toBe('manual_override');
    expect(historyRes.body[0].assignedToUserId).toBe(rep3User.id);
    expect(historyRes.body[0].reason).toBe('Assigned based on enterprise account specialization');
  });
});
