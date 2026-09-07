import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { products } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService, diffObjects } from '../audit/audit.service';
import type { CreateProductInput, UpdateProductInput } from './products.schemas';

function productNotFound(): never {
  throw new NotFoundException({ message: 'Product not found', code: 'PRODUCT_NOT_FOUND' });
}

@Injectable()
export class ProductsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Shared org catalog: route-level deals:read/manage scopes gate access,
   * mirroring the pipelines list (no per-record ownership on catalog rows).
   */
  async list(auth: AuthContext): Promise<Array<typeof products.$inferSelect>> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return db
        .select()
        .from(products)
        .where(eq(products.orgId, auth.org.id))
        .orderBy(asc(products.name), asc(products.id));
    });
  }

  async create(
    auth: AuthContext,
    input: CreateProductInput,
  ): Promise<{ product: typeof products.$inferSelect }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const [created] = await db
        .insert(products)
        .values({
          orgId: auth.org.id,
          name: input.name,
          sku: input.sku ?? null,
          unitPrice: String(input.unitPrice),
          currency: input.currency,
          taxRate: String(input.taxRate),
          isActive: input.isActive,
        })
        .returning();
      if (!created) throw new Error('Product insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'product.created',
        entityType: 'product',
        entityId: created.id,
        newValues: { name: created.name, unitPrice: created.unitPrice },
      });
      return { product: created };
    });
  }

  async update(
    auth: AuthContext,
    id: string,
    patch: UpdateProductInput,
  ): Promise<{ product: typeof products.$inferSelect }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireOrgProduct(db, auth.org.id, id);
      const [updated] = await db
        .update(products)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
          ...(patch.unitPrice !== undefined ? { unitPrice: String(patch.unitPrice) } : {}),
          ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
          ...(patch.taxRate !== undefined ? { taxRate: String(patch.taxRate) } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(products.id, row.id))
        .returning();
      if (!updated) throw new Error('Product update returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'product.updated',
        entityType: 'product',
        entityId: updated.id,
        oldValues: diffObjects(
          { name: row.name, unitPrice: row.unitPrice },
          { name: updated.name, unitPrice: updated.unitPrice },
        ).oldValues,
        newValues: { name: updated.name, unitPrice: updated.unitPrice },
      });
      return { product: updated };
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireOrgProduct(db, auth.org.id, id);
      await db.delete(products).where(eq(products.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'product.deleted',
        entityType: 'product',
        entityId: row.id,
        oldValues: { name: row.name, unitPrice: row.unitPrice },
      });
      return { ok: true as const };
    });
  }

  private async requireOrgProduct(db: NexusDb, orgId: string, id: string) {
    const [row] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, id), eq(products.orgId, orgId)));
    if (!row) productNotFound();
    return row;
  }
}
