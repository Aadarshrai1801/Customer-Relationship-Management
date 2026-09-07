import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, eq, isNull, sum } from 'drizzle-orm';
import { attachments, organizations } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { CollaborationService, type CommentEntityType } from './collaboration.service';

export interface MulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export function storageRoot(): string {
  return resolve(process.env.STORAGE_DIR ?? 'storage', 'attachments');
}

/** Predictable allowlist (documented): documents, images, and archives. */
const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'txt',
  'md',
  'csv',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'zip',
]);

function extensionOf(filename: string): string {
  const parts = filename.toLowerCase().split('.');
  return parts.length > 1 ? (parts[parts.length - 1] as string) : '';
}

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? 'file';
  return base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 200) || 'file';
}

function tooLarge(message: string, code: string): never {
  throw new PayloadTooLargeException({ message, code });
}

export function resolveAttachmentCaps(settings: unknown): {
  maxAttachmentBytes: number;
  attachmentStorageCapBytes: number;
} {
  const raw = (settings ?? {}) as Record<string, unknown>;
  const maxFile =
    typeof raw['maxAttachmentBytes'] === 'number' && raw['maxAttachmentBytes'] > 0
      ? raw['maxAttachmentBytes']
      : 25 * 1024 * 1024;
  const orgCap =
    typeof raw['attachmentStorageCapBytes'] === 'number' && raw['attachmentStorageCapBytes'] > 0
      ? raw['attachmentStorageCapBytes']
      : 10 * 1024 * 1024 * 1024;
  return { maxAttachmentBytes: maxFile, attachmentStorageCapBytes: orgCap };
}

@Injectable()
export class AttachmentsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CollaborationService) private readonly collaboration: CollaborationService,
  ) {}

  async upload(
    auth: AuthContext,
    entityType: CommentEntityType,
    entityId: string,
    file: MulterFile | undefined,
  ): Promise<{ attachment: unknown }> {
    if (!file || file.size === 0) {
      throw new BadRequestException({ message: 'No file received', code: 'FILE_MISSING' });
    }
    return this.tenantDb.tx(auth.org.id, async (db) => {
      await this.collaboration.assertParentReadable(db, auth, entityType, entityId);
      const caps = await this.orgCaps(db, auth.org.id);
      if (file.size > caps.maxAttachmentBytes) {
        tooLarge(
          `File exceeds the ${Math.round(caps.maxAttachmentBytes / 1024 / 1024)}MB per-file limit`,
          'FILE_TOO_LARGE',
        );
      }
      const ext = extensionOf(file.originalname);
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new BadRequestException({
          message: `Files of type .${ext || '(none)'} are not accepted`,
          code: 'FILE_TYPE_INVALID',
        });
      }
      const used = await this.liveBytes(db, auth.org.id);
      if (used + file.size > caps.attachmentStorageCapBytes) {
        tooLarge('Workspace attachment storage cap reached', 'STORAGE_CAP_EXCEEDED');
      }
      const storageKey = `${auth.org.id}/${randomUUID()}-${sanitizeFilename(file.originalname)}`;
      const dest = join(storageRoot(), storageKey);
      await fs.mkdir(join(storageRoot(), auth.org.id), { recursive: true });
      await fs.writeFile(dest, file.buffer);
      const [created] = await db
        .insert(attachments)
        .values({
          orgId: auth.org.id,
          ownerId: auth.user.id,
          entityType,
          entityId,
          filename: file.originalname.slice(0, 255),
          mimeType: file.mimetype || 'application/octet-stream',
          sizeBytes: file.size,
          storageKey,
        })
        .returning();
      if (!created) {
        await fs.unlink(dest).catch(() => undefined);
        throw new Error('Attachment insert returned no row');
      }
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'attachment.uploaded',
        entityType,
        entityId,
        newValues: {
          attachmentId: created.id,
          filename: created.filename,
          sizeBytes: created.sizeBytes,
        },
      });
      return {
        attachment: this.collaboration.serializeAttachment(created, {
          id: auth.user.id,
          name: auth.user.name,
        }),
      };
    });
  }

  async downloadPath(
    auth: AuthContext,
    id: string,
  ): Promise<{ path: string; filename: string; mimeType: string; size: number }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const { attachment } = await this.collaboration.serializeAttachmentById(db, auth, id);
      const path = join(storageRoot(), attachment.storageKey);
      try {
        const stat = await fs.stat(path);
        if (!stat.isFile()) throw new Error('not a file');
      } catch {
        throw new NotFoundException({
          message: 'Attachment file is missing from storage',
          code: 'FILE_MISSING_FROM_STORAGE',
        });
      }
      return {
        path,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.sizeBytes,
      };
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    const storageKey = await this.tenantDb.tx(auth.org.id, async (db) => {
      const { attachment } = await this.collaboration.serializeAttachmentById(db, auth, id);
      await db
        .update(attachments)
        .set({ deletedAt: new Date() })
        .where(eq(attachments.id, attachment.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'attachment.deleted',
        entityType: attachment.entityType,
        entityId: attachment.entityId,
        oldValues: { attachmentId: attachment.id, filename: attachment.filename },
      });
      return attachment.storageKey;
    });
    // Best effort: quota accounting already excludes the soft-deleted row.
    await fs.unlink(join(storageRoot(), storageKey)).catch(() => undefined);
    return { ok: true as const };
  }

  /** Disk usage for quota display (bytes of live attachments). */
  async usage(auth: AuthContext): Promise<{ bytes: number; cap: number; maxFile: number }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const caps = await this.orgCaps(db, auth.org.id);
      return {
        bytes: await this.liveBytes(db, auth.org.id),
        cap: caps.attachmentStorageCapBytes,
        maxFile: caps.maxAttachmentBytes,
      };
    });
  }

  private async orgCaps(db: NexusDb, orgId: string) {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    return resolveAttachmentCaps(org?.settings);
  }

  private async liveBytes(db: NexusDb, orgId: string): Promise<number> {
    const rows = await db
      .select({ bytes: sum(attachments.sizeBytes).mapWith(Number) })
      .from(attachments)
      .where(and(eq(attachments.orgId, orgId), isNull(attachments.deletedAt)));
    return rows[0]?.bytes ?? 0;
  }
}
