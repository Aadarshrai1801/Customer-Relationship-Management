import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { competitors, deals } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';

export interface CompetitorWithStats {
  id: string;
  name: string;
  openDeals: number;
  wonDeals: number;
  lostDeals: number;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class CompetitorsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext): Promise<CompetitorWithStats[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db
        .select()
        .from(competitors)
        .where(and(eq(competitors.orgId, auth.org.id), isNull(competitors.deletedAt)))
        .orderBy(asc(competitors.name), asc(competitors.id));
      const canSeeAll = (auth.role.permissions?.recordAccess?.['deal'] ?? 'own') === 'all';
      return Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          name: row.name,
          ...(await this.dealCounts(db, auth, row.id, canSeeAll)),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      );
    });
  }

  async create(
    auth: AuthContext,
    name: string,
  ): Promise<{ competitor: typeof competitors.$inferSelect }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const trimmed = name.trim();
      const [existing] = await db
        .select()
        .from(competitors)
        .where(and(eq(competitors.orgId, auth.org.id), eq(competitors.name, trimmed)));
      if (existing && !existing.deletedAt) {
        throw new ConflictException({
          message: 'A competitor with this name already exists',
          code: 'COMPETITOR_NAME_TAKEN',
        });
      }
      if (existing) {
        const [restored] = await db
          .update(competitors)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(eq(competitors.id, existing.id))
          .returning();
        if (!restored) throw new Error('Competitor restore returned no row');
        return { competitor: restored };
      }
      const [created] = await db
        .insert(competitors)
        .values({ orgId: auth.org.id, name: trimmed })
        .returning();
      if (!created) throw new Error('Competitor insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'competitor.created',
        entityType: 'competitor',
        entityId: created.id,
        newValues: { name: created.name },
      });
      return { competitor: created };
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [row] = await db
        .select()
        .from(competitors)
        .where(
          and(
            eq(competitors.id, id),
            eq(competitors.orgId, auth.org.id),
            isNull(competitors.deletedAt),
          ),
        );
      if (!row) {
        throw new NotFoundException({
          message: 'Competitor not found',
          code: 'COMPETITOR_NOT_FOUND',
        });
      }
      await db.update(competitors).set({ deletedAt: new Date() }).where(eq(competitors.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'competitor.deleted',
        entityType: 'competitor',
        entityId: row.id,
        oldValues: { name: row.name },
      });
      return { ok: true as const };
    });
  }

  private async dealCounts(
    db: NexusDb,
    auth: AuthContext,
    competitorId: string,
    canSeeAll: boolean,
  ): Promise<{ openDeals: number; wonDeals: number; lostDeals: number }> {
    const rows = await db
      .select({ status: deals.status, count: sql<number>`count(*)::int` })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, auth.org.id),
          eq(deals.competitorId, competitorId),
          isNull(deals.deletedAt),
          ...(canSeeAll ? [] : [eq(deals.ownerId, auth.user.id)]),
        ),
      )
      .groupBy(deals.status);
    const byStatus = new Map(rows.map((r) => [r.status, r.count]));
    return {
      openDeals: byStatus.get('open') ?? 0,
      wonDeals: byStatus.get('won') ?? 0,
      lostDeals: byStatus.get('lost') ?? 0,
    };
  }
}
