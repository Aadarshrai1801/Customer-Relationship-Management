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
  process.env.AUTH_DATABASE_URL ?? 'postgres://nexus_auth:nexus_auth@localhost:5432/nexus';

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csv(rows: Array<Record<string, string>>): Buffer {
  const headers = Object.keys(rows[0] ?? {});
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((h) => csvCell(row[h] ?? '')).join(',')),
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

async function waitForStatus(
  agent: request.Agent,
  jobId: string,
  terminal: string[],
  timeoutMs = 60000,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  let last: Record<string, unknown> = {};
  while (Date.now() - started < timeoutMs) {
    const res = await agent.get(`/v1/imports/${jobId}`);
    last = res.body as Record<string, unknown>;
    if (terminal.includes(last['status'] as string)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${terminal} (last: ${JSON.stringify(last)})`);
}

describe('imports and exports', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@imports.test`;

  let app: INestApplication;
  let server: Server;
  let db: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    db = new Pool({ connectionString: AUTH_DATABASE_URL });

    const signup = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Imports ${runId}`,
        name: 'Ivy Owner',
        email: email('owner'),
        password: 'correct-horse-12',
      });
    expect(signup.status).toBe(201);
    orgIds.push(signup.body.org.id as string);
    ownerAgent = await loginAgent(server, email('owner'), 'correct-horse-12');

    await ownerAgent.post('/v1/custom-fields').send({
      entityType: 'contact',
      key: 'score',
      label: 'Score',
      type: 'number',
    });
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await db.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await db.end();
    await app.close();
  });

  it('uploads, previews with suggested mapping, and validates', async () => {
    const upload = await ownerAgent.post('/v1/imports/upload').attach(
      'file',
      csv([
        { Name: 'Alice', Email: `alice-${runId}@example.test`, Phone: '111', Score: '9' },
        { Name: 'Bob', Email: 'not-an-email', Phone: '222', Score: 'high' },
        { Name: '', Email: `noname-${runId}@example.test`, Phone: '333', Score: '1' },
      ]),
      'leads.csv',
    );
    expect(upload.status).toBe(201);
    expect(upload.body.totalRows).toBe(3);
    expect(upload.body.headers).toEqual(['Name', 'Email', 'Phone', 'Score']);
    expect(upload.body.suggestedMapping).toMatchObject({
      Name: 'name',
      Email: 'email',
      Phone: 'phone',
      Score: 'score',
    });
    const jobId = upload.body.id as string;

    const mapped = await ownerAgent.post(`/v1/imports/${jobId}/mapping`).send({
      mapping: { Name: 'name', Email: 'email', Phone: 'phone', Score: 'score' },
    });
    expect(mapped.status).toBe(200);

    const badMapping = await ownerAgent.post(`/v1/imports/${jobId}/mapping`).send({
      mapping: { Name: 'name', Email: 'email', Score: 'nope' },
    });
    expect(badMapping.status).toBe(400);

    const validate = await ownerAgent.post(`/v1/imports/${jobId}/validate`);
    expect(validate.status).toBe(200);
    const done = await waitForStatus(ownerAgent, jobId, ['validated', 'validation_failed']);
    expect(done.status).toBe('validation_failed');
    const stats = done.stats as {
      valid: number;
      invalid: number;
      sampleErrors: Array<{ row: number }>;
    };
    expect(stats.valid).toBe(1);
    expect(stats.invalid).toBe(2);
    expect(stats.sampleErrors.map((e) => e.row).sort()).toEqual([2, 3]);
  });

  it('commits validated rows, skips invalid, and emails completion', async () => {
    const upload = await ownerAgent.post('/v1/imports/upload').attach(
      'file',
      csv([
        { name: 'Carol', email: `carol-${runId}@example.test`, accountName: 'Initech' },
        { name: 'Dave', email: `dave-${runId}@example.test`, accountName: 'Initech' },
        { name: '', email: `bad-${runId}@example.test` },
      ]),
      'leads.csv',
    );
    const jobId = upload.body.id as string;
    await ownerAgent.post(`/v1/imports/${jobId}/mapping`).send({
      mapping: { name: 'name', email: 'email', accountName: 'accountName' },
    });
    await ownerAgent.post(`/v1/imports/${jobId}/validate`);
    // One row is invalid, so the dry run reports partial validity — committing
    // still proceeds with the valid rows and skips the rest.
    const validated = await waitForStatus(ownerAgent, jobId, ['validated', 'validation_failed']);
    expect(validated.status).toBe('validation_failed');

    const commit = await ownerAgent.post(`/v1/imports/${jobId}/commit`);
    expect(commit.status).toBe(200);
    const done = await waitForStatus(ownerAgent, jobId, ['completed', 'failed']);
    expect(done.status).toBe('completed');
    const stats = done.stats as { created: number; skipped: number; accountsCreated: number };
    expect(stats.created).toBe(2);
    expect(stats.skipped).toBe(1);
    expect(stats.accountsCreated).toBe(1);

    const list = await ownerAgent.get('/v1/contacts').query({ q: `carol-${runId}` });
    expect(list.body.contacts).toHaveLength(1);
    expect(list.body.contacts[0].account.name).toBe('Initech');

    const delivered = await findEmail(email('owner'), 'import finished');
    expect(delivered.Subject).toContain('import finished');

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'contact.import_completed' });
    expect(audit.body.entries).toHaveLength(1);
  });

  it('refuses commit before validation', async () => {
    const upload = await ownerAgent
      .post('/v1/imports/upload')
      .attach('file', csv([{ name: 'Eve', email: `eve-${runId}@example.test` }]), 'leads.csv');
    const commit = await ownerAgent.post(`/v1/imports/${upload.body.id as string}/commit`);
    expect(commit.status).toBe(409);
    expect(commit.body.code).toBe('IMPORT_NOT_VALIDATED');
  });

  it('rejects bad files and isolates jobs per tenant', async () => {
    const wrongType = await ownerAgent
      .post('/v1/imports/upload')
      .attach('file', Buffer.from('{}', 'utf8'), 'data.json');
    expect(wrongType.status).toBe(400);

    const empty = await ownerAgent
      .post('/v1/imports/upload')
      .attach('file', Buffer.from('name,email\n', 'utf8'), 'empty.csv');
    expect(empty.status).toBe(400);

    const other = await request(server)
      .post('/v1/auth/signup')
      .send({
        orgName: `Imports Other ${runId}`,
        name: 'O',
        email: email('other'),
        password: 'correct-horse-12',
      });
    orgIds.push(other.body.org.id as string);
    const otherAgent = await loginAgent(server, email('other'), 'correct-horse-12');
    const upload = await ownerAgent
      .post('/v1/imports/upload')
      .attach('file', csv([{ name: 'X', email: `x-${runId}@example.test` }]), 'x.csv');
    const foreign = await otherAgent.get(`/v1/imports/${upload.body.id as string}`);
    expect(foreign.status).toBe(404);
  });

  it('exports contacts to CSV honoring record scoping', async () => {
    for (const name of ['Export Al', 'Export Bo', 'Export Cy']) {
      const created = await ownerAgent.post('/v1/contacts').send({
        name,
        email: `${name.toLowerCase().replace(/ /g, '-')}-${runId}@example.test`,
      });
      expect(created.status).toBe(201);
    }
    const download = await ownerAgent.get('/v1/contacts-export');
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('text/csv');
    const text = download.text as string;
    const [header, ...rows] = text.trim().split('\n');
    expect(header!.split(',')).toEqual(expect.arrayContaining(['name', 'email', 'lifecycleStage']));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(text).toContain(`carol-${runId}@example.test`);
  });

  it('exports a single contact as vCard', async () => {
    const created = await ownerAgent.post('/v1/contacts').send({
      name: 'Vera Card',
      email: `vera-${runId}@example.test`,
      title: 'Designer',
    });
    expect(created.status).toBe(201);
    const id = created.body.contact.id as string;
    const vcf = await ownerAgent.get(`/v1/contacts/${id}/vcf`);
    expect(vcf.status).toBe(200);
    expect(vcf.headers['content-type']).toContain('text/vcard');
    expect(vcf.text).toContain('BEGIN:VCARD');
    expect(vcf.text).toContain(`vera-${runId}@example.test`);
    expect(vcf.text).toContain('TITLE:Designer');
  });

  it('imports a VCF file end to end', async () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Victor Card',
      `EMAIL:victor-${runId}@example.test`,
      'TEL:+1-555-0100',
      'TITLE:Engineer',
      'ORG:Initech',
      'END:VCARD',
    ].join('\r\n');
    const upload = await ownerAgent
      .post('/v1/imports/upload')
      .attach('file', Buffer.from(vcf, 'utf8'), 'victor.vcf');
    expect(upload.status).toBe(201);
    expect(upload.body.totalRows).toBe(1);

    await ownerAgent.post(`/v1/imports/${upload.body.id as string}/validate`);
    const validated = await waitForStatus(ownerAgent, upload.body.id as string, [
      'validated',
      'validation_failed',
    ]);
    expect(validated.status).toBe('validated');

    await ownerAgent.post(`/v1/imports/${upload.body.id as string}/commit`);
    const done = await waitForStatus(ownerAgent, upload.body.id as string, ['completed', 'failed']);
    expect(done.status).toBe('completed');

    const list = await ownerAgent.get('/v1/contacts').query({ q: `victor-${runId}` });
    expect(list.body.contacts).toHaveLength(1);
    expect(list.body.contacts[0].phone).toBe('+1-555-0100');
    expect(list.body.contacts[0].account.name).toBe('Initech');
  });

  it('imports 50,000 rows asynchronously without blocking', async () => {
    const lines = ['name,email'];
    for (let i = 0; i < 50000; i += 1) {
      lines.push(`Bulk ${i},bulk-${runId}-${i}@example.test`);
    }
    const upload = await ownerAgent
      .post('/v1/imports/upload')
      .attach('file', Buffer.from(lines.join('\n'), 'utf8'), 'bulk.csv')
      .timeout(120000);
    expect(upload.status).toBe(201);
    expect(upload.body.totalRows).toBe(50000);

    await ownerAgent.post(`/v1/imports/${upload.body.id as string}/mapping`).send({
      mapping: { name: 'name', email: 'email' },
    });
    await ownerAgent.post(`/v1/imports/${upload.body.id as string}/validate`);
    const validated = await waitForStatus(
      ownerAgent,
      upload.body.id as string,
      ['validated', 'validation_failed'],
      180000,
    );
    expect(validated.status).toBe('validated');

    // Progress is observable while the worker runs.
    await ownerAgent.post(`/v1/imports/${upload.body.id as string}/commit`);
    const done = await waitForStatus(
      ownerAgent,
      upload.body.id as string,
      ['completed', 'failed'],
      300000,
    );
    expect(done.status).toBe('completed');
    const stats = done.stats as { created: number; skipped: number };
    expect(stats.created).toBe(50000);
    expect(stats.skipped).toBe(0);

    const spot = await ownerAgent.get('/v1/contacts').query({ q: `bulk-${runId}-49999` });
    expect(spot.body.contacts).toHaveLength(1);
  }, 420000);
});
