import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { notificationPreferences } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';

export const NOTIFICATION_CHANNELS = ['inapp', 'email', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Types the preference center knows; unknown types are still storable. */
export const KNOWN_NOTIFICATION_TYPES = [
  'mention',
  'task_digest',
  'lead_assigned',
  'approval_requested',
] as const;

const typePattern = /^[a-z_]{1,60}$/;

@Injectable()
export class NotificationPreferencesService {
  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  async list(auth: AuthContext): Promise<Record<string, string[]>> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db
        .select({ type: notificationPreferences.type, channels: notificationPreferences.channels })
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.orgId, auth.org.id),
            eq(notificationPreferences.userId, auth.user.id),
          ),
        );
      const output: Record<string, string[]> = {};
      for (const row of rows) output[row.type] = [...row.channels];
      return output;
    });
  }

  async set(
    auth: AuthContext,
    input: { type: string; channels: string[] },
  ): Promise<{ type: string; channels: string[] }> {
    if (!typePattern.test(input.type)) {
      throw new BadRequestException({ message: 'Unknown notification type', code: 'UNKNOWN_TYPE' });
    }
    const channels = [...new Set(input.channels)];
    if (
      channels.length === 0 ||
      channels.some((c) => !(NOTIFICATION_CHANNELS as readonly string[]).includes(c))
    ) {
      throw new BadRequestException({
        message: 'Channels must be a non-empty subset of inapp, email, push',
        code: 'INVALID_CHANNELS',
      });
    }
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [row] = await db
        .insert(notificationPreferences)
        .values({ orgId: auth.org.id, userId: auth.user.id, type: input.type, channels })
        .onConflictDoUpdate({
          target: [
            notificationPreferences.orgId,
            notificationPreferences.userId,
            notificationPreferences.type,
          ],
          set: { channels, updatedAt: new Date() },
        })
        .returning();
      if (!row) throw new Error('Preference upsert returned no row');
      return { type: row.type, channels: [...row.channels] };
    });
  }

  /**
   * Same-transaction channel check used by notification producers
   * (mentions, digests). Absent rows mean all channels on.
   */
  async wantsChannel(
    db: NexusDb,
    orgId: string,
    userId: string,
    type: string,
    channel: NotificationChannel,
  ): Promise<boolean> {
    const [row] = await db
      .select({ channels: notificationPreferences.channels })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.orgId, orgId),
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.type, type),
        ),
      );
    if (!row) return true;
    return (row.channels as string[]).includes(channel);
  }

  /** Housekeeping for tests/admin: wipe a user's overrides. */
  async reset(auth: AuthContext): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      await db
        .delete(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.orgId, auth.org.id),
            eq(notificationPreferences.userId, auth.user.id),
          ),
        );
      return { ok: true as const };
    });
  }
}
