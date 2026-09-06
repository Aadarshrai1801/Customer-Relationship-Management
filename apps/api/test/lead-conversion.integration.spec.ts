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

describe('lead qualification and conversion', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@conversion.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let rep1User: { id: string; email: string };
  let rep2User: { id: string; email: string };
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
        orgName: `Conversion Org ${runId}`,
        name: 'Clara Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    // Invite two reps
    rep1User = await inviteAndAccept(server, ownerAgent, {
      name: 'Rep Charlie',
      email: email('rep1'),
      roleKey: 'rep',
    });
    rep1Agent = await loginAgent(server, email('rep1'), 'member-pass-12');

    rep2User = await inviteAndAccept(server, ownerAgent, {
      name: 'Rep Diana',
      email: email('rep2'),
      roleKey: 'rep',
    });
    rep2Agent = await loginAgent(server, email('rep2'), 'member-pass-12');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('converts a qualified lead into a new Contact and new Account, preserving notes and timeline', async () => {
    // 1. Create a lead
    const createRes = await ownerAgent
      .post('/v1/leads')
      .send({
        name: 'Bob Prospect',
        firstName: 'Bob',
        lastName: 'Prospect',
        email: email('bob-lead'),
        phone: '+1 555-987-6543',
        company: 'Stark Industries',
        title: 'Chief Technology Officer',
        notes: 'Had a discovery call. Ready to evaluate enterprise tier.',
        status: 'qualified',
        ownerId: rep1User.id,
      });
    expect(createRes.status).toBe(201);
    const leadId = createRes.body.lead.id;

    // 2. Convert the lead
    const convertRes = await ownerAgent
      .post(`/v1/leads/${leadId}/convert`)
      .send({});
    expect(convertRes.status).toBe(200);
    expect(convertRes.body.ok).toBe(true);
    expect(convertRes.body.contact).toBeDefined();
    expect(convertRes.body.account).toBeDefined();

    const contactId = convertRes.body.contact.id;
    const accountId = convertRes.body.account.id;

    // 3. Verify lead updated
    const leadDetail = await ownerAgent.get(`/v1/leads/${leadId}`);
    expect(leadDetail.status).toBe(200);
    expect(leadDetail.body.status).toBe('converted');
    expect(leadDetail.body.convertedAt).not.toBeNull();
    expect(leadDetail.body.convertedContactId).toBe(contactId);
    expect(leadDetail.body.convertedAccountId).toBe(accountId);

    // 4. Verify Contact created
    const contactDetail = await ownerAgent.get(`/v1/contacts/${contactId}`);
    expect(contactDetail.status).toBe(200);
    expect(contactDetail.body.name).toBe('Bob Prospect');
    expect(contactDetail.body.email).toBe(email('bob-lead'));
    expect(contactDetail.body.phone).toBe('+1 555-987-6543');
    expect(contactDetail.body.title).toBe('Chief Technology Officer');
    expect(contactDetail.body.accountId).toBe(accountId);
    expect(contactDetail.body.ownerId).toBe(rep1User.id);

    // 5. Verify Account created
    const accountDetail = await ownerAgent.get(`/v1/accounts/${accountId}`);
    expect(accountDetail.status).toBe(200);
    expect(accountDetail.body.name).toBe('Stark Industries');
    expect(accountDetail.body.ownerId).toBe(rep1User.id);

    // 6. Verify notes preserved as contact note
    const notesRes = await ownerAgent.get(`/v1/contacts/${contactId}/notes`);
    expect(notesRes.status).toBe(200);
    expect(Array.isArray(notesRes.body)).toBe(true);
    expect(notesRes.body.length).toBeGreaterThanOrEqual(1);
    expect(notesRes.body[0].body).toContain('Had a discovery call');
  });

  it('converts a lead linking to an existing Contact and existing Account', async () => {
    // 1. Create existing Account
    const accRes = await ownerAgent
      .post('/v1/accounts')
      .send({ name: 'Wayne Enterprises' });
    expect(accRes.status).toBe(201);
    const existingAccountId = accRes.body.account.id;

    // 2. Create existing Contact
    const ctRes = await ownerAgent
      .post('/v1/contacts')
      .send({
        name: 'Bruce Wayne',
        email: email('bruce-wayne'),
        accountId: existingAccountId,
      });
    expect(ctRes.status).toBe(201);
    const existingContactId = ctRes.body.contact.id;

    // 3. Create a lead for Bruce
    const leadRes = await ownerAgent
      .post('/v1/leads')
      .send({
        name: 'Bruce Wayne',
        email: email('bruce-wayne'),
        company: 'Wayne Enterprises',
        notes: 'Requested product comparison sheet',
      });
    expect(leadRes.status).toBe(201);
    const leadId = leadRes.body.lead.id;

    // 4. Convert lead passing existing contactId and accountId
    const convertRes = await ownerAgent
      .post(`/v1/leads/${leadId}/convert`)
      .send({
        contactId: existingContactId,
        accountId: existingAccountId,
      });

    expect(convertRes.status).toBe(200);
    expect(convertRes.body.contact.id).toBe(existingContactId);
    expect(convertRes.body.account.id).toBe(existingAccountId);

    const leadDetail = await ownerAgent.get(`/v1/leads/${leadId}`);
    expect(leadDetail.body.status).toBe('converted');
    expect(leadDetail.body.convertedContactId).toBe(existingContactId);
    expect(leadDetail.body.convertedAccountId).toBe(existingAccountId);
  });

  it('preserves matching custom fields during conversion from lead to contact', async () => {
    // 1. Create custom field definitions for lead and contact
    await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'lead',
      key: 'interest_tier',
      label: 'Interest Tier',
      type: 'text',
    });

    await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'interest_tier',
      label: 'Interest Tier',
      type: 'text',
    });

    // 2. Create lead with custom field value
    const leadRes = await ownerAgent
      .post('/v1/leads')
      .send({
        name: 'Eva Green',
        email: email('eva-green'),
        company: 'Green Bio',
        customFields: { interest_tier: 'high_priority' },
      });
    expect(leadRes.status).toBe(201);
    const leadId = leadRes.body.lead.id;

    // 3. Convert lead
    const convertRes = await ownerAgent
      .post(`/v1/leads/${leadId}/convert`)
      .send({});
    expect(convertRes.status).toBe(200);
    const contactId = convertRes.body.contact.id;

    // 4. Verify custom field was copied to contact
    const contactDetail = await ownerAgent.get(`/v1/contacts/${contactId}`);
    expect(contactDetail.status).toBe(200);
    expect(contactDetail.body.customFields?.interest_tier).toBe('high_priority');
  });

  it('rejects re-converting an already converted lead', async () => {
    const leadRes = await ownerAgent
      .post('/v1/leads')
      .send({
        name: 'Frank Miller',
        email: email('frank-miller'),
      });
    const leadId = leadRes.body.lead.id;

    // First conversion succeeds
    const firstConvert = await ownerAgent.post(`/v1/leads/${leadId}/convert`).send({});
    expect(firstConvert.status).toBe(200);

    // Second conversion fails
    const secondConvert = await ownerAgent.post(`/v1/leads/${leadId}/convert`).send({});
    expect(secondConvert.status).toBe(400);
    expect(secondConvert.body.code).toBe('LEAD_ALREADY_CONVERTED');
  });

  it('enforces record-level visibility scoping on conversion', async () => {
    // Create a lead owned by rep1
    const leadRes = await ownerAgent
      .post('/v1/leads')
      .send({
        name: 'George Secret',
        email: email('george-secret'),
        ownerId: rep1User.id,
      });
    const leadId = leadRes.body.lead.id;

    // Rep2 (own scope) tries to convert rep1's lead
    const forbiddenConvert = await rep2Agent
      .post(`/v1/leads/${leadId}/convert`)
      .send({});
    expect(forbiddenConvert.status).toBe(403);
    expect(forbiddenConvert.body.code).toBe('RECORD_FORBIDDEN');

    // Rep1 (owner) can convert their own lead
    const allowedConvert = await rep1Agent
      .post(`/v1/leads/${leadId}/convert`)
      .send({});
    expect(allowedConvert.status).toBe(200);
  });
});
