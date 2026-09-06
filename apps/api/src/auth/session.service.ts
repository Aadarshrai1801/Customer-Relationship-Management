import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import {
  DEFAULT_ORGANIZATION_SECURITY_SETTINGS,
  organizations,
  roles,
  sessions,
  twoFactor,
  users,
  type OrganizationSecuritySettings,
} from '@nexus/db';
import { IdentityDb, TenantDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { generateToken, hashToken } from './tokens';

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

function ttlDays(settings: OrganizationSecuritySettings | null | undefined): number {
  return settings?.sessionTtlDays ?? DEFAULT_ORGANIZATION_SECURITY_SETTINGS.sessionTtlDays;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(IdentityDb) private readonly identityDb: IdentityDb,
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
  ) {}

  async createSession(input: {
    userId: string;
    orgId: string;
    ipAddress?: string;
    userAgent?: string;
    twoFactorVerified?: boolean;
    ttlDaysOverride?: number;
  }): Promise<CreatedSession> {
    const token = generateToken();
    const days = input.ttlDaysOverride ?? DEFAULT_ORGANIZATION_SECURITY_SETTINGS.sessionTtlDays;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const [row] = await this.tenantDb.tx(input.orgId, (db) =>
      db
        .insert(sessions)
        .values({
          orgId: input.orgId,
          userId: input.userId,
          tokenHash: hashToken(token),
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          twoFactorVerified: input.twoFactorVerified ?? true,
          expiresAt,
        })
        .returning({ id: sessions.id, expiresAt: sessions.expiresAt }),
    );
    if (!row) throw new Error('Failed to create session');
    return { token, sessionId: row.id, expiresAt: row.expiresAt };
  }

  /**
   * Resolves a session cookie token to an AuthContext. Reads the session row
   * via the auth pool (tenant unknown pre-auth), then validates user/org/role
   * through the tenant-scoped pool so RLS still applies to entity reads.
   */
  async validate(token: string | undefined): Promise<AuthContext | null> {
    if (!token) return null;
    const [session] = await this.identityDb.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)));
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;

    const context = await this.tenantDb.tx(session.orgId, async (db) => {
      const [user] = await db.select().from(users).where(eq(users.id, session.userId));
      if (!user || user.status === 'suspended') return null;
      const [org] = await db.select().from(organizations).where(eq(organizations.id, user.orgId));
      const [role] = await db.select().from(roles).where(eq(roles.id, user.roleId));
      if (!org || !role) return null;
      const [tfa] = await db.select().from(twoFactor).where(eq(twoFactor.userId, user.id));
      return {
        sessionId: session.id,
        twoFactorVerified: session.twoFactorVerified,
        twoFactorEnrolled: !!tfa?.enabledAt,
        user: {
          id: user.id,
          orgId: user.orgId,
          email: user.email,
          name: user.name,
          status: user.status,
          roleId: user.roleId,
        },
        role: { id: role.id, key: role.key, name: role.name, permissions: role.permissions },
        org: { id: org.id, name: org.name, slug: org.slug },
        sessionMeta: {
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          sessionTtlDays: ttlDays(org.securitySettings),
        },
      };
    });
    if (!context) return null;

    await this.maybeExtend(session, context.sessionMeta);
    return {
      sessionId: context.sessionId,
      twoFactorVerified: context.twoFactorVerified,
      user: { ...context.user, twoFactorEnrolled: context.twoFactorEnrolled },
      role: {
        id: context.role.id,
        key: context.role.key,
        name: context.role.name,
        permissions: context.role.permissions,
      },
      org: context.org,
    };
  }

  async revokeSession(sessionId: string, orgId: string): Promise<void> {
    await this.tenantDb.tx(orgId, (db) =>
      db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt))),
    );
  }

  async revokeAllUserSessions(userId: string, orgId: string): Promise<void> {
    await this.tenantDb.tx(orgId, (db) =>
      db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))),
    );
  }

  private async maybeExtend(
    session: { id: string; orgId: string; createdAt: Date; expiresAt: Date },
    meta: { sessionTtlDays: number },
  ): Promise<void> {
    const now = Date.now();
    const ttlMs = meta.sessionTtlDays * 24 * 60 * 60 * 1000;
    if (now - session.createdAt.getTime() > 2 * ttlMs) return;
    if (session.expiresAt.getTime() - now > ttlMs / 2) return;
    const expiresAt = new Date(now + ttlMs);
    await this.tenantDb.tx(session.orgId, (db) =>
      db
        .update(sessions)
        .set({ expiresAt, lastSeenAt: new Date() })
        .where(eq(sessions.id, session.id)),
    );
  }
}
