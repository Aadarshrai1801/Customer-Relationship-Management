import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { accounts, contacts, importJobs, organizations, users, type ImportJob } from '@nexus/db';
import { IdentityDb, TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { validateCustomFields, type FieldDefinition } from '../custom-fields/field-validation';
import { DedupService } from '../dedup/dedup.service';
import { MailService } from '../mail/mail.service';
import { QueueService } from '../queue/queue.service';
import { hasScope } from '../rbac/permissions';
import { LIFECYCLE_STAGES } from '@nexus/db';
import { escapeCsvCell, inspectCsv, iterateRows, parseVcf, vcfToRows } from './csv-utils';

export const IMPORT_VALIDATE_QUEUE = 'import-validate';
export const IMPORT_COMMIT_QUEUE = 'import-commit';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 100_000;
const COMMIT_BATCH = 500;
const ERROR_SAMPLE_LIMIT = 50;

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
}

function storageDir(): string {
  return resolve(process.env.STORAGE_DIR ?? 'storage');
}

function importPath(jobId: string): string {
  return join(storageDir(), 'imports', `${jobId}.csv`);
}

const STANDARD_CONTACT_FIELDS = new Set([
  'name',
  'firstName',
  'lastName',
  'email',
  'phone',
  'title',
  'lifecycleStage',
  'tags',
  'accountName',
  'ownerEmail',
]);

const STANDARD_ACCOUNT_FIELDS = new Set([
  'name',
  'website',
  'phone',
  'industry',
  'tags',
  'domains',
  'ownerEmail',
]);

const HEADER_ALIASES: Record<string, string> = {
  name: 'name',
  fullname: 'name',
  firstname: 'firstName',
  givenname: 'firstName',
  lastname: 'lastName',
  familyname: 'lastName',
  surname: 'lastName',
  email: 'email',
  emailaddress: 'email',
  phone: 'phone',
  mobile: 'phone',
  telephone: 'phone',
  phonenumber: 'phone',
  title: 'title',
  jobtitle: 'title',
  company: 'accountName',
  account: 'accountName',
  accountname: 'accountName',
  organization: 'accountName',
  org: 'accountName',
  lifecycle: 'lifecycleStage',
  stage: 'lifecycleStage',
  lifecyclestage: 'lifecycleStage',
  tags: 'tags',
  owner: 'ownerEmail',
  owneremail: 'ownerEmail',
  website: 'website',
  industry: 'industry',
  domains: 'domains',
};

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function suggestMapping(
  headers: string[],
  entityType: 'contact' | 'account',
  customKeys: string[],
): Record<string, string> {
  const mapping: Record<string, unknown> = {};
  const standard = entityType === 'contact' ? STANDARD_CONTACT_FIELDS : STANDARD_ACCOUNT_FIELDS;
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const alias = HEADER_ALIASES[normalized];
    if (alias && standard.has(alias)) {
      mapping[header] = alias;
      continue;
    }
    const custom = customKeys.find((k) => normalizeHeader(k) === normalized);
    if (custom) mapping[header] = custom;
  }
  return mapping as Record<string, string>;
}

/**
 * Module 14 (PRD 4.15 P0): field-mapping presets for common source
 * systems. Keys are the exact CSV headers those exports produce; values
 * are Nexus field keys. Applied when upload passes ?source=, and always
 * overridable afterwards via setMapping.
 */
export const SOURCE_MAPPING_TEMPLATES: Record<
  string,
  { source: string; entityType: 'contact' | 'account'; mapping: Record<string, string> }
> = {
  hubspot: {
    source: 'hubspot',
    entityType: 'contact',
    mapping: {
      'First Name': 'firstName',
      'Last Name': 'lastName',
      'Email': 'email',
      'Phone Number': 'phone',
      'Job Title': 'title',
      'Company Name': 'accountName',
      'Contact Owner': 'ownerEmail',
      'Lifecycle Stage': 'lifecycleStage',
    },
  },
  pipedrive: {
    source: 'pipedrive',
    entityType: 'contact',
    mapping: {
      'Name': 'name',
      'Email': 'email',
      'Phone': 'phone',
      'Title': 'title',
      'Organization': 'accountName',
      'Owner': 'ownerEmail',
    },
  },
  salesforce: {
    source: 'salesforce',
    entityType: 'contact',
    mapping: {
      'FirstName': 'firstName',
      'LastName': 'lastName',
      'Email': 'email',
      'Phone': 'phone',
      'Title': 'title',
      'Account Name': 'accountName',
      'Contact Owner': 'ownerEmail',
    },
  },
};

export interface RowIssue {
  row: number;
  errors: Array<{ path: string; message: string }>;
}

@Injectable()
export class ImportsService {
  constructor(
    @Inject(IdentityDb) private readonly identityDb: IdentityDb,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CustomFieldsService) private readonly fields: CustomFieldsService,
    @Inject(DedupService) private readonly dedup: DedupService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(QueueService) private readonly queues: QueueService,
  ) {}

  onModuleInit(): void {
    this.queues.registerWorker<{ jobId: string }>(IMPORT_VALIDATE_QUEUE, (job) =>
      this.handleValidate(job.data.jobId),
    );
    this.queues.registerWorker<{ jobId: string }>(IMPORT_COMMIT_QUEUE, (job) =>
      this.handleCommit(job.data.jobId),
    );
  }

  private manageScope(entityType: 'contact' | 'account'): string {
    return entityType === 'contact' ? 'contacts:manage' : 'accounts:manage';
  }

  private assertManage(auth: AuthContext, entityType: 'contact' | 'account'): void {
    if (!hasScope(auth.role.permissions, this.manageScope(entityType))) {
      throw new ForbiddenException({
        message: `Missing required scope: ${this.manageScope(entityType)}`,
        code: 'SCOPE_FORBIDDEN',
      });
    }
  }

  async upload(
    auth: AuthContext,
    entityType: 'contact' | 'account',
    file: UploadedFile | undefined,
    source?: 'hubspot' | 'pipedrive' | 'salesforce',
  ): Promise<unknown> {
    this.assertManage(auth, entityType);
    if (!file) {
      throw new BadRequestException({
        message: 'CSV or VCF file is required',
        code: 'FILE_REQUIRED',
      });
    }
    const lower = file.originalname.toLowerCase();
    const isVcf = lower.endsWith('.vcf');
    const isCsv = lower.endsWith('.csv');
    if (!isVcf && !isCsv) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException({
        message: 'Only .csv and .vcf files are supported',
        code: 'FILE_TYPE_INVALID',
      });
    }
    if (isVcf && entityType !== 'contact') {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException({
        message: 'VCF import is only supported for contacts',
        code: 'VCF_CONTACTS_ONLY',
      });
    }
    if (file.size > MAX_FILE_BYTES) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException({
        message: 'File exceeds the 50MB limit',
        code: 'FILE_TOO_LARGE',
      });
    }

    const jobId = randomUUID();
    const target = importPath(jobId);
    await mkdir(join(storageDir(), 'imports'), { recursive: true });
    try {
      if (isVcf) {
        const text = await readFile(file.path, 'utf8');
        const cards = parseVcf(text);
        if (cards.length === 0) throw new Error('No vCards found in file');
        if (cards.length > MAX_ROWS) throw new Error(`File exceeds the ${MAX_ROWS}-row limit`);
        const { headers, rows } = vcfToRows(cards);
        await this.writeCsv(target, headers, rows);
        await unlink(file.path).catch(() => undefined);
        return this.createJob(
          auth,
          entityType,
          jobId,
          headers,
          rows.length,
          rows.slice(0, 10),
          true,
          source,
        );
      }
      await rename(file.path, target);
      const inspected = await inspectCsv(target);
      if (inspected.totalRows === 0) {
        await unlink(target).catch(() => undefined);
        throw new BadRequestException({
          message: 'File contains no data rows',
          code: 'FILE_EMPTY',
        });
      }
      if (inspected.totalRows > MAX_ROWS) {
        await unlink(target).catch(() => undefined);
        throw new BadRequestException({
          message: `File exceeds the ${MAX_ROWS}-row limit`,
          code: 'FILE_TOO_MANY_ROWS',
        });
      }
      return this.createJob(
        auth,
        entityType,
        jobId,
        inspected.headers,
        inspected.totalRows,
        inspected.sampleRows,
        false,
        source,
      );
    } catch (err) {
      if ((err as { status?: number }).status === 400) throw err;
      await unlink(target).catch(() => undefined);
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException({
        message: err instanceof Error ? err.message : 'Could not parse file',
        code: 'FILE_PARSE_FAILED',
      });
    }
  }

  private async writeCsv(
    path: string,
    headers: string[],
    rows: Array<Record<string, string>>,
  ): Promise<void> {
    const lines = [
      headers.map(escapeCsvCell).join(','),
      ...rows.map((row) => headers.map((h) => escapeCsvCell(row[h] ?? '')).join(',')),
    ];
    await writeFile(path, lines.join('\n'), 'utf8');
  }

  private async createJob(
    auth: AuthContext,
    entityType: 'contact' | 'account',
    jobId: string,
    headers: string[],
    totalRows: number,
    sampleRows: Array<Record<string, string>>,
    fixedMapping: boolean,
    source?: 'hubspot' | 'pipedrive' | 'salesforce',
  ): Promise<unknown> {
    const created = await this.tenantDb.tx(auth.org.id, async (db) => {
      const defs = await this.fields.loadDefinitions(db, auth.org.id, entityType);
      const suggested = fixedMapping
        ? Object.fromEntries(headers.map((h) => [h, h]))
        : suggestMapping(
            headers,
            entityType,
            defs.map((d) => d.key),
          );
      // Source presets win for known headers; suggestions fill the rest.
      const preset = source ? SOURCE_MAPPING_TEMPLATES[source] : undefined;
      const mapping =
        preset && preset.entityType === entityType
          ? {
              ...suggested,
              ...Object.fromEntries(
                Object.entries(preset.mapping).filter(([header]) => headers.includes(header)),
              ),
            }
          : suggested;
      const [row] = await db
        .insert(importJobs)
        .values({
          id: jobId,
          orgId: auth.org.id,
          userId: auth.user.id,
          entityType,
          status: 'pending',
          mapping,
          stats: { totalRows, headers, sampleRows },
          storageKey: `${jobId}.csv`,
        })
        .returning();
      return row;
    });
    if (!created) throw new Error('Failed to create import job');
    return {
      id: created.id,
      entityType: created.entityType,
      status: created.status,
      headers,
      totalRows,
      sampleRows,
      suggestedMapping: created.mapping,
    };
  }

  async setMapping(
    auth: AuthContext,
    id: string,
    mapping: Record<string, string>,
  ): Promise<unknown> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const job = await this.requireJob(db, auth, id);
      this.assertManage(auth, job.entityType);
      const defs = await this.fields.loadDefinitions(db, auth.org.id, job.entityType);
      const standard =
        job.entityType === 'contact' ? STANDARD_CONTACT_FIELDS : STANDARD_ACCOUNT_FIELDS;
      const customKeys = new Set(defs.map((d) => d.key));
      for (const [header, field] of Object.entries(mapping)) {
        if (!standard.has(field) && !customKeys.has(field)) {
          throw new BadRequestException({
            message: `Unknown target field: ${field}`,
            code: 'MAPPING_UNKNOWN_FIELD',
          });
        }
        void header;
      }
      const [updated] = await db
        .update(importJobs)
        .set({ mapping, status: 'pending' })
        .where(eq(importJobs.id, job.id))
        .returning();
      return this.presentJob(updated!);
    });
  }

  async requestValidate(auth: AuthContext, id: string): Promise<unknown> {
    const job = await this.tenantDb.tx(auth.org.id, async (db) => {
      const found = await this.requireJob(db, auth, id);
      this.assertManage(auth, found.entityType);
      if (found.status !== 'pending' && found.status !== 'validation_failed') {
        throw new ConflictException({
          message: `Cannot validate a job in status ${found.status}`,
          code: 'IMPORT_BAD_STATUS',
        });
      }
      const mapped = Object.values((found.mapping ?? {}) as Record<string, string>);
      const hasEmail = mapped.includes('email');
      if (found.entityType === 'contact' && !hasEmail) {
        throw new BadRequestException({
          message: 'Mapping must include the email field',
          code: 'MAPPING_MISSING_EMAIL',
        });
      }
      const hasName = mapped.includes('name');
      if (!hasName) {
        throw new BadRequestException({
          message: 'Mapping must include the name field',
          code: 'MAPPING_MISSING_NAME',
        });
      }
      await db
        .update(importJobs)
        .set({ status: 'validating', error: null })
        .where(eq(importJobs.id, found.id));
      return found;
    });
    await this.queues.publish(IMPORT_VALIDATE_QUEUE, { jobId: job.id });
    return { id: job.id, status: 'validating' };
  }

  async requestCommit(auth: AuthContext, id: string): Promise<unknown> {
    const job = await this.tenantDb.tx(auth.org.id, async (db) => {
      const found = await this.requireJob(db, auth, id);
      this.assertManage(auth, found.entityType);
      // Both fully-valid and partially-valid files can be committed: valid
      // rows import, invalid rows are skipped and counted.
      if (found.status !== 'validated' && found.status !== 'validation_failed') {
        throw new ConflictException({
          message: 'Run dry-run validation before committing',
          code: 'IMPORT_NOT_VALIDATED',
        });
      }
      await db.update(importJobs).set({ status: 'importing' }).where(eq(importJobs.id, found.id));
      return found;
    });
    await this.queues.publish(IMPORT_COMMIT_QUEUE, { jobId: job.id });
    return { id: job.id, status: 'importing' };
  }

  async listJobs(auth: AuthContext): Promise<unknown[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const conditions = [eq(importJobs.orgId, auth.org.id)];
      if (!hasScope(auth.role.permissions, 'users:manage')) {
        conditions.push(eq(importJobs.userId, auth.user.id));
      }
      const rows = await db
        .select()
        .from(importJobs)
        .where(and(...conditions));
      return rows.map((r) => this.presentJob(r));
    });
  }

  async getJob(auth: AuthContext, id: string): Promise<unknown> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const job = await this.requireJob(db, auth, id);
      return this.presentJob(job);
    });
  }

  private presentJob(job: ImportJob): unknown {
    const stats = (job.stats ?? {}) as Record<string, unknown>;
    return {
      id: job.id,
      entityType: job.entityType,
      status: job.status,
      mapping: job.mapping,
      stats: {
        totalRows: stats['totalRows'] ?? null,
        valid: stats['valid'] ?? null,
        invalid: stats['invalid'] ?? null,
        created: stats['created'] ?? null,
        skipped: stats['skipped'] ?? null,
        failed: stats['failed'] ?? null,
        processed: stats['processed'] ?? null,
        accountsCreated: stats['accountsCreated'] ?? null,
        sampleErrors: stats['sampleErrors'] ?? [],
      },
      error: job.error,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
    };
  }

  private async requireJob(db: NexusDb, auth: AuthContext, id: string): Promise<ImportJob> {
    const [job] = await db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.id, id), eq(importJobs.orgId, auth.org.id)));
    if (!job) {
      throw new NotFoundException({ message: 'Import job not found', code: 'IMPORT_NOT_FOUND' });
    }
    if (job.userId !== auth.user.id && !hasScope(auth.role.permissions, 'users:manage')) {
      throw new NotFoundException({ message: 'Import job not found', code: 'IMPORT_NOT_FOUND' });
    }
    return job;
  }

  async handleValidate(jobId: string): Promise<void> {
    const found = await this.identityDb.db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, jobId));
    const job = found[0];
    if (!job || (job.status !== 'validating' && job.status !== 'pending')) return;
    try {
      const stats = await this.validateAllRows(job);
      const failed = stats.invalid > 0;
      await this.tenantDb.tx(job.orgId, (db) =>
        db
          .update(importJobs)
          .set({
            status: failed ? 'validation_failed' : 'validated',
            stats: { ...(job.stats as Record<string, unknown>), ...stats },
            completedAt: failed ? new Date() : null,
          })
          .where(eq(importJobs.id, job.id)),
      );
    } catch (err) {
      await this.tenantDb.tx(job.orgId, (db) =>
        db
          .update(importJobs)
          .set({ status: 'failed', error: (err as Error).message.slice(0, 500) })
          .where(eq(importJobs.id, job.id)),
      );
    }
  }

  private async validateAllRows(job: ImportJob): Promise<{
    valid: number;
    invalid: number;
    sampleErrors: RowIssue[];
  }> {
    const mapping = (job.mapping ?? {}) as Record<string, string>;
    const path = importPath(job.id);
    if (!existsSync(path)) throw new Error('Import file is missing');
    const inspected = await inspectCsv(path);
    const defs = await this.tenantDb.tx(job.orgId, (db) =>
      this.fields.loadDefinitions(db, job.orgId, job.entityType),
    );
    const members = await this.memberEmails(job.orgId);
    let valid = 0;
    let invalid = 0;
    const sampleErrors: RowIssue[] = [];
    for await (const { index, row } of iterateRows(path, inspected.delimiter)) {
      const issues = this.validateRow(job.entityType, mapping, defs, members, row);
      if (issues.length === 0) valid += 1;
      else {
        invalid += 1;
        if (sampleErrors.length < ERROR_SAMPLE_LIMIT) {
          sampleErrors.push({ row: index, errors: issues });
        }
      }
    }
    return { valid, invalid, sampleErrors };
  }

  private async loadMembers(
    orgId: string,
  ): Promise<{ emails: Set<string>; ids: Map<string, string> }> {
    const rows = await this.tenantDb.tx(orgId, (db) =>
      db.select({ id: users.id, email: users.email }).from(users).where(eq(users.orgId, orgId)),
    );
    return {
      emails: new Set(rows.map((r) => r.email.toLowerCase())),
      ids: new Map(rows.map((r) => [r.email.toLowerCase(), r.id])),
    };
  }

  private async memberEmails(orgId: string): Promise<Set<string>> {
    return (await this.loadMembers(orgId)).emails;
  }

  private validateRow(
    entityType: 'contact' | 'account',
    mapping: Record<string, string>,
    defs: FieldDefinition[],
    members: Set<string>,
    row: Record<string, string>,
  ): Array<{ path: string; message: string }> {
    const issues: Array<{ path: string; message: string }> = [];
    const get = (field: string): string => {
      const header = Object.keys(mapping).find((h) => mapping[h] === field);
      return header ? (row[header] ?? '').trim() : '';
    };
    if (entityType === 'contact') {
      const name = get('name');
      const email = get('email').toLowerCase();
      if (!name) issues.push({ path: 'name', message: 'Name is required' });
      if (!email) issues.push({ path: 'email', message: 'Email is required' });
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        issues.push({ path: 'email', message: 'Enter a valid email address' });
      }
      const stage = get('lifecycleStage');
      if (stage && !(LIFECYCLE_STAGES as readonly string[]).includes(stage)) {
        issues.push({
          path: 'lifecycleStage',
          message: `Must be one of: ${LIFECYCLE_STAGES.join(', ')}`,
        });
      }
      const ownerEmail = get('ownerEmail').toLowerCase();
      if (ownerEmail && !members.has(ownerEmail)) {
        issues.push({ path: 'ownerEmail', message: `Unknown workspace member: ${ownerEmail}` });
      }
      const custom: Record<string, unknown> = {};
      for (const [header, field] of Object.entries(mapping)) {
        if (this.isStandardContactField(field)) continue;
        custom[field] = this.coerceCustom(row[header] ?? '');
      }
      const result = validateCustomFields(defs, custom);
      for (const issue of result.issues) {
        issues.push({
          path: `customFields.${issue.key}`,
          message: `${issue.key}: ${issue.message}`,
        });
      }
    } else {
      const name = get('name');
      if (!name) issues.push({ path: 'name', message: 'Name is required' });
      const custom: Record<string, unknown> = {};
      for (const [header, field] of Object.entries(mapping)) {
        if (this.isStandardAccountField(field)) continue;
        custom[field] = this.coerceCustom(row[header] ?? '');
      }
      const result = validateCustomFields(defs, custom);
      for (const issue of result.issues) {
        issues.push({
          path: `customFields.${issue.key}`,
          message: `${issue.key}: ${issue.message}`,
        });
      }
    }
    return issues;
  }

  private isStandardContactField(field: string): boolean {
    return STANDARD_CONTACT_FIELDS.has(field);
  }

  private isStandardAccountField(field: string): boolean {
    return STANDARD_ACCOUNT_FIELDS.has(field);
  }

  private coerceCustom(raw: string): unknown {
    const value = raw.trim();
    if (value === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    if (value.includes(';'))
      return value
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    return value;
  }

  async handleCommit(jobId: string): Promise<void> {
    const found = await this.identityDb.db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, jobId));
    const job = found[0];
    if (!job || job.status !== 'importing') return;
    try {
      const stats = await this.commitAllRows(job);
      await this.tenantDb.tx(job.orgId, async (db) => {
        await db
          .update(importJobs)
          .set({
            status: 'completed',
            stats: { ...(job.stats as Record<string, unknown>), ...stats },
            completedAt: new Date(),
          })
          .where(eq(importJobs.id, job.id));
        await this.audit.record(db, {
          orgId: job.orgId,
          actorUserId: job.userId,
          action:
            job.entityType === 'contact' ? 'contact.import_completed' : 'account.import_completed',
          entityType: 'import_job',
          entityId: job.id,
          newValues: stats as unknown as Record<string, unknown>,
        });
      });
      const recipient = await this.jobOwnerEmail(job);
      if (recipient) {
        const orgName = await this.orgName(job.orgId);
        await this.mail.sendImportComplete(recipient, orgName, job.entityType, {
          created: stats.created,
          skipped: stats.skipped,
          failed: stats.failed,
          total: stats.total,
        });
      }
      await unlink(importPath(job.id)).catch(() => undefined);
    } catch (err) {
      await this.tenantDb.tx(job.orgId, (db) =>
        db
          .update(importJobs)
          .set({ status: 'failed', error: (err as Error).message.slice(0, 500) })
          .where(eq(importJobs.id, job.id)),
      );
    }
  }

  private async jobOwnerEmail(job: ImportJob): Promise<string | null> {
    if (!job.userId) return null;
    const [row] = await this.identityDb.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, job.userId));
    return row?.email ?? null;
  }

  private async orgName(orgId: string): Promise<string> {
    const [org] = await this.identityDb.db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return org?.name ?? 'your workspace';
  }

  private async commitAllRows(job: ImportJob): Promise<{
    total: number;
    created: number;
    skipped: number;
    failed: number;
    processed: number;
    accountsCreated: number;
  }> {
    const mapping = (job.mapping ?? {}) as Record<string, string>;
    const path = importPath(job.id);
    if (!existsSync(path)) throw new Error('Import file is missing');
    const inspected = await inspectCsv(path);
    const defs = await this.tenantDb.tx(job.orgId, (db) =>
      this.fields.loadDefinitions(db, job.orgId, job.entityType),
    );
    const members = await this.loadMembers(job.orgId);
    const memberIds = members.ids;
    const memberEmails = members.emails;

    let accountsCreated = 0;
    let accountMap = new Map<string, string>();
    if (job.entityType === 'contact') {
      accountMap = await this.ensureAccounts(job.orgId, mapping, inspected.delimiter, path);
      const created = accountMap.get('__created__');
      accountsCreated = created ? Number(created) : 0;
      accountMap.delete('__created__');
    }

    let created = 0;
    let skipped = 0;
    // Row-level failures do not occur by design: invalid rows are skipped,
    // and unexpected errors fail the whole job (status, not stats).
    const failed = 0;
    let processed = 0;
    const total = ((job.stats as Record<string, unknown>)['totalRows'] as number | undefined) ?? 0;

    const flushProgress = async (): Promise<void> => {
      await this.tenantDb.tx(job.orgId, (db) =>
        db
          .update(importJobs)
          .set({
            stats: {
              ...(job.stats as Record<string, unknown>),
              processed,
              created,
              skipped,
              failed,
              total,
              accountsCreated,
            },
          })
          .where(eq(importJobs.id, job.id)),
      );
    };

    if (job.entityType === 'contact') {
      let batch: Array<Record<string, string>> = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const result = await this.insertContactBatch(
          job,
          mapping,
          defs,
          memberIds,
          accountMap,
          batch,
        );
        created += result.created;
        skipped += result.skipped;
        processed += batch.length;
        batch = [];
        await flushProgress();
      };
      for await (const { row } of iterateRows(path, inspected.delimiter)) {
        const issues = this.validateRow(job.entityType, mapping, defs, memberEmails, row);
        if (issues.length > 0) {
          skipped += 1;
          processed += 1;
          continue;
        }
        batch.push(row);
        if (batch.length >= COMMIT_BATCH) await flush();
      }
      await flush();
    } else {
      let batch: Array<Record<string, string>> = [];
      const flush = async (): Promise<void> => {
        if (batch.length === 0) return;
        const result = await this.insertAccountBatch(job, mapping, defs, memberIds, batch);
        created += result.created;
        skipped += result.skipped;
        processed += batch.length;
        batch = [];
        await flushProgress();
      };
      for await (const { row } of iterateRows(path, inspected.delimiter)) {
        const issues = this.validateRow(job.entityType, mapping, defs, memberEmails, row);
        if (issues.length > 0) {
          skipped += 1;
          processed += 1;
          continue;
        }
        batch.push(row);
        if (batch.length >= COMMIT_BATCH) await flush();
      }
      await flush();
    }

    return { total, created, skipped, failed, processed, accountsCreated };
  }

  /** Resolves account names upfront: matches existing (ci), bulk-creates the rest. */
  private async ensureAccounts(
    orgId: string,
    mapping: Record<string, string>,
    delimiter: string,
    path: string,
  ): Promise<Map<string, string>> {
    const accountHeader = Object.keys(mapping).find((h) => mapping[h] === 'accountName');
    const result = new Map<string, string>();
    if (!accountHeader) return result;
    const names = new Set<string>();
    for await (const { row } of iterateRows(path, delimiter)) {
      const name = (row[accountHeader] ?? '').trim();
      if (name) names.add(name);
    }
    if (names.size === 0) return result;
    return this.tenantDb.tx(orgId, async (db) => {
      const lowered = [...names].map((n) => n.toLowerCase());
      const existing = await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(
          and(
            eq(accounts.orgId, orgId),
            sql`lower(${accounts.name}) IN (${sql.join(
              lowered.map((n) => sql`${n}`),
              sql`, `,
            )})`,
            isNull(accounts.deletedAt),
          ),
        );
      const byLower = new Map(existing.map((a) => [a.name.toLowerCase(), a.id]));
      const missing = [...names].filter((n) => !byLower.has(n.toLowerCase()));
      if (missing.length > 0) {
        const inserted = await db
          .insert(accounts)
          .values(missing.map((name) => ({ orgId, name })))
          .returning({ id: accounts.id, name: accounts.name });
        for (const row of inserted) byLower.set(row.name.toLowerCase(), row.id);
        result.set('__created__', String(missing.length));
      }
      for (const name of names) result.set(name, byLower.get(name.toLowerCase())!);
      return result;
    });
  }

  private extractMapped(
    mapping: Record<string, string>,
    row: Record<string, string>,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [header, field] of Object.entries(mapping)) {
      out[field] = (row[header] ?? '').trim();
    }
    return out;
  }

  private async insertContactBatch(
    job: ImportJob,
    mapping: Record<string, string>,
    defs: FieldDefinition[],
    memberIds: Map<string, string>,
    accountMap: Map<string, string>,
    batch: Array<Record<string, string>>,
  ): Promise<{ created: number; skipped: number }> {
    const rows = batch.map((row) => ({ row, mapped: this.extractMapped(mapping, row) }));
    const emails = rows.map((r) => r.mapped['email']!.toLowerCase());
    const existing = await this.tenantDb.tx(job.orgId, (db) =>
      db
        .select({ email: contacts.email })
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, job.orgId),
            sql`lower(${contacts.email}) IN (${sql.join(
              emails.map((e) => sql`${e}`),
              sql`, `,
            )})`,
            isNull(contacts.deletedAt),
          ),
        ),
    );
    const taken = new Set(existing.map((r) => r.email.toLowerCase()));
    const values: Array<typeof contacts.$inferInsert> = [];
    for (const { row, mapped } of rows) {
      const emailLower = mapped['email']!.toLowerCase();
      if (taken.has(emailLower)) continue;
      taken.add(emailLower);
      const custom: Record<string, unknown> = {};
      for (const [header, field] of Object.entries(mapping)) {
        if (STANDARD_CONTACT_FIELDS.has(field)) continue;
        custom[field] = this.coerceCustom(row[header] ?? '');
      }
      const { values: normalized } = validateCustomFields(defs, custom);
      const tags = (mapped['tags'] ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20);
      const accountName = mapped['accountName'] ?? '';
      const ownerEmail = (mapped['ownerEmail'] ?? '').toLowerCase();
      values.push({
        orgId: job.orgId,
        accountId: accountName ? (accountMap.get(accountName) ?? null) : null,
        ownerId: ownerEmail ? (memberIds.get(ownerEmail) ?? job.userId) : job.userId,
        name: mapped['name']!,
        firstName: mapped['firstName'] || null,
        lastName: mapped['lastName'] || null,
        email: emailLower,
        phone: mapped['phone'] || null,
        title: mapped['title'] || null,
        lifecycleStage: mapped['lifecycleStage'] || 'lead',
        tags,
        customFields: normalized,
      });
    }
    // Exact-email duplicates are skipped, not imported; the nightly dedup scan
    // covers remaining fuzzy matches. No per-row candidate writes at bulk scale.
    if (values.length === 0) return { created: 0, skipped: batch.length };
    const inserted = await this.tenantDb.tx(job.orgId, (db) =>
      db.insert(contacts).values(values).returning({ id: contacts.id }),
    );
    return { created: inserted.length, skipped: batch.length - values.length };
  }

  private async insertAccountBatch(
    job: ImportJob,
    mapping: Record<string, string>,
    defs: FieldDefinition[],
    memberIds: Map<string, string>,
    batch: Array<Record<string, string>>,
  ): Promise<{ created: number; skipped: number }> {
    const values: Array<typeof accounts.$inferInsert> = [];
    for (const row of batch) {
      const mapped = this.extractMapped(mapping, row);
      const custom: Record<string, unknown> = {};
      for (const [header, field] of Object.entries(mapping)) {
        if (STANDARD_ACCOUNT_FIELDS.has(field)) continue;
        custom[field] = this.coerceCustom(row[header] ?? '');
      }
      const { values: normalized } = validateCustomFields(defs, custom);
      const ownerEmail = (mapped['ownerEmail'] ?? '').toLowerCase();
      const domains = (mapped['domains'] ?? '')
        .split(';')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20);
      const tags = (mapped['tags'] ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 20);
      values.push({
        orgId: job.orgId,
        name: mapped['name']!,
        website: mapped['website'] || null,
        phone: mapped['phone'] || null,
        industry: mapped['industry'] || null,
        domains,
        ownerId: ownerEmail ? (memberIds.get(ownerEmail) ?? job.userId) : job.userId,
        tags,
        customFields: normalized,
      });
    }
    if (values.length === 0) return { created: 0, skipped: batch.length };
    const inserted = await this.tenantDb.tx(job.orgId, (db) =>
      db.insert(accounts).values(values).returning({ id: accounts.id }),
    );
    return { created: inserted.length, skipped: batch.length - values.length };
  }
}
