import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  auditLogEntries,
  emailInvites,
  gdprExports,
  organizations,
  roles,
  sessions,
  twoFactor,
  users,
} from '@nexus/db';
import { IdentityDb, TenantDb } from '../database/tenant-db.service';
import { StorageService } from '../storage/storage.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../crypto/password.service';
import { MailService } from '../mail/mail.service';
import { QueueService } from '../queue/queue.service';

export const GDPR_EXPORT_QUEUE = 'gdpr-export';
export const EXPORT_EXPIRY_QUEUE = 'privacy-export-expiry';

function exportTtlDays(): number {
  const parsed = Number(process.env.EXPORT_TTL_DAYS ?? 7);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 7;
}

function exportKey(storageKey: string): string {
  return `exports/${storageKey}`;
}

export interface ExportPackage {
  exportedAt: string;
  org: { id: string; name: string; slug: string };
  user: {
    id: string;
    email: string;
    name: string;
    status: string;
    timezone: string;
    role: { key: string; name: string };
    ssoProvider: string | null;
    createdAt: Date;
  };
  sessions: Array<{
    id: string;
    ipAddress: string | null;
    userAgent: string | null;
    twoFactorVerified: boolean;
    createdAt: Date;
    expiresAt: Date;
    revokedAt: Date | null;
  }>;
  twoFactor: { enrolled: boolean; enabledAt: Date | null };
  invitesSent: Array<{ email: string; roleKey: string; acceptedAt: Date | null; createdAt: Date }>;
  invitesReceived: Array<{ email: string; roleKey: string; createdAt: Date }>;
  auditEntries: Array<{
    id: number;
    action: string;
    entityType: string;
    entityId: string | null;
    oldValues: unknown;
    newValues: unknown;
    ipAddress: string | null;
    createdAt: Date;
  }>;
}

@Injectable()
export class PrivacyService {
  constructor(
    @Inject(IdentityDb) private readonly identityDb: IdentityDb,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(QueueService) private readonly queues: QueueService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    this.queues.registerWorker<{ exportId: string }>(GDPR_EXPORT_QUEUE, (job) =>
      this.handleExport(job.data.exportId),
    );
    this.queues.registerWorker(EXPORT_EXPIRY_QUEUE, () => this.expireExports());
    this.queues.registerSchedule(EXPORT_EXPIRY_QUEUE, '0 4 * * *');
  }

  async requestExport(auth: AuthContext): Promise<{ id: string; status: string }> {
    const created = await this.tenantDb.tx(auth.org.id, async (db) => {
      const [row] = await db
        .insert(gdprExports)
        .values({ orgId: auth.org.id, userId: auth.user.id, status: 'pending' })
        .returning({ id: gdprExports.id, status: gdprExports.status });
      if (!row) throw new Error('Failed to create export request');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'privacy.export.requested',
        entityType: 'gdpr_export',
        entityId: row.id,
      });
      return row;
    });
    await this.queues.publish(GDPR_EXPORT_QUEUE, { exportId: created.id });
    return { id: created.id, status: created.status };
  }

  async listExports(auth: AuthContext): Promise<unknown[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db
        .select()
        .from(gdprExports)
        .where(and(eq(gdprExports.orgId, auth.org.id), eq(gdprExports.userId, auth.user.id)));
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        checksum: r.checksum,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        error: r.status === 'failed' ? r.error : undefined,
      }));
    });
  }

  async loadExportFile(
    auth: AuthContext,
    id: string,
  ): Promise<{ path?: string; buffer?: Buffer; filename: string; size: number }> {
    const row = await this.tenantDb.tx(auth.org.id, async (db) => {
      const [found] = await db
        .select()
        .from(gdprExports)
        .where(
          and(
            eq(gdprExports.id, id),
            eq(gdprExports.orgId, auth.org.id),
            eq(gdprExports.userId, auth.user.id),
          ),
        );
      return found ?? null;
    });
    if (!row) {
      throw new NotFoundException({ message: 'Export not found', code: 'EXPORT_NOT_FOUND' });
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException({ message: 'Export has expired', code: 'EXPORT_EXPIRED' });
    }
    if (row.status !== 'ready' || !row.storageKey || !row.checksum) {
      throw new ConflictException({
        message: 'Export is not ready for download',
        code: 'EXPORT_NOT_READY',
      });
    }
    const key = exportKey(row.storageKey);
    let bytes: Buffer | null = null;
    try {
      bytes = (await this.storage.read(key)).buffer;
    } catch {
      bytes = null;
    }
    if (!bytes) {
      throw new NotFoundException({
        message: 'Export file is missing',
        code: 'EXPORT_FILE_MISSING',
      });
    }
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (checksum !== row.checksum) {
      throw new ConflictException({
        message: 'Export failed integrity verification',
        code: 'EXPORT_CHECKSUM_MISMATCH',
      });
    }
    if (this.storage.activeDriver === 'local') {
      return {
        path: this.storage.localPathFor(key),
        filename: `nexus-export-${row.id}.json`,
        size: bytes.length,
      };
    }
    return { buffer: bytes, filename: `nexus-export-${row.id}.json`, size: bytes.length };
  }

  /**
   * Self-serve erasure. Synchronous: the whole operation is a single fast
   * transaction (no external I/O), so a queue would add machinery without
   * benefit. The audit trail keeps one receipt row; everything else is
   * scrubbed. Refuses to orphan the org by erasing its last owner.
   */
  async requestErasure(auth: AuthContext, password?: string): Promise<{ ok: true }> {
    const files = await this.tenantDb.tx(auth.org.id, async (db) => {
      const [row] = await db
        .select({ user: users, role: roles })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(and(eq(users.id, auth.user.id), eq(users.orgId, auth.org.id)));
      if (!row) {
        throw new NotFoundException({ message: 'User not found', code: 'USER_NOT_FOUND' });
      }
      if (row.user.passwordHash) {
        if (!password) {
          throw new UnauthorizedException({
            message: 'Password confirmation is required',
            code: 'PASSWORD_REQUIRED',
          });
        }
        const ok = await this.passwords.verify(row.user.passwordHash, password);
        if (!ok) {
          throw new UnauthorizedException({
            message: 'Invalid password',
            code: 'INVALID_CREDENTIALS',
          });
        }
      }
      if (row.role.key === 'owner') {
        const owners = await db
          .select({ id: users.id })
          .from(users)
          .innerJoin(roles, eq(users.roleId, roles.id))
          .where(and(eq(users.orgId, auth.org.id), eq(roles.key, 'owner')));
        if (owners.length <= 1) {
          throw new ConflictException({
            message: 'Cannot erase the last owner of the workspace',
            code: 'LAST_OWNER',
          });
        }
      }
      const exportRows = await db
        .select({ storageKey: gdprExports.storageKey })
        .from(gdprExports)
        .where(and(eq(gdprExports.orgId, auth.org.id), eq(gdprExports.userId, row.user.id)));
      // Scrub actor snapshots on historical rows first; the receipt below is
      // inserted afterwards and keeps the email as compliance proof.
      await db
        .update(auditLogEntries)
        .set({ actorEmail: null })
        .where(eq(auditLogEntries.actorUserId, row.user.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: row.user.id,
        actorEmail: row.user.email,
        action: 'user.erased',
        entityType: 'user',
        entityId: row.user.id,
        newValues: { email: row.user.email },
      });
      await db
        .delete(emailInvites)
        .where(
          and(
            eq(emailInvites.orgId, auth.org.id),
            sql`lower(${emailInvites.email}) = ${row.user.email.toLowerCase()}`,
          ),
        );
      await db
        .delete(gdprExports)
        .where(and(eq(gdprExports.orgId, auth.org.id), eq(gdprExports.userId, row.user.id)));
      // Cascades sessions, 2FA, reset tokens; nulls invited_by, audit actors,
      // and export user refs.
      await db.delete(users).where(eq(users.id, row.user.id));
      return exportRows.map((r) => r.storageKey).filter((k): k is string => !!k);
    });
    for (const key of files) {
      await this.storage.delete(exportKey(key));
    }
    return { ok: true as const };
  }

  async handleExport(exportId: string): Promise<void> {
    const row = await this.identityDb.db
      .select()
      .from(gdprExports)
      .where(eq(gdprExports.id, exportId));
    const found = row[0];
    if (!found || found.status !== 'pending') return;
    await this.tenantDb.tx(found.orgId, (db) =>
      db.update(gdprExports).set({ status: 'processing' }).where(eq(gdprExports.id, exportId)),
    );
    try {
      const pkg = await this.buildPackage(found.orgId, found.userId);
      const storageKey = `${exportId}.json`;
      const bytes = Buffer.from(JSON.stringify(pkg, null, 2), 'utf8');
      await this.storage.save(exportKey(storageKey), bytes);
      const checksum = createHash('sha256').update(bytes).digest('hex');
      const expiresAt = new Date(Date.now() + exportTtlDays() * 24 * 60 * 60 * 1000);
      await this.tenantDb.tx(found.orgId, async (db) => {
        await db
          .update(gdprExports)
          .set({
            status: 'ready',
            storageKey,
            fileSize: String(bytes.length),
            checksum,
            expiresAt,
            completedAt: new Date(),
          })
          .where(eq(gdprExports.id, exportId));
        await this.audit.record(db, {
          orgId: found.orgId,
          actorUserId: found.userId,
          action: 'privacy.export.completed',
          entityType: 'gdpr_export',
          entityId: exportId,
        });
      });
      if (pkg.user.email) {
        await this.mail.sendExportReady(pkg.user.email, pkg.org.name, exportId);
      }
    } catch (err) {
      await this.tenantDb.tx(found.orgId, (db) =>
        db
          .update(gdprExports)
          .set({ status: 'failed', error: (err as Error).message.slice(0, 500) })
          .where(eq(gdprExports.id, exportId)),
      );
    }
  }

  async expireExports(): Promise<{ expired: number }> {
    const rows = await this.identityDb.db
      .select()
      .from(gdprExports)
      .where(eq(gdprExports.status, 'ready'));
    let expired = 0;
    for (const row of rows) {
      if (!row.expiresAt || row.expiresAt.getTime() > Date.now()) continue;
      await this.tenantDb.tx(row.orgId, (db) =>
        db.update(gdprExports).set({ status: 'expired' }).where(eq(gdprExports.id, row.id)),
      );
      if (row.storageKey) {
        await this.storage.delete(exportKey(row.storageKey));
      }
      expired += 1;
    }
    return { expired };
  }

  private async buildPackage(orgId: string, userId: string | null): Promise<ExportPackage> {
    if (!userId) throw new Error('Export has no associated user');
    return this.tenantDb.tx(orgId, async (db) => {
      const [row] = await db
        .select({ user: users, role: roles, org: organizations })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .innerJoin(organizations, eq(users.orgId, organizations.id))
        .where(and(eq(users.id, userId), eq(users.orgId, orgId)));
      if (!row) throw new Error('User not found for export');
      const { user, role, org } = row;
      const sessionRows = await db.select().from(sessions).where(eq(sessions.userId, userId));
      const [tfa] = await db.select().from(twoFactor).where(eq(twoFactor.userId, userId));
      const sent = await db
        .select({ invite: emailInvites, inviteRole: roles })
        .from(emailInvites)
        .innerJoin(roles, eq(emailInvites.roleId, roles.id))
        .where(and(eq(emailInvites.orgId, orgId), eq(emailInvites.invitedBy, userId)));
      const received = await db
        .select({ invite: emailInvites, inviteRole: roles })
        .from(emailInvites)
        .innerJoin(roles, eq(emailInvites.roleId, roles.id))
        .where(
          and(
            eq(emailInvites.orgId, orgId),
            sql`lower(${emailInvites.email}) = ${user.email.toLowerCase()}`,
          ),
        );
      const auditRows = await db
        .select()
        .from(auditLogEntries)
        .where(and(eq(auditLogEntries.orgId, orgId), eq(auditLogEntries.actorUserId, userId)));
      return {
        exportedAt: new Date().toISOString(),
        org: { id: org.id, name: org.name, slug: org.slug },
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          status: user.status,
          timezone: user.timezone,
          role: { key: role.key, name: role.name },
          ssoProvider: user.ssoProvider,
          createdAt: user.createdAt,
        },
        sessions: sessionRows.map((s) => ({
          id: s.id,
          ipAddress: s.ipAddress,
          userAgent: s.userAgent,
          twoFactorVerified: s.twoFactorVerified,
          createdAt: s.createdAt,
          expiresAt: s.expiresAt,
          revokedAt: s.revokedAt,
        })),
        twoFactor: { enrolled: !!tfa?.enabledAt, enabledAt: tfa?.enabledAt ?? null },
        invitesSent: sent.map((r) => ({
          email: r.invite.email,
          roleKey: r.inviteRole.key,
          acceptedAt: r.invite.acceptedAt,
          createdAt: r.invite.createdAt,
        })),
        invitesReceived: received.map((r) => ({
          email: r.invite.email,
          roleKey: r.inviteRole.key,
          createdAt: r.invite.createdAt,
        })),
        auditEntries: auditRows.map((a) => ({
          id: a.id,
          action: a.action,
          entityType: a.entityType,
          entityId: a.entityId,
          oldValues: a.oldValues,
          newValues: a.newValues,
          ipAddress: a.ipAddress,
          createdAt: a.createdAt,
        })),
      };
    });
  }
}
