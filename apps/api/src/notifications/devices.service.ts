import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { devices } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PUSH_PROVIDER, type PushProvider } from './push.provider';

const tokenPattern = /^[A-Za-z0-9:_-]{8,512}$/;

@Injectable()
export class DevicesService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    @Inject(NotificationPreferencesService) private readonly preferences: NotificationPreferencesService,
  ) {}

  async register(
    auth: AuthContext,
    input: { token: string; platform?: string },
  ): Promise<{ device: { id: string } }> {
    if (!tokenPattern.test(input.token)) {
      throw new BadRequestException({ message: 'Invalid device token', code: 'INVALID_TOKEN' });
    }
    if (input.platform !== undefined && !['web', 'ios', 'android'].includes(input.platform)) {
      throw new BadRequestException({ message: 'Unknown platform', code: 'INVALID_PLATFORM' });
    }
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [existing] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.orgId, auth.org.id), eq(devices.token, input.token)));
      if (existing) return { device: { id: existing.id } };
      const [created] = await db
        .insert(devices)
        .values({
          orgId: auth.org.id,
          userId: auth.user.id,
          token: input.token,
          platform: input.platform ?? 'web',
        })
        .returning();
      if (!created) throw new Error('Device insert returned no row');
      return { device: { id: created.id } };
    });
  }

  async list(auth: AuthContext): Promise<Array<{ id: string; platform: string; createdAt: Date }>> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return db
        .select({ id: devices.id, platform: devices.platform, createdAt: devices.createdAt })
        .from(devices)
        .where(and(eq(devices.orgId, auth.org.id), eq(devices.userId, auth.user.id)));
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [row] = await db
        .select({ id: devices.id })
        .from(devices)
        .where(
          and(eq(devices.id, id), eq(devices.orgId, auth.org.id), eq(devices.userId, auth.user.id)),
        );
      if (!row) {
        throw new NotFoundException({ message: 'Device not found', code: 'DEVICE_NOT_FOUND' });
      }
      await db.delete(devices).where(eq(devices.id, row.id));
      return { ok: true as const };
    });
  }

  /** Best-effort fan-out used by mention/digest flows honoring push prefs. */
  async pushToUser(
    db: NexusDb,
    orgId: string,
    userId: string,
    title: string,
    body: string,
  ): Promise<number> {
    const rows = await db
      .select({ token: devices.token })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.userId, userId)));
    let sent = 0;
    for (const row of rows) {
      try {
        await this.push.send({ token: row.token, title, body });
        sent += 1;
      } catch {
        // Per-device failure must not break the batch.
      }
    }
    return sent;
  }

  /** Self-contained variant for post-commit fan-out (own transaction). */
  async pushToUserId(
    orgId: string,
    userId: string,
    type: string,
    title: string,
    body: string,
  ): Promise<number> {
    return this.tenantDb.tx(orgId, async (db) => {
      if (!(await this.preferences.wantsChannel(db, orgId, userId, type, 'push'))) return 0;
      return this.pushToUser(db, orgId, userId, title, body);
    });
  }
}
