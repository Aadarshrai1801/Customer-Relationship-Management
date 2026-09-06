import {
  type AppNotification,
  notifications,
} from '@nexus/db';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { TenantDb } from '../database/tenant-db.service';
import type { ListNotificationsQuery } from './notifications.schemas';

@Injectable()
export class NotificationsService {
  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  async createNotification(params: {
    orgId: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    link?: string;
  }): Promise<AppNotification> {
    return this.tenantDb.tx(params.orgId, async (db) => {
      const [created] = await db
        .insert(notifications)
        .values({
          orgId: params.orgId,
          userId: params.userId,
          type: params.type,
          title: params.title,
          body: params.body,
          link: params.link,
        })
        .returning();

      return created!;
    });
  }

  async list(
    orgId: string,
    userId: string,
    query: ListNotificationsQuery,
  ): Promise<{ items: AppNotification[]; unreadCount: number }> {
    return this.tenantDb.tx(orgId, async (db) => {
      const conditions = [eq(notifications.orgId, orgId), eq(notifications.userId, userId)];
      if (query.unreadOnly) {
        conditions.push(isNull(notifications.readAt));
      }

      const items = await db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.createdAt))
        .limit(query.limit ?? 50);

      const [unreadRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(
          and(
            eq(notifications.orgId, orgId),
            eq(notifications.userId, userId),
            isNull(notifications.readAt),
          ),
        );

      return {
        items,
        unreadCount: unreadRow?.count ?? 0,
      };
    });
  }

  async markAsRead(orgId: string, userId: string, id: string): Promise<AppNotification> {
    return this.tenantDb.tx(orgId, async (db) => {
      const [updated] = await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, id),
            eq(notifications.orgId, orgId),
            eq(notifications.userId, userId),
          ),
        )
        .returning();

      if (!updated) {
        throw new NotFoundException({
          code: 'NOTIFICATION_NOT_FOUND',
          message: `Notification ${id} not found`,
        });
      }

      return updated;
    });
  }

  async markAllAsRead(orgId: string, userId: string): Promise<{ count: number }> {
    return this.tenantDb.tx(orgId, async (db) => {
      const result = await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.orgId, orgId),
            eq(notifications.userId, userId),
            isNull(notifications.readAt),
          ),
        )
        .returning();

      return { count: result.length };
    });
  }
}
