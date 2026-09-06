import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { organizations } from '@nexus/db';
import { TenantDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import type { UpdateSecurityInput } from './org.schemas';

@Injectable()
export class OrgService {
  constructor(@Inject(TenantDb) private readonly tenantDb: TenantDb) {}

  async get(auth: AuthContext): Promise<unknown> {
    const [org] = await this.tenantDb.tx(auth.org.id, (db) =>
      db.select().from(organizations).where(eq(organizations.id, auth.org.id)),
    );
    if (!org)
      throw new NotFoundException({ message: 'Workspace not found', code: 'ORG_NOT_FOUND' });
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      planTier: org.planTier,
      settings: org.settings,
      securitySettings: org.securitySettings,
    };
  }

  async updateSecurity(auth: AuthContext, input: UpdateSecurityInput): Promise<unknown> {
    const updated = await this.tenantDb.tx(auth.org.id, async (db) => {
      const [org] = await db.select().from(organizations).where(eq(organizations.id, auth.org.id));
      if (!org) {
        throw new NotFoundException({ message: 'Workspace not found', code: 'ORG_NOT_FOUND' });
      }
      const [next] = await db
        .update(organizations)
        .set({
          securitySettings: { ...org.securitySettings, twoFactorPolicy: input.twoFactorPolicy },
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, org.id))
        .returning();
      return next;
    });
    if (!updated) throw new Error('Failed to update workspace');
    return { id: updated.id, securitySettings: updated.securitySettings };
  }
}
