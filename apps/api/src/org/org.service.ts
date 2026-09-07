import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { organizations, ssoConfigs, type OrganizationSettings } from '@nexus/db';
import { TenantDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService, diffObjects } from '../audit/audit.service';
import type { UpdateSecurityInput, UpdateSettingsInput } from './org.schemas';

@Injectable()
export class OrgService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

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
      if (input.ssoOnly === true) {
        // Enabling SSO-only without an enabled provider would lock everyone
        // out (including the admin flipping the switch).
        const [enabled] = await db
          .select({ id: ssoConfigs.id })
          .from(ssoConfigs)
          .where(and(eq(ssoConfigs.orgId, org.id), eq(ssoConfigs.enabled, true)));
        if (!enabled) {
          throw new ConflictException({
            message: 'Enable at least one sign-on provider before enforcing SSO-only',
            code: 'SSO_ONLY_NO_PROVIDER',
          });
        }
      }
      const [next] = await db
        .update(organizations)
        .set({
          securitySettings: {
            ...org.securitySettings,
            ...(input.twoFactorPolicy ? { twoFactorPolicy: input.twoFactorPolicy } : {}),
            ...(input.ssoOnly !== undefined ? { ssoOnly: input.ssoOnly } : {}),
          },
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, org.id))
        .returning();
      if (next) {
        const { oldValues, newValues } = diffObjects(
          {
            twoFactorPolicy: org.securitySettings.twoFactorPolicy,
            ssoOnly: org.securitySettings.ssoOnly,
          },
          {
            twoFactorPolicy: next.securitySettings.twoFactorPolicy,
            ssoOnly: next.securitySettings.ssoOnly,
          },
        );
        if (Object.keys(newValues).length > 0) {
          await this.audit.record(db, {
            orgId: org.id,
            actorUserId: auth.user.id,
            actorEmail: auth.user.email,
            action: 'org.security_updated',
            entityType: 'organization',
            entityId: org.id,
            oldValues,
            newValues,
          });
        }
      }
      return next;
    });
    if (!updated) throw new Error('Failed to update workspace');
    return { id: updated.id, securitySettings: updated.securitySettings };
  }

  /**
   * Module 8 (PRD 4.13): configurable attachment caps live in the generic
   * org settings jsonb so no migration is needed for future caps.
   */
  async updateSettings(auth: AuthContext, input: UpdateSettingsInput): Promise<unknown> {
    const [updated] = await this.tenantDb.tx(auth.org.id, async (db) => {
      const [org] = await db.select().from(organizations).where(eq(organizations.id, auth.org.id));
      if (!org) {
        throw new NotFoundException({ message: 'Workspace not found', code: 'ORG_NOT_FOUND' });
      }
      const nextSettings: OrganizationSettings = {
        ...(org.settings as OrganizationSettings),
        ...(input.maxAttachmentBytes !== undefined
          ? { maxAttachmentBytes: input.maxAttachmentBytes }
          : {}),
        ...(input.attachmentStorageCapBytes !== undefined
          ? { attachmentStorageCapBytes: input.attachmentStorageCapBytes }
          : {}),
      };
      const [next] = await db
        .update(organizations)
        .set({ settings: nextSettings, updatedAt: new Date() })
        .where(eq(organizations.id, org.id))
        .returning();
      if (!next) throw new Error('Failed to update workspace');
      const { oldValues, newValues } = diffObjects(
        {
          maxAttachmentBytes: (org.settings as OrganizationSettings).maxAttachmentBytes,
          attachmentStorageCapBytes: (org.settings as OrganizationSettings)
            .attachmentStorageCapBytes,
        },
        {
          maxAttachmentBytes: nextSettings.maxAttachmentBytes,
          attachmentStorageCapBytes: nextSettings.attachmentStorageCapBytes,
        },
      );
      if (Object.keys(newValues).length > 0) {
        await this.audit.record(db, {
          orgId: org.id,
          actorUserId: auth.user.id,
          actorEmail: auth.user.email,
          action: 'org.settings_updated',
          entityType: 'organization',
          entityId: org.id,
          oldValues,
          newValues,
        });
      }
      return [next];
    });
    if (!updated) throw new Error('Failed to update workspace');
    return { id: updated.id, settings: updated.settings };
  }
}
