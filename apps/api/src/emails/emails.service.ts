import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  accounts,
  activities,
  contacts,
  deals,
  emailTemplates,
  users,
  type Activity,
  type EmailTemplate,
} from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { ContactsService } from '../contacts/contacts.service';
import { MailService } from '../mail/mail.service';
import { checkRecordAccess } from '../rbac/permissions';
import type {
  ConvertSuggestionInput,
  CreateTemplateInput,
  SendEmailInput,
  SyncInboundInput,
  UpdateTemplateInput,
} from './emails.schemas';

export interface SerializedEmailActivity {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  contact: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  subject: string | null;
  body: string | null;
  occurredAt: Date;
  direction: string;
  senderEmail: string | null;
  recipientEmails: string[];
  provider: string | null;
  externalId: string | null;
  syncStatus: string;
  createdAt: Date;
  updatedAt: Date;
}

function recordForbidden(): never {
  throw new ForbiddenException({
    message: 'Not allowed to access this record',
    code: 'RECORD_FORBIDDEN',
  });
}

function parseCursor(cursor: string): { time: Date; id: string } | null {
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const time = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(time.getTime()) || !id) return null;
  return { time, id };
}

/**
 * Renders {{variable}} placeholders. Unknown keys render empty rather
 * than failing the send (stated assumption, documented on the template
 * table). Values are stringified; surrounding whitespace in the key is
 * ignored and matching is case-sensitive.
 */
export function renderTemplateText(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === null || value === undefined) return '';
    return typeof value === 'string' ? value : String(value);
  });
}

@Injectable()
export class EmailsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ContactsService) private readonly contacts: ContactsService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /**
   * Inbound provider ingest. Matches sender first, then recipients, against
   * live contacts; unmatched mail is kept with a null contact so the UI
   * can prompt "log as new contact?" (PRD 4.5) instead of dropping it.
   * Dedup matches on message-id across providers, so a BCC copy collapses
   * into the natively synced row.
   */
  async syncInbound(
    auth: AuthContext,
    input: SyncInboundInput,
  ): Promise<{ activity: SerializedEmailActivity; created: boolean; changed: boolean }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [existing] = await db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.orgId, auth.org.id),
            eq(activities.type, 'email'),
            eq(activities.externalId, input.externalId),
          ),
        );
      if (existing) {
        return {
          activity: await this.serializeEmailById(db, auth, existing.id),
          created: false,
          changed: false,
        };
      }
      const match = await this.matchContactByEmails(db, auth.org.id, [input.from, ...input.to]);
      const [created] = await db
        .insert(activities)
        .values({
          orgId: auth.org.id,
          ownerId: auth.user.id,
          contactId: match?.contactId ?? null,
          accountId: match?.accountId ?? null,
          type: 'email',
          subject: input.subject ?? null,
          body: input.body ?? null,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
          direction: 'inbound',
          senderEmail: input.from.toLowerCase(),
          recipientEmails: input.to.map((e) => e.toLowerCase()),
          provider: input.provider,
          externalId: input.externalId,
        })
        .returning();
      if (!created) throw new Error('Inbound email insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'activity.synced',
        entityType: 'activity',
        entityId: created.id,
        newValues: {
          provider: input.provider,
          externalId: input.externalId,
          contactId: match?.contactId ?? null,
        },
      });
      return {
        activity: await this.serializeEmailById(db, auth, created.id),
        created: true,
        changed: true,
      };
    });
  }

  async listSuggestions(
    auth: AuthContext,
    query: { limit?: number; cursor?: string },
  ): Promise<{ suggestions: SerializedEmailActivity[]; nextCursor: string | null }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const conditions = [
        eq(activities.orgId, auth.org.id),
        eq(activities.type, 'email'),
        eq(activities.direction, 'inbound'),
        isNull(activities.contactId),
      ];
      const canSeeAll = (auth.role.permissions?.recordAccess?.['activity'] ?? 'own') === 'all';
      if (!canSeeAll) {
        conditions.push(eq(activities.ownerId, auth.user.id));
      }
      if (query.cursor) {
        const parsed = parseCursor(query.cursor);
        if (!parsed) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
        conditions.push(
          sql`(${activities.occurredAt}, ${activities.id}) < (${parsed.time}, ${parsed.id}::uuid)`,
        );
      }
      const rows = await db
        .select({ activity: activities, owner: users })
        .from(activities)
        .leftJoin(users, eq(activities.ownerId, users.id))
        .where(and(...conditions))
        .orderBy(desc(activities.occurredAt), desc(activities.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const serialized = await Promise.all(
        page.map((row) => this.serializeEmail(db, row.activity, row.owner)),
      );
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? `${last.activity.occurredAt.toISOString()}|${last.activity.id}`
          : null;
      return { suggestions: serialized, nextCursor };
    });
  }

  /**
   * Converts an unmatched inbound email into a new contact (PRD 4.5:
   * "log as new contact?") and links the email to it. The contact email
   * is the sender, falling back to the first recipient.
   */
  async convertSuggestion(
    auth: AuthContext,
    id: string,
    input: ConvertSuggestionInput,
  ): Promise<{ contact: { id: string }; activity: SerializedEmailActivity }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const email = await this.serializeEmailById(db, auth, id);
      if (email.direction !== 'inbound') {
        throw new BadRequestException({
          message: 'Only inbound emails can be converted to contacts',
          code: 'NOT_INBOUND_EMAIL',
        });
      }
      const address = email.senderEmail ?? email.recipientEmails[0] ?? null;
      if (!address) {
        throw new BadRequestException({
          message: 'Email has no address to create a contact from',
          code: 'NO_ADDRESS',
        });
      }
      let accountId: string | null = null;
      if (input.accountId) {
        const [account] = await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, input.accountId),
              eq(accounts.orgId, auth.org.id),
              isNull(accounts.deletedAt),
            ),
          );
        if (!account) {
          throw new NotFoundException({ message: 'Account not found', code: 'ACCOUNT_NOT_FOUND' });
        }
        accountId = account.id;
      }
      const [created] = await db
        .insert(contacts)
        .values({
          orgId: auth.org.id,
          accountId,
          ownerId: auth.user.id,
          name: input.name,
          email: address,
        })
        .returning();
      if (!created) throw new Error('Contact insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'contact.created',
        entityType: 'contact',
        entityId: created.id,
        newValues: { name: created.name, email: created.email, fromEmailActivity: id },
      });
      await db
        .update(activities)
        .set({ contactId: created.id, accountId, updatedAt: new Date() })
        .where(eq(activities.id, id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'activity.updated',
        entityType: 'activity',
        entityId: id,
        newValues: { contactId: created.id },
      });
      return {
        contact: { id: created.id },
        activity: await this.serializeEmailById(db, auth, id),
      };
    });
  }

  async createTemplate(
    auth: AuthContext,
    input: CreateTemplateInput,
  ): Promise<{ template: EmailTemplate }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [duplicate] = await db
        .select({ id: emailTemplates.id })
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.orgId, auth.org.id),
            eq(emailTemplates.name, input.name),
            isNull(emailTemplates.deletedAt),
          ),
        );
      if (duplicate) {
        throw new ConflictException({
          message: 'A template with this name already exists',
          code: 'TEMPLATE_NAME_TAKEN',
        });
      }
      const [created] = await db
        .insert(emailTemplates)
        .values({
          orgId: auth.org.id,
          createdById: auth.user.id,
          name: input.name,
          subject: input.subject,
          body: input.body,
        })
        .returning();
      if (!created) throw new Error('Template insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'email_template.created',
        entityType: 'email_template',
        entityId: created.id,
        newValues: { name: created.name },
      });
      return { template: created };
    });
  }

  async listTemplates(auth: AuthContext): Promise<EmailTemplate[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return db
        .select()
        .from(emailTemplates)
        .where(and(eq(emailTemplates.orgId, auth.org.id), isNull(emailTemplates.deletedAt)))
        .orderBy(emailTemplates.name);
    });
  }

  async getTemplate(auth: AuthContext, id: string): Promise<EmailTemplate> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return this.requireLiveTemplate(db, auth.org.id, id);
    });
  }

  async updateTemplate(
    auth: AuthContext,
    id: string,
    patch: UpdateTemplateInput,
  ): Promise<{ template: EmailTemplate }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveTemplate(db, auth.org.id, id);
      if (patch.name && patch.name !== row.name) {
        const [duplicate] = await db
          .select({ id: emailTemplates.id })
          .from(emailTemplates)
          .where(
            and(
              eq(emailTemplates.orgId, auth.org.id),
              eq(emailTemplates.name, patch.name),
              isNull(emailTemplates.deletedAt),
            ),
          );
        if (duplicate) {
          throw new ConflictException({
            message: 'A template with this name already exists',
            code: 'TEMPLATE_NAME_TAKEN',
          });
        }
      }
      const [updated] = await db
        .update(emailTemplates)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          updatedAt: new Date(),
        })
        .where(eq(emailTemplates.id, row.id))
        .returning();
      if (!updated) throw new Error('Template update returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'email_template.updated',
        entityType: 'email_template',
        entityId: updated.id,
        newValues: { name: updated.name },
      });
      return { template: updated };
    });
  }

  async removeTemplate(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveTemplate(db, auth.org.id, id);
      await db
        .update(emailTemplates)
        .set({ deletedAt: new Date() })
        .where(eq(emailTemplates.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'email_template.deleted',
        entityType: 'email_template',
        entityId: row.id,
        oldValues: { name: row.name },
      });
      return { ok: true as const };
    });
  }

  /**
   * Sends a rep-composed email through SMTP and auto-logs it as an
   * outbound email activity (PRD 4.5: no manual attaching). The recipient
   * is matched to a contact for timeline attribution when possible.
   * The send happens inside the transaction window: an SMTP failure
   * rolls back the log row, so sends are never silently unlogged.
   */
  async send(
    auth: AuthContext,
    input: SendEmailInput,
  ): Promise<{ activity: SerializedEmailActivity; messageId: string }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      let contactRow: {
        contact: { id: string; name: string; email: string; accountId: string | null };
      } | null = null;
      if (input.contactId) {
        const row = await this.contacts.requireLiveContact(db, auth.org.id, input.contactId);
        contactRow = {
          contact: {
            id: row.contact.id,
            name: row.contact.name,
            email: row.contact.email,
            accountId: row.contact.accountId,
          },
        };
      }
      let subject = input.subject ?? '';
      let body = input.body ?? '';
      if (input.templateId) {
        const template = await this.requireLiveTemplate(db, auth.org.id, input.templateId);
        const variables: Record<string, unknown> = {
          contactName: contactRow?.contact.name ?? '',
          contactEmail: contactRow?.contact.email ?? input.to,
          ownerName: auth.user.name,
          orgName: auth.org.name,
          ...input.variables,
        };
        subject = renderTemplateText(template.subject, variables);
        body = renderTemplateText(template.body, variables);
      }
      if (!subject.trim() || !body.trim()) {
        throw new BadRequestException({
          message: 'Subject and body are required (or provide a template)',
          code: 'VALIDATION_ERROR',
        });
      }
      let contactId: string | null = contactRow?.contact.id ?? null;
      let accountId: string | null = contactRow?.contact.accountId ?? null;
      if (!contactId) {
        const match = await this.matchContactByEmails(db, auth.org.id, [input.to]);
        contactId = match?.contactId ?? null;
        accountId = match?.accountId ?? null;
      }
      let dealId: string | null = null;
      if (input.dealId) {
        const [deal] = await db
          .select({ id: deals.id })
          .from(deals)
          .where(
            and(eq(deals.id, input.dealId), eq(deals.orgId, auth.org.id), isNull(deals.deletedAt)),
          );
        if (!deal) {
          throw new NotFoundException({ message: 'Deal not found', code: 'DEAL_NOT_FOUND' });
        }
        dealId = deal.id;
      }
      const [staged] = await db
        .insert(activities)
        .values({
          orgId: auth.org.id,
          ownerId: auth.user.id,
          contactId,
          accountId,
          dealId,
          type: 'email',
          subject,
          body,
          occurredAt: new Date(),
          direction: 'outbound',
          senderEmail: auth.user.email.toLowerCase(),
          recipientEmails: [input.to.toLowerCase()],
          provider: 'nexus',
          externalId: `pending-${randomUUID()}`,
        })
        .returning();
      if (!staged) throw new Error('Outbound email insert returned no row');
      const messageId = await this.mail.sendEmail({
        to: input.to,
        subject,
        text: body,
      });
      await db
        .update(activities)
        .set({ externalId: messageId, updatedAt: new Date() })
        .where(eq(activities.id, staged.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'email.sent',
        entityType: 'activity',
        entityId: staged.id,
        newValues: { to: input.to, subject, contactId, messageId },
      });
      return {
        activity: await this.serializeEmailById(db, auth, staged.id),
        messageId,
      };
    });
  }

  private async requireLiveTemplate(
    db: NexusDb,
    orgId: string,
    id: string,
  ): Promise<EmailTemplate> {
    const [row] = await db
      .select()
      .from(emailTemplates)
      .where(
        and(
          eq(emailTemplates.id, id),
          eq(emailTemplates.orgId, orgId),
          isNull(emailTemplates.deletedAt),
        ),
      );
    if (!row) {
      throw new NotFoundException({ message: 'Template not found', code: 'TEMPLATE_NOT_FOUND' });
    }
    return row;
  }

  private assertEmailReadable(auth: AuthContext, ownerId: string | null): void {
    try {
      checkRecordAccess(auth.role.permissions, 'activity', ownerId ?? '', auth.user.id);
    } catch {
      recordForbidden();
    }
  }

  private async matchContactByEmails(
    db: NexusDb,
    orgId: string,
    emails: string[],
  ): Promise<{ contactId: string; accountId: string | null } | null> {
    for (const raw of emails) {
      const email = raw.trim().toLowerCase();
      if (!email) continue;
      const candidates = await db
        .select({
          id: contacts.id,
          accountId: contacts.accountId,
          mergedIntoId: contacts.mergedIntoId,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, orgId),
            sql`lower(${contacts.email}) = ${email}`,
            isNull(contacts.deletedAt),
          ),
        )
        .limit(5);
      const winner = candidates.find((c) => !c.mergedIntoId) ?? candidates[0];
      if (winner) {
        return { contactId: winner.id, accountId: winner.accountId };
      }
    }
    return null;
  }

  private async serializeEmailById(
    db: NexusDb,
    auth: AuthContext,
    id: string,
  ): Promise<SerializedEmailActivity> {
    const [row] = await db
      .select({ activity: activities, owner: users })
      .from(activities)
      .leftJoin(users, eq(activities.ownerId, users.id))
      .where(
        and(eq(activities.id, id), eq(activities.orgId, auth.org.id), eq(activities.type, 'email')),
      );
    if (!row) {
      throw new NotFoundException({ message: 'Email not found', code: 'EMAIL_NOT_FOUND' });
    }
    this.assertEmailReadable(auth, row.activity.ownerId);
    return this.serializeEmail(db, row.activity, row.owner);
  }

  private async serializeEmail(
    db: NexusDb,
    activity: Activity,
    owner: { id: string; name: string } | null,
  ): Promise<SerializedEmailActivity> {
    let contact: { id: string; name: string } | null = null;
    let account: { id: string; name: string } | null = null;
    let deal: { id: string; name: string } | null = null;
    if (activity.contactId) {
      const [row] = await db
        .select({ id: contacts.id, name: contacts.name })
        .from(contacts)
        .where(eq(contacts.id, activity.contactId));
      if (row) contact = row;
    }
    if (activity.accountId) {
      const [row] = await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.id, activity.accountId));
      if (row) account = row;
    }
    if (activity.dealId) {
      const [row] = await db
        .select({ id: deals.id, name: deals.name })
        .from(deals)
        .where(eq(deals.id, activity.dealId));
      if (row) deal = row;
    }
    return {
      id: activity.id,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      ownerId: activity.ownerId,
      contact,
      account,
      deal,
      subject: activity.subject,
      body: activity.body,
      occurredAt: activity.occurredAt,
      direction: activity.direction,
      senderEmail: activity.senderEmail,
      recipientEmails: (activity.recipientEmails ?? []) as string[],
      provider: activity.provider,
      externalId: activity.externalId,
      syncStatus: activity.syncStatus,
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
    };
  }
}
