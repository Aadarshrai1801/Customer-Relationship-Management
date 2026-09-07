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

describe('emails inbound sync, suggestions, templates, and send', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@emails.test`;
  const person = (tag: string): string => `${tag}-${runId}@example.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let repAgent: request.Agent;
  let contactId: string;
  let templateId: string;

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
        orgName: `Emails Org ${runId}`,
        name: 'Emma Owner',
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
    repAgent = await loginAgent(server, email('rep'), 'member-pass-12');

    const contact = await ownerAgent.post('/v1/contacts').send({
      name: 'Emily Prospect',
      email: person('emily'),
    });
    expect(contact.status).toBe(201);
    contactId = contact.body.contact.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('syncs inbound mail and auto-links sender and recipient contacts', async () => {
    const fromContact = await ownerAgent.post('/v1/emails/sync').send({
      provider: 'gmail',
      externalId: `msg-${runId}-1`,
      from: person('emily'),
      to: [email('owner')],
      subject: 'Pricing question',
    });
    expect(fromContact.status).toBe(201);
    expect(fromContact.body.created).toBe(true);
    expect(fromContact.body.activity.direction).toBe('inbound');
    expect(fromContact.body.activity.contact?.id).toBe(contactId);

    // Recipient-side match also links.
    const toContact = await ownerAgent.post('/v1/emails/sync').send({
      provider: 'outlook',
      externalId: `msg-${runId}-2`,
      from: email('owner'),
      to: [person('emily')],
      subject: 'Re: Pricing question',
    });
    expect(toContact.status).toBe(201);
    expect(toContact.body.activity.contact?.id).toBe(contactId);
  });

  it('dedupes BCC copies against natively synced mail by message-id', async () => {
    const native = await ownerAgent.post('/v1/emails/sync').send({
      provider: 'gmail',
      externalId: `msg-${runId}-bcc`,
      from: person('emily'),
      to: [email('owner')],
      subject: 'BCC test',
    });
    expect(native.status).toBe(201);
    expect(native.body.created).toBe(true);

    const bccCopy = await ownerAgent.post('/v1/emails/sync').send({
      provider: 'bcc',
      externalId: `msg-${runId}-bcc`,
      from: person('emily'),
      to: [email('owner')],
      subject: 'BCC test',
    });
    expect(bccCopy.status).toBe(201);
    expect(bccCopy.body.created).toBe(false);
    expect(bccCopy.body.changed).toBe(false);
    expect(bccCopy.body.activity.id).toBe(native.body.activity.id);
  });

  it('queues unmatched mail as suggestions and converts to a contact', async () => {
    const stranger = await ownerAgent.post('/v1/emails/sync').send({
      provider: 'gmail',
      externalId: `msg-${runId}-stranger`,
      from: person('stranger'),
      to: [email('owner')],
      subject: 'Cold hello',
      body: 'Saw your product at a conference.',
    });
    expect(stranger.status).toBe(201);
    expect(stranger.body.activity.contact).toBeNull();
    const activityId = stranger.body.activity.id as string;

    const suggestions = await ownerAgent.get('/v1/emails/suggestions');
    expect(suggestions.status).toBe(200);
    const ids = (suggestions.body.suggestions as Array<{ id: string }>).map((s) => s.id);
    expect(ids).toContain(activityId);

    // Rep without contacts:manage cannot convert.
    const blocked = await repAgent.post(`/v1/emails/suggestions/${activityId}/convert`).send({
      name: 'Sneaky Person',
    });
    expect(blocked.status).toBe(403);

    const converted = await ownerAgent
      .post(`/v1/emails/suggestions/${activityId}/convert`)
      .send({ name: 'Sam Stranger' });
    expect(converted.status).toBe(201);
    expect(converted.body.activity.contact?.id).toBe(converted.body.contact.id);

    const contact = await ownerAgent.get(`/v1/contacts/${converted.body.contact.id as string}`);
    expect(contact.status).toBe(200);
    expect(contact.body.email).toBe(person('stranger'));

    // Converted mail leaves the suggestions queue.
    const after = await ownerAgent.get('/v1/emails/suggestions');
    const afterIds = (after.body.suggestions as Array<{ id: string }>).map((s) => s.id);
    expect(afterIds).not.toContain(activityId);

    // Email appears on the new contact timeline.
    const timeline = await ownerAgent.get(
      `/v1/contacts/${converted.body.contact.id as string}/timeline`,
    );
    const entry = (
      timeline.body.items as Array<{ type: string; data: Record<string, unknown> }>
    ).find((i) => i.type === 'activity_logged');
    expect(entry).toBeDefined();
    expect(entry!.data['activityType']).toBe('email');
  });

  it('manages templates with unique names per org', async () => {
    const created = await ownerAgent.post('/v1/email-templates').send({
      name: 'Intro',
      subject: 'Hi {{contactName}} from {{orgName}}',
      body: 'Hi {{contactName}},\n\nThis is {{ownerName}} at {{orgName}}. {{custom}}',
    });
    expect(created.status).toBe(201);
    templateId = created.body.template.id as string;

    const duplicate = await ownerAgent.post('/v1/email-templates').send({
      name: 'Intro',
      subject: 'x',
      body: 'y',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('TEMPLATE_NAME_TAKEN');

    const listed = await ownerAgent.get('/v1/email-templates');
    expect(listed.status).toBe(200);
    expect((listed.body as Array<{ id: string }>).some((t) => t.id === templateId)).toBe(true);

    const updated = await ownerAgent.patch(`/v1/email-templates/${templateId}`).send({
      subject: 'Hello {{contactName}}',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.template.subject).toBe('Hello {{contactName}}');
  });

  it('sends templated mail via SMTP, delivers, and auto-logs', async () => {
    const subjectTag = `intro-${runId}`;
    const sent = await ownerAgent.post('/v1/emails/send').send({
      to: person('emily'),
      templateId,
      variables: { custom: `ref ${subjectTag}` },
      contactId,
    });
    expect(sent.status).toBe(201);
    expect(sent.body.activity.direction).toBe('outbound');
    expect(sent.body.activity.contact?.id).toBe(contactId);
    expect(sent.body.activity.subject).toBe('Hello Emily Prospect');

    const delivered = await findEmail(person('emily'), 'Hello Emily Prospect');
    expect(delivered.Text).toContain('Emma Owner');
    expect(delivered.Text).toContain(`ref ${subjectTag}`);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'email.sent', entityId: sent.body.activity.id });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('sends free-form mail and links unknown recipients as suggestions later', async () => {
    const sent = await ownerAgent.post('/v1/emails/send').send({
      to: person('newbiz'),
      subject: `Quick note ${runId}`,
      body: 'Nice meeting you.',
    });
    expect(sent.status).toBe(201);
    expect(sent.body.activity.contact).toBeNull();

    // Outbound mail to unknown addresses is not a suggestion (inbound only).
    const suggestions = await ownerAgent.get('/v1/emails/suggestions');
    const ids = (suggestions.body.suggestions as Array<{ id: string }>).map((s) => s.id);
    expect(ids).not.toContain(sent.body.activity.id as string);

    const missing = await ownerAgent.post('/v1/emails/send').send({ to: person('newbiz') });
    expect(missing.status).toBe(400);

    const badAddress = await ownerAgent.post('/v1/emails/send').send({
      to: 'not-an-email',
      subject: 'x',
      body: 'y',
    });
    expect(badAddress.status).toBe(400);
  });

  it('isolates mail state by org', async () => {
    const otherSignup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Emails Foreign ${runId}`,
        name: 'Fiona Owner',
        email: email('foreign'),
        password: 'correct-horse-12',
      });
    expect(otherSignup.status).toBe(201);
    orgIds.push(otherSignup.body.org.id as string);
    const otherAgent = await loginAgent(server, email('foreign'), 'correct-horse-12');

    // Same message-id in another org creates its own row with no contact link.
    const foreign = await otherAgent.post('/v1/emails/sync').send({
      provider: 'gmail',
      externalId: `msg-${runId}-1`,
      from: person('emily'),
      to: [email('foreign')],
      subject: 'Pricing question',
    });
    expect(foreign.status).toBe(201);
    expect(foreign.body.created).toBe(true);
    expect(foreign.body.activity.contact).toBeNull();

    const foreignTemplates = await otherAgent.get('/v1/email-templates');
    expect(foreignTemplates.status).toBe(200);
    expect(foreignTemplates.body).toEqual([]);
  });
});
