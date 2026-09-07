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

describe('attachments upload, download, and caps', () => {
  const runId = randomBytes(4).toString('hex');
  const email = (tag: string): string => `${tag}-${runId}@attach.test`;

  let app: INestApplication;
  let server: Server;
  let authDb: Pool;
  const orgIds: string[] = [];

  let ownerAgent: request.Agent;
  let repAgent: request.Agent;
  let dealId: string;
  let attachmentId: string;

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
        orgName: `Attachments Org ${runId}`,
        name: 'Ava Owner',
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

    const deal = await ownerAgent.post('/v1/deals').send({ name: 'Filey Deal', amount: 10 });
    dealId = deal.body.deal.id as string;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await authDb.query('DELETE FROM organizations WHERE id = $1', [id]);
    }
    await authDb.end();
    await app.close();
  });

  it('uploads and downloads with byte-identical content', async () => {
    const content = Buffer.from(`deal-notes-${runId}`);
    const uploaded = await ownerAgent
      .post('/v1/attachments/upload')
      .field('entityType', 'deal')
      .field('entityId', dealId)
      .attach('file', content, { filename: 'notes.txt', contentType: 'text/plain' });
    expect(uploaded.status).toBe(201);
    attachmentId = uploaded.body.attachment.id as string;
    expect(uploaded.body.attachment.filename).toBe('notes.txt');
    expect(uploaded.body.attachment.sizeBytes).toBe(content.length);

    const listed = await ownerAgent
      .get('/v1/attachments')
      .query({ entityType: 'deal', entityId: dealId });
    expect(listed.status).toBe(200);
    expect(
      (listed.body.attachments as Array<{ id: string }>).some((a) => a.id === attachmentId),
    ).toBe(true);

    const downloaded = await ownerAgent.get(`/v1/attachments/${attachmentId}/download`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-type']).toContain('text/plain');
    expect(downloaded.text).toBe(`deal-notes-${runId}`);

    const audit = await ownerAgent
      .get('/v1/audit-log')
      .query({ action: 'attachment.uploaded', entityId: dealId });
    expect(audit.body.entries.length).toBeGreaterThan(0);
  });

  it('rejects dangerous types and missing files', async () => {
    const exe = await ownerAgent
      .post('/v1/attachments/upload')
      .field('entityType', 'deal')
      .field('entityId', dealId)
      .attach('file', Buffer.from('MZ'), {
        filename: 'run.exe',
        contentType: 'application/x-msdownload',
      });
    expect(exe.status).toBe(400);
    expect(exe.body.code).toBe('FILE_TYPE_INVALID');

    const missing = await ownerAgent
      .post('/v1/attachments/upload')
      .field('entityType', 'deal')
      .field('entityId', dealId);
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('FILE_MISSING');

    const badParent = await ownerAgent
      .post('/v1/attachments/upload')
      .field('entityType', 'deal')
      .field('entityId', '00000000-0000-4000-8000-000000000000')
      .attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' });
    expect(badParent.status).toBe(404);
  });

  it('enforces configurable per-file and org-wide caps', async () => {
    const repBlocked = await repAgent.patch('/v1/org/settings').send({
      maxAttachmentBytes: 1024,
    });
    expect(repBlocked.status).toBe(403);

    const settings = await ownerAgent.patch('/v1/org/settings').send({
      maxAttachmentBytes: 1024,
      attachmentStorageCapBytes: 2 * 1024 * 1024,
    });
    expect(settings.status).toBe(200);
    expect(settings.body.settings.maxAttachmentBytes).toBe(1024);

    const tooBig = await ownerAgent
      .post('/v1/attachments/upload')
      .field('entityType', 'deal')
      .field('entityId', dealId)
      .attach('file', Buffer.alloc(1025, 'a'), { filename: 'big.txt', contentType: 'text/plain' });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe('FILE_TOO_LARGE');

    // Shrink the org cap to just under current usage + 1KB: the ~15B
    // notes.txt plus one 1024B filler fit, the next byte does not.
    const filler = await ownerAgent
      .post('/v1/attachments/upload')
      .field('entityType', 'deal')
      .field('entityId', dealId)
      .attach('file', Buffer.alloc(1024, 'b'), { filename: 'fill.txt', contentType: 'text/plain' });
    expect(filler.status).toBe(201);

    const usageBefore = await ownerAgent.get('/v1/attachments/usage/summary');
    const tightCap = (usageBefore.body.bytes as number) + 100;
    const tightened = await ownerAgent.patch('/v1/org/settings').send({
      maxAttachmentBytes: 1024,
      attachmentStorageCapBytes: tightCap,
    });
    expect(tightened.status).toBe(200);

    const capped = await ownerAgent
      .post('/v1/attachments/upload')
      .field('entityType', 'deal')
      .field('entityId', dealId)
      .attach('file', Buffer.alloc(101, 'c'), { filename: 'over.txt', contentType: 'text/plain' });
    // 100B headroom but 101B upload → cap trips.
    expect(capped.status).toBe(413);
    expect(capped.body.code).toBe('STORAGE_CAP_EXCEEDED');

    const usage = await ownerAgent.get('/v1/attachments/usage/summary');
    expect(usage.status).toBe(200);
    expect(usage.body.bytes).toBeGreaterThanOrEqual(1024);

    // Restore generous caps for the remaining tests.
    await ownerAgent.patch('/v1/org/settings').send({
      maxAttachmentBytes: 25 * 1024 * 1024,
      attachmentStorageCapBytes: 10 * 1024 * 1024 * 1024,
    });
  });

  it('isolates attachments by parent record and org', async () => {
    // Rep cannot touch the owner's deal files.
    const blocked = await repAgent.get(`/v1/attachments/${attachmentId}/download`);
    expect([403, 404]).toContain(blocked.status);

    const repDeal = await repAgent.post('/v1/deals').send({ name: 'Rep Files', amount: 1 });
    const repDealId = repDeal.body.deal.id as string;
    const repUpload = await repAgent
      .post('/v1/attachments/upload')
      .field('entityType', 'deal')
      .field('entityId', repDealId)
      .attach('file', Buffer.from('rep-bytes'), { filename: 'rep.txt', contentType: 'text/plain' });
    expect(repUpload.status).toBe(201);

    const ownerList = await ownerAgent
      .get('/v1/attachments')
      .query({ entityType: 'deal', entityId: dealId });
    const ownerIds = (ownerList.body.attachments as Array<{ id: string }>).map((a) => a.id);
    expect(ownerIds).not.toContain(repUpload.body.attachment.id as string);
  });

  it('deletes attachments and frees quota', async () => {
    const removed = await ownerAgent.delete(`/v1/attachments/${attachmentId}`).send();
    expect(removed.status).toBe(200);

    const gone = await ownerAgent.get(`/v1/attachments/${attachmentId}/download`);
    expect(gone.status).toBe(404);

    const listed = await ownerAgent
      .get('/v1/attachments')
      .query({ entityType: 'deal', entityId: dealId });
    const ids = (listed.body.attachments as Array<{ id: string }>).map((a) => a.id);
    expect(ids).not.toContain(attachmentId);
  });
});
