import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { auditLogEntries, activities, contactMerges, contactNotes, users } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { ContactsService } from '../contacts/contacts.service';

export interface TimelineItem {
  id: string;
  type:
    | 'contact_created'
    | 'contact_updated'
    | 'contact_deleted'
    | 'contact_merged'
    | 'note_added'
    | 'activity_logged';
  occurredAt: Date;
  actor: { id: string | null; email: string | null };
  summary: string;
  data: Record<string, unknown>;
}

interface RawItem extends TimelineItem {
  sortKey: string;
}

const TIMELINE_ACTIONS = [
  'contact.created',
  'contact.updated',
  'contact.deleted',
  'contact.merged',
] as const;

const ACTION_TO_TYPE: Record<(typeof TIMELINE_ACTIONS)[number], TimelineItem['type']> = {
  'contact.created': 'contact_created',
  'contact.updated': 'contact_updated',
  'contact.deleted': 'contact_deleted',
  'contact.merged': 'contact_merged',
};

function summarize(action: string, oldValues: unknown, newValues: unknown): string {
  if (action === 'contact.created') return 'Contact created';
  if (action === 'contact.deleted') return 'Contact deleted';
  if (action === 'contact.merged') {
    const loser = (newValues as { loserEmail?: string } | null)?.loserEmail;
    return loser ? `Merged duplicate contact ${loser}` : 'Merged a duplicate contact';
  }
  if (action === 'contact.updated') {
    const keys = Object.keys((newValues ?? {}) as Record<string, unknown>).filter(
      (k) => k !== 'customFields',
    );
    const custom = (newValues as { customFields?: Record<string, unknown> } | null)?.customFields;
    if (custom && Object.keys(custom).length > 0) keys.push('custom fields');
    return keys.length > 0 ? `Updated ${keys.join(', ')}` : 'Contact updated';
  }
  return action;
}

function parseCursor(cursor: string): { time: Date; uid: string } | null {
  const sep = cursor.lastIndexOf('|');
  if (sep < 0) return null;
  const time = new Date(cursor.slice(0, sep));
  const uid = cursor.slice(sep + 1);
  if (Number.isNaN(time.getTime()) || !uid) return null;
  return { time, uid };
}

@Injectable()
export class TimelineService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(ContactsService) private readonly contacts: ContactsService,
  ) {}

  async getTimeline(
    auth: AuthContext,
    contactId: string,
    options: { limit?: number; cursor?: string },
  ): Promise<{ items: TimelineItem[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.contacts.requireLiveContact(db, auth.org.id, contactId);
      this.contacts.assertContactReadable(auth, row.contact.ownerId);
      const contactIds = await this.mergedFamily(db, auth.org.id, row.contact.id);

      let cursor: { time: Date; uid: string } | null = null;
      if (options.cursor) {
        cursor = parseCursor(options.cursor);
        if (!cursor) {
          throw new BadRequestException({
            message: 'Invalid pagination cursor',
            code: 'INVALID_CURSOR',
          });
        }
      }

      const auditRows = await db
        .select()
        .from(auditLogEntries)
        .where(
          and(
            eq(auditLogEntries.orgId, auth.org.id),
            eq(auditLogEntries.entityType, 'contact'),
            sql`${auditLogEntries.entityId} IN (${sql.join(
              contactIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
            sql`${auditLogEntries.action} IN (${sql.join(
              TIMELINE_ACTIONS.map((a) => sql`${a}`),
              sql`, `,
            )})`,
          ),
        )
        .orderBy(desc(auditLogEntries.createdAt), desc(auditLogEntries.id));

      const noteRows = await db
        .select({ note: contactNotes, author: users })
        .from(contactNotes)
        .leftJoin(users, eq(contactNotes.authorId, users.id))
        .where(
          and(
            eq(contactNotes.orgId, auth.org.id),
            sql`${contactNotes.contactId} IN (${sql.join(
              contactIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
        .orderBy(desc(contactNotes.createdAt), desc(contactNotes.id));

      // Module 5: unified activity log (calls, meetings, emails, task
      // completions, synced calendar events) merged into the same feed.
      const activityRows = await db
        .select({ activity: activities, owner: users })
        .from(activities)
        .leftJoin(users, eq(activities.ownerId, users.id))
        .where(
          and(
            eq(activities.orgId, auth.org.id),
            sql`${activities.contactId} IN (${sql.join(
              contactIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
        .orderBy(desc(activities.occurredAt), desc(activities.id));

      const items: RawItem[] = [
        ...auditRows.map((a) => ({
          id: `a${a.id}`,
          type: ACTION_TO_TYPE[a.action as (typeof TIMELINE_ACTIONS)[number]] ?? 'contact_updated',
          occurredAt: a.createdAt,
          actor: { id: a.actorUserId, email: a.actorEmail },
          summary: summarize(
            a.action,
            a.oldValues as Record<string, unknown>,
            a.newValues as Record<string, unknown>,
          ),
          data: {
            oldValues: a.oldValues,
            newValues: a.newValues,
            viaMerge: a.entityId !== row.contact.id,
          },
          sortKey: '',
        })),
        ...noteRows.map((n) => ({
          id: `n${n.note.id}`,
          type: 'note_added' as const,
          occurredAt: n.note.createdAt,
          actor: n.author ? { id: n.author.id, email: null } : { id: null, email: null },
          summary: `Note by ${n.author?.name ?? 'unknown'}`,
          data: {
            noteId: n.note.id,
            body: n.note.body,
            authorName: n.author?.name ?? null,
            viaMerge: n.note.contactId !== row.contact.id,
          },
          sortKey: '',
        })),
        ...activityRows.map((a) => ({
          id: `e${a.activity.id}`,
          type: 'activity_logged' as const,
          occurredAt: a.activity.occurredAt,
          actor: a.owner ? { id: a.owner.id, email: a.owner.email } : { id: null, email: null },
          summary: `Logged ${a.activity.type}: ${a.activity.subject ?? '(no subject)'}`,
          data: {
            activityId: a.activity.id,
            activityType: a.activity.type,
            subject: a.activity.subject,
            body: a.activity.body,
            provider: a.activity.provider,
            syncStatus: a.activity.syncStatus,
            conflictFlag: a.activity.conflictFlag,
            viaMerge: a.activity.contactId !== row.contact.id,
          },
          sortKey: '',
        })),
      ];
      for (const item of items) {
        item.sortKey = `${item.occurredAt.toISOString()}|${item.id}`;
      }
      items.sort((a, b) => (a.sortKey < b.sortKey ? 1 : -1));

      const visible = cursor ? items.filter((i) => i.sortKey < cursorKey(cursor)) : items;
      const page = visible.slice(0, limit);
      const nextCursor =
        visible.length > limit
          ? `${page[page.length - 1]!.occurredAt.toISOString()}|${page[page.length - 1]!.id}`
          : null;
      return {
        items: page.map(({ sortKey: _ignored, ...item }) => item),
        nextCursor,
      };
    });
  }

  /** Winner plus every contact merged into it (merge history stays visible). */
  private async mergedFamily(db: NexusDb, orgId: string, winnerId: string): Promise<string[]> {
    const merges = await db
      .select({ loserId: contactMerges.loserId })
      .from(contactMerges)
      .where(and(eq(contactMerges.orgId, orgId), eq(contactMerges.winnerId, winnerId)));
    return [winnerId, ...merges.map((m) => m.loserId)];
  }
}

function cursorKey(cursor: { time: Date; uid: string }): string {
  return `${cursor.time.toISOString()}|${cursor.uid}`;
}
