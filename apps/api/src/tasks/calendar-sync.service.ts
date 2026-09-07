import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { activities, contacts, type Activity } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { TasksService, type SerializedActivity } from './tasks.service';
import type { SyncEventInput } from './calendar-sync.schemas';

@Injectable()
export class CalendarSyncService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(TasksService) private readonly tasks: TasksService,
  ) {}

  /**
   * Idempotent provider-event ingest keyed by (org, provider, externalId).
   * - Attendee emails matching a CRM contact auto-link contact + account.
   * - Unknown addresses never drop the event (linked contact stays null).
   * - Provider-side deletes flip syncStatus to cancelled, never hard-delete.
   * - Simultaneous edits: most-recent-wins between externalUpdatedAt and
   *   the local updatedAt, with conflictFlag set for the user.
   */
  async syncEvent(
    auth: AuthContext,
    input: SyncEventInput,
  ): Promise<{ activity: SerializedActivity; created: boolean; changed: boolean }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const incomingUpdatedAt = new Date(input.externalUpdatedAt);
      const [existing] = await db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.orgId, auth.org.id),
            eq(activities.provider, input.provider),
            eq(activities.externalId, input.externalId),
          ),
        );

      if (!existing) {
        const links = await this.matchAttendees(db, auth.org.id, input.attendeeEmails);
        const [created] = await db
          .insert(activities)
          .values({
            orgId: auth.org.id,
            ownerId: auth.user.id,
            contactId: links.contactId,
            accountId: links.accountId,
            type: 'meeting',
            subject: input.subject ?? null,
            body: input.body ?? null,
            occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
            provider: input.provider,
            externalId: input.externalId,
            externalUpdatedAt: incomingUpdatedAt,
            syncStatus: input.status,
          })
          .returning();
        if (!created) throw new Error('Calendar sync insert returned no row');
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
            contactId: links.contactId,
          },
        });
        return {
          activity: await this.tasks.serializeActivityById(db, auth, created.id),
          created: true,
          changed: true,
        };
      }

      const baseline = existing.externalUpdatedAt ?? existing.createdAt;
      const providerChanged = incomingUpdatedAt.getTime() > baseline.getTime();
      const localChanged = existing.updatedAt.getTime() > baseline.getTime();
      const links = await this.matchAttendees(db, auth.org.id, input.attendeeEmails);

      if (input.status === 'cancelled' && existing.syncStatus !== 'cancelled') {
        const [updated] = await db
          .update(activities)
          .set({
            syncStatus: 'cancelled',
            externalUpdatedAt: incomingUpdatedAt,
            updatedAt: new Date(),
          })
          .where(eq(activities.id, existing.id))
          .returning();
        if (!updated) throw new Error('Calendar cancel returned no row');
        await this.audit.record(db, {
          orgId: auth.org.id,
          actorUserId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'activity.sync_cancelled',
          entityType: 'activity',
          entityId: existing.id,
        });
        return {
          activity: await this.tasks.serializeActivityById(db, auth, updated.id),
          created: false,
          changed: true,
        };
      }

      if (!providerChanged) {
        return {
          activity: await this.tasks.serializeActivityById(db, auth, existing.id),
          created: false,
          changed: false,
        };
      }

      const conflict = localChanged;
      const providerWins = incomingUpdatedAt.getTime() >= existing.updatedAt.getTime();
      const [updated] = await db
        .update(activities)
        .set({
          ...(providerWins
            ? {
                subject: input.subject ?? existing.subject,
                body: input.body ?? existing.body,
                occurredAt: input.occurredAt ? new Date(input.occurredAt) : existing.occurredAt,
              }
            : {}),
          contactId: links.contactId ?? existing.contactId,
          accountId: links.accountId ?? existing.accountId,
          externalUpdatedAt: incomingUpdatedAt,
          conflictFlag: conflict ? true : existing.conflictFlag,
          updatedAt: new Date(),
        })
        .where(eq(activities.id, existing.id))
        .returning();
      if (!updated) throw new Error('Calendar sync update returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'activity.synced',
        entityType: 'activity',
        entityId: existing.id,
        newValues: { providerWins, conflict },
      });
      return {
        activity: await this.tasks.serializeActivityById(db, auth, updated.id),
        created: false,
        changed: true,
      };
    });
  }

  /**
   * First attendee email matching a live contact wins. Merged losers are
   * skipped in favor of the surviving winner record.
   */
  private async matchAttendees(
    db: NexusDb,
    orgId: string,
    emails: string[],
  ): Promise<{ contactId: string | null; accountId: string | null }> {
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
    return { contactId: null, accountId: null };
  }
}

export type { Activity };
