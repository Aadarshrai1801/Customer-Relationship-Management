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

describe('leads core crud and deduplication', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@leads.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let rep1Agent: request.Agent;
  let rep2Agent: request.Agent;
  let rep1Id: string;
  let rep2Id: string;

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
        orgName: `Leads Org ${runId}`,
        name: 'Larry Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    // Invite Rep 1
    const rep1User = await inviteAndAccept(server, ownerAgent, {
      name: 'Rep One',
      email: email('rep1'),
      roleKey: 'rep',
    });
    rep1Id = rep1User.id;
    rep1Agent = await loginAgent(server, email('rep1'), 'member-pass-12');

    // Invite Rep 2
    const rep2User = await inviteAndAccept(server, ownerAgent, {
      name: 'Rep Two',
      email: email('rep2'),
      roleKey: 'rep',
    });
    rep2Id = rep2User.id;
    rep2Agent = await loginAgent(server, email('rep2'), 'member-pass-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('creates, lists, retrieves, updates, and deletes a lead', async () => {
    const createRes = await ownerAgent.post('/v1/leads').send({
      firstName: 'Jane',
      lastName: 'Doe',
      email: email('lead1'),
      phone: '+1-555-0199',
      company: 'Acme Software',
      title: 'Head of Growth',
      status: 'new',
      source: 'organic_search',
      utmSource: 'google',
      utmCampaign: 'spring_launch',
      notes: 'Requested a product demo via contact form',
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.deduplicated).toBe(false);
    expect(createRes.body.lead.name).toBe('Jane Doe');
    expect(createRes.body.lead.email).toBe(email('lead1').toLowerCase());
    expect(createRes.body.lead.status).toBe('new');
    expect(createRes.body.lead.source).toBe('organic_search');
    expect(createRes.body.lead.utmSource).toBe('google');
    expect(createRes.body.lead.notes).toBe('Requested a product demo via contact form');

    const leadId = createRes.body.lead.id;

    // Retrieve single lead
    const getRes = await ownerAgent.get(`/v1/leads/${leadId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.id).toBe(leadId);
    expect(getRes.body.company).toBe('Acme Software');

    // List leads
    const listRes = await ownerAgent.get('/v1/leads');
    expect(listRes.status).toBe(200);
    expect(listRes.body.items.some((l: { id: string }) => l.id === leadId)).toBe(true);

    // Filter by status & source
    const filterRes = await ownerAgent.get('/v1/leads?status=new&source=organic_search');
    expect(filterRes.status).toBe(200);
    expect(filterRes.body.items.some((l: { id: string }) => l.id === leadId)).toBe(true);

    // Search query
    const searchRes = await ownerAgent.get('/v1/leads?q=Acme');
    expect(searchRes.status).toBe(200);
    expect(searchRes.body.items.some((l: { id: string }) => l.id === leadId)).toBe(true);

    // Update lead
    const patchRes = await ownerAgent.patch(`/v1/leads/${leadId}`).send({
      status: 'contacted',
      notes: 'Followed up via phone call',
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe('contacted');
    expect(patchRes.body.notes).toBe('Followed up via phone call');

    // Delete lead
    const delRes = await ownerAgent.delete(`/v1/leads/${leadId}`);
    expect(delRes.status).toBe(200);

    const getAfterDel = await ownerAgent.get(`/v1/leads/${leadId}`);
    expect(getAfterDel.status).toBe(404);
  });

  it('deduplicates identical email submissions within the 5-minute window', async () => {
    const leadEmail = email('rapid-lead');

    // First submission
    const res1 = await ownerAgent.post('/v1/leads').send({
      name: 'Rapid Lead',
      email: leadEmail,
      company: 'Fast Movers Inc',
      notes: 'First inquiry note',
    });
    expect(res1.status).toBe(201);
    expect(res1.body.deduplicated).toBe(false);
    const firstLeadId = res1.body.lead.id;

    // Second submission with same email within 5 minutes
    const res2 = await ownerAgent.post('/v1/leads').send({
      name: 'Rapid Lead Second Try',
      email: leadEmail,
      company: 'Fast Movers Inc',
      notes: 'Second inquiry note (same session)',
    });

    expect(res2.status).toBe(201);
    expect(res2.body.deduplicated).toBe(true);
    expect(res2.body.lead.id).toBe(firstLeadId);
    expect(res2.body.lead.notes).toContain('First inquiry note');
    expect(res2.body.lead.notes).toContain('Second inquiry note (same session)');

    // Ensure only 1 record exists in DB
    const listRes = await ownerAgent.get(`/v1/leads?q=${encodeURIComponent(leadEmail)}`);
    expect(listRes.status).toBe(200);
    const matching = listRes.body.items.filter((l: { email: string }) => l.email === leadEmail.toLowerCase());
    expect(matching.length).toBe(1);
  });

  it('enforces record-level visibility scoping (Rep sees own, Owner sees all)', async () => {
    // Rep 1 creates a lead (ownerId automatically scoped to Rep 1)
    const rep1LeadRes = await rep1Agent.post('/v1/leads').send({
      name: 'Rep One Lead',
      email: email('rep1-lead'),
      company: 'Alpha Corp',
    });
    expect(rep1LeadRes.status).toBe(201);
    expect(rep1LeadRes.body.lead.ownerId).toBe(rep1Id);
    const rep1LeadId = rep1LeadRes.body.lead.id;

    // Rep 2 creates a lead (ownerId automatically scoped to Rep 2)
    const rep2LeadRes = await rep2Agent.post('/v1/leads').send({
      name: 'Rep Two Lead',
      email: email('rep2-lead'),
      company: 'Beta Corp',
    });
    expect(rep2LeadRes.status).toBe(201);
    expect(rep2LeadRes.body.lead.ownerId).toBe(rep2Id);
    const rep2LeadId = rep2LeadRes.body.lead.id;

    // Rep 1 can see Rep 1's lead
    const rep1GetOwn = await rep1Agent.get(`/v1/leads/${rep1LeadId}`);
    expect(rep1GetOwn.status).toBe(200);

    // Rep 1 CANNOT see Rep 2's lead (403 forbidden)
    const rep1GetRep2 = await rep1Agent.get(`/v1/leads/${rep2LeadId}`);
    expect(rep1GetRep2.status).toBe(403);

    // Rep 1 CANNOT update Rep 2's lead
    const rep1PatchRep2 = await rep1Agent.patch(`/v1/leads/${rep2LeadId}`).send({ status: 'contacted' });
    expect(rep1PatchRep2.status).toBe(403);

    // Rep 1's list contains only Rep 1's leads
    const rep1List = await rep1Agent.get('/v1/leads');
    expect(rep1List.body.items.some((l: { id: string }) => l.id === rep1LeadId)).toBe(true);
    expect(rep1List.body.items.some((l: { id: string }) => l.id === rep2LeadId)).toBe(false);

    // Owner can see both leads
    const ownerList = await ownerAgent.get('/v1/leads');
    expect(ownerList.body.items.some((l: { id: string }) => l.id === rep1LeadId)).toBe(true);
    expect(ownerList.body.items.some((l: { id: string }) => l.id === rep2LeadId)).toBe(true);
  });

  it('supports custom fields on leads including formula calculation', async () => {
    // Create a number custom field 'budget' and formula field 'budget_tax'
    const field1Res = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'lead',
      key: 'budget',
      label: 'Estimated Budget',
      type: 'number',
    });
    expect(field1Res.status).toBe(201);

    const field2Res = await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'lead',
      key: 'budget_tax',
      label: 'Budget with Tax',
      type: 'formula',
      options: { expression: '{budget} * 1.1' },
    });
    expect(field2Res.status).toBe(201);

    // Create lead with custom field
    const createRes = await ownerAgent.post('/v1/leads').send({
      name: 'Custom Lead',
      email: email('custom-lead'),
      customFields: { budget: 1000 },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.lead.customFields.budget).toBe(1000);
    expect(createRes.body.lead.computedFields.budget_tax).toBe(1100);

    const leadId = createRes.body.lead.id;

    // Update custom field
    const patchRes = await ownerAgent.patch(`/v1/leads/${leadId}`).send({
      customFields: { budget: 2000 },
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.customFields.budget).toBe(2000);
    expect(patchRes.body.computedFields.budget_tax).toBe(2200);
  });
});
