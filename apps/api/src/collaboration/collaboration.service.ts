import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  attachments,
  comments,
  deals,
  notifications,
  tasks,
  users,
  type Attachment,
  type Comment,
} from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { ContactsService } from '../contacts/contacts.service';
import { MailService } from '../mail/mail.service';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { checkRecordAccess, hasScope } from '../rbac/permissions';
import type {
  CreateCommentInput,
  ListAttachmentsQuery,
  ListCommentsQuery,
  UpdateCommentInput,
} from './collaboration.schemas';

export type CommentEntityType = 'contact' | 'deal' | 'task';

export interface SerializedComment {
  id: string;
  author: { id: string; name: string } | null;
  authorId: string | null;
  entityType: CommentEntityType;
  entityId: string;
  body: string;
  mentionedUsers: Array<{ id: string; name: string; email: string }>;
  createdAt: Date;
  updatedAt: Date;
}

export interface SerializedAttachment {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  entityType: CommentEntityType;
  entityId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
}

/** @mention syntax: @email (unambiguous, no picker needed for V1). */
const MENTION_PATTERN = /@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

function parseCursor(cursor: string): { time: Date; id: string } | null {
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const time = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(time.getTime()) || !id) return null;
  return { time, id };
}

function recordForbidden(): never {
  throw new ForbiddenException({
    message: 'Not allowed to access this record',
    code: 'RECORD_FORBIDDEN',
  });
}

function excerpt(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

@Injectable()
export class CollaborationService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(NotificationPreferencesService)
    private readonly preferences: NotificationPreferencesService,
  ) {}

  async createComment(
    auth: AuthContext,
    input: CreateCommentInput,
  ): Promise<{ comment: SerializedComment }> {
    let notify: Array<{ id: string; name: string; email: string }> = [];
    const result = await this.tenantDb.tx(auth.org.id, async (db) => {
      await this.assertParentReadable(db, auth, input.entityType, input.entityId);
      const mentioned = await this.resolveMentions(db, auth.org.id, auth.user.id, input.body);
      const [created] = await db
        .insert(comments)
        .values({
          orgId: auth.org.id,
          authorId: auth.user.id,
          entityType: input.entityType,
          entityId: input.entityId,
          body: input.body,
          mentionedUserIds: mentioned.map((m) => m.id),
        })
        .returning();
      if (!created) throw new Error('Comment insert returned no row');
      const emailTargets: Array<{ id: string; name: string; email: string }> = [];
      for (const target of mentioned) {
        if (await this.preferences.wantsChannel(db, auth.org.id, target.id, 'mention', 'inapp')) {
          await db.insert(notifications).values({
            orgId: auth.org.id,
            userId: target.id,
            type: 'mention',
            title: `${auth.user.name} mentioned you`,
            body: excerpt(input.body),
            link: this.recordLink(input.entityType, input.entityId),
          });
        }
        if (await this.preferences.wantsChannel(db, auth.org.id, target.id, 'mention', 'email')) {
          emailTargets.push(target);
        }
      }
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'comment.created',
        entityType: input.entityType,
        entityId: input.entityId,
        newValues: { commentId: created.id, preview: excerpt(input.body, 200) },
      });
      notify = emailTargets;
      return { comment: await this.serializeCommentById(db, auth, created.id) };
    });
    // Best-effort mention emails outside the tx: mail failure must not
    // roll back an already-saved comment.
    for (const target of notify) {
      try {
        await this.mail.sendEmail({
          to: target.email,
          subject: `[Nexus] ${auth.user.name} mentioned you`,
          text: `${auth.user.name} mentioned you in a comment:\n\n${result.comment.body}\n\nView it: ${this.recordLink(input.entityType, input.entityId)}`,
        });
      } catch {
        // Mention email is advisory; the in-app notification persists.
      }
    }
    return result;
  }

  async listComments(
    auth: AuthContext,
    query: ListCommentsQuery,
  ): Promise<{ comments: SerializedComment[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      await this.assertParentReadable(db, auth, query.entityType, query.entityId);
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [
        eq(comments.orgId, auth.org.id),
        eq(comments.entityType, query.entityType),
        eq(comments.entityId, query.entityId),
        isNull(comments.deletedAt),
      ];
      if (query.cursor) {
        const parsed = parseCursor(query.cursor);
        if (!parsed) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
        conditions.push(
          sql`(${comments.createdAt}, ${comments.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ comment: comments, author: users })
        .from(comments)
        .leftJoin(users, eq(comments.authorId, users.id))
        .where(and(...conditions))
        .orderBy(desc(comments.createdAt), desc(comments.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const serialized = await Promise.all(
        page.map((row) => this.serializeComment(db, row.comment, row.author)),
      );
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? `${last.comment.createdAt.toISOString()}|${last.comment.id}`
          : null;
      return { comments: serialized, nextCursor };
    });
  }

  async updateComment(
    auth: AuthContext,
    id: string,
    patch: UpdateCommentInput,
  ): Promise<{ comment: SerializedComment }> {
    let notify: Array<{ id: string; name: string; email: string }> = [];
    let recordLink = '';
    const result = await this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveComment(db, auth.org.id, id);
      this.assertCommentWritable(auth, row.authorId);
      await this.assertParentReadable(db, auth, row.entityType as CommentEntityType, row.entityId);
      const previous = new Set(row.mentionedUserIds ?? []);
      const mentioned = await this.resolveMentions(db, auth.org.id, auth.user.id, patch.body);
      const fresh = mentioned.filter((m) => !previous.has(m.id));
      const [updated] = await db
        .update(comments)
        .set({
          body: patch.body,
          mentionedUserIds: mentioned.map((m) => m.id),
          updatedAt: new Date(),
        })
        .where(eq(comments.id, row.id))
        .returning();
      if (!updated) throw new Error('Comment update returned no row');
      const emailTargets: Array<{ id: string; name: string; email: string }> = [];
      for (const target of fresh) {
        if (await this.preferences.wantsChannel(db, auth.org.id, target.id, 'mention', 'inapp')) {
          await db.insert(notifications).values({
            orgId: auth.org.id,
            userId: target.id,
            type: 'mention',
            title: `${auth.user.name} mentioned you`,
            body: excerpt(patch.body),
            link: this.recordLink(row.entityType as CommentEntityType, row.entityId),
          });
        }
        if (await this.preferences.wantsChannel(db, auth.org.id, target.id, 'mention', 'email')) {
          emailTargets.push(target);
        }
      }
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'comment.updated',
        entityType: row.entityType,
        entityId: row.entityId,
        oldValues: { commentId: row.id, preview: excerpt(row.body, 200) },
        newValues: { commentId: row.id, preview: excerpt(patch.body, 200) },
      });
      notify = emailTargets;
      recordLink = this.recordLink(row.entityType as CommentEntityType, row.entityId);
      return { comment: await this.serializeCommentById(db, auth, updated.id) };
    });
    for (const target of notify) {
      try {
        await this.mail.sendEmail({
          to: target.email,
          subject: `[Nexus] ${auth.user.name} mentioned you`,
          text: `${auth.user.name} mentioned you in a comment:\n\n${result.comment.body}\n\nView it: ${recordLink}`,
        });
      } catch {
        // Advisory only.
      }
    }
    return result;
  }

  async removeComment(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveComment(db, auth.org.id, id);
      this.assertCommentWritable(auth, row.authorId);
      await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'comment.deleted',
        entityType: row.entityType,
        entityId: row.entityId,
        oldValues: { commentId: row.id },
      });
      return { ok: true as const };
    });
  }

  async listAttachments(
    auth: AuthContext,
    query: ListAttachmentsQuery,
  ): Promise<{ attachments: SerializedAttachment[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      await this.assertParentReadable(db, auth, query.entityType, query.entityId);
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [
        eq(attachments.orgId, auth.org.id),
        eq(attachments.entityType, query.entityType),
        eq(attachments.entityId, query.entityId),
        isNull(attachments.deletedAt),
      ];
      if (query.cursor) {
        const parsed = parseCursor(query.cursor);
        if (!parsed) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
        conditions.push(
          sql`(${attachments.createdAt}, ${attachments.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ attachment: attachments, owner: users })
        .from(attachments)
        .leftJoin(users, eq(attachments.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(attachments.createdAt), desc(attachments.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? `${last.attachment.createdAt.toISOString()}|${last.attachment.id}`
          : null;
      return {
        attachments: page.map((row) => this.serializeAttachment(row.attachment, row.owner)),
        nextCursor,
      };
    });
  }

  async serializeAttachmentById(
    db: NexusDb,
    auth: AuthContext,
    id: string,
  ): Promise<{ attachment: Attachment; serialized: SerializedAttachment }> {
    const [row] = await db
      .select({ attachment: attachments, owner: users })
      .from(attachments)
      .leftJoin(users, eq(attachments.ownerId, users.id))
      .where(
        and(
          eq(attachments.id, id),
          eq(attachments.orgId, auth.org.id),
          isNull(attachments.deletedAt),
        ),
      );
    if (!row) {
      throw new NotFoundException({
        message: 'Attachment not found',
        code: 'ATTACHMENT_NOT_FOUND',
      });
    }
    await this.assertParentReadable(
      db,
      auth,
      row.attachment.entityType as CommentEntityType,
      row.attachment.entityId,
    );
    return {
      attachment: row.attachment,
      serialized: this.serializeAttachment(row.attachment, row.owner),
    };
  }

  serializeAttachment(
    attachment: Attachment,
    owner: { id: string; name: string } | null,
  ): SerializedAttachment {
    return {
      id: attachment.id,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      ownerId: attachment.ownerId,
      entityType: attachment.entityType as CommentEntityType,
      entityId: attachment.entityId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      createdAt: attachment.createdAt,
      updatedAt: attachment.updatedAt,
    };
  }

  private recordLink(entityType: CommentEntityType, entityId: string): string {
    if (entityType === 'contact') return `/contacts/${entityId}`;
    if (entityType === 'deal') return `/deals/${entityId}`;
    return '/tasks';
  }

  /**
   * Comment access follows the parent record: you can discuss what you
   * can see. Writes additionally require the comments:manage route scope
   * (checked in the controller); reads require comments:read.
   * Public for the attachments module (same parent rule).
   */
  async assertParentReadable(
    db: NexusDb,
    auth: AuthContext,
    entityType: CommentEntityType,
    entityId: string,
  ): Promise<void> {
    if (entityType === 'contact') {
      const row = await this.contacts.requireLiveContact(db, auth.org.id, entityId);
      this.contacts.assertContactReadable(auth, row.contact.ownerId);
      return;
    }
    if (entityType === 'deal') {
      const [deal] = await db
        .select({ ownerId: deals.ownerId })
        .from(deals)
        .where(and(eq(deals.id, entityId), eq(deals.orgId, auth.org.id), isNull(deals.deletedAt)));
      if (!deal) {
        throw new NotFoundException({ message: 'Deal not found', code: 'DEAL_NOT_FOUND' });
      }
      this.assertReadable(auth, 'deal', deal.ownerId);
      return;
    }
    const [task] = await db
      .select({ ownerId: tasks.ownerId })
      .from(tasks)
      .where(and(eq(tasks.id, entityId), eq(tasks.orgId, auth.org.id), isNull(tasks.deletedAt)));
    if (!task) {
      throw new NotFoundException({ message: 'Task not found', code: 'TASK_NOT_FOUND' });
    }
    this.assertReadable(auth, 'task', task.ownerId);
  }

  private assertReadable(auth: AuthContext, entity: string, ownerId: string | null): void {
    try {
      checkRecordAccess(auth.role.permissions, entity, ownerId ?? '', auth.user.id);
    } catch {
      recordForbidden();
    }
  }

  /** Authors edit/delete their own comments; users:manage may moderate any. */
  private assertCommentWritable(auth: AuthContext, authorId: string | null): void {
    if (authorId === auth.user.id) return;
    if (!hasScope(auth.role.permissions, 'users:manage')) {
      throw new ForbiddenException({
        message: 'Only the author or a workspace manager may edit this comment',
        code: 'COMMENT_FORBIDDEN',
      });
    }
  }

  private async resolveMentions(
    db: NexusDb,
    orgId: string,
    authorId: string,
    body: string,
  ): Promise<Array<{ id: string; name: string; email: string }>> {
    const addresses = new Set<string>();
    for (const match of body.matchAll(MENTION_PATTERN)) {
      if (match[1]) addresses.add(match[1].toLowerCase());
    }
    const mentioned: Array<{ id: string; name: string; email: string }> = [];
    for (const address of addresses) {
      const [member] = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.orgId, orgId), sql`lower(${users.email}) = ${address}`));
      if (member && member.id !== authorId && !mentioned.some((m) => m.id === member.id)) {
        mentioned.push(member);
      }
    }
    return mentioned;
  }

  private async requireLiveComment(db: NexusDb, orgId: string, id: string): Promise<Comment> {
    const [row] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.id, id), eq(comments.orgId, orgId), isNull(comments.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Comment not found', code: 'COMMENT_NOT_FOUND' });
    }
    return row;
  }

  private async serializeCommentById(
    db: NexusDb,
    auth: AuthContext,
    id: string,
  ): Promise<SerializedComment> {
    const [row] = await db
      .select({ comment: comments, author: users })
      .from(comments)
      .leftJoin(users, eq(comments.authorId, users.id))
      .where(and(eq(comments.id, id), eq(comments.orgId, auth.org.id), isNull(comments.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Comment not found', code: 'COMMENT_NOT_FOUND' });
    }
    await this.assertParentReadable(
      db,
      auth,
      row.comment.entityType as CommentEntityType,
      row.comment.entityId,
    );
    return this.serializeComment(db, row.comment, row.author);
  }

  private async serializeComment(
    db: NexusDb,
    comment: Comment,
    author: { id: string; name: string } | null,
  ): Promise<SerializedComment> {
    const ids = (comment.mentionedUserIds ?? []) as string[];
    let mentionedUsers: Array<{ id: string; name: string; email: string }> = [];
    if (ids.length > 0) {
      const rows = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.orgId, comment.orgId),
            sql`${users.id} IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        );
      mentionedUsers = rows;
    }
    return {
      id: comment.id,
      author: author ? { id: author.id, name: author.name } : null,
      authorId: comment.authorId,
      entityType: comment.entityType as CommentEntityType,
      entityId: comment.entityId,
      body: comment.body,
      mentionedUsers,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  }
}
