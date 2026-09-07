import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { activities, contacts, organizations, type OrganizationSettings } from '@nexus/db';
import { IdentityDb, TenantDb, type NexusDb } from '../database/tenant-db.service';
import { AuditService } from '../audit/audit.service';
import type { InboundEventInput } from './inbound.schemas';

/**
 * Module 14 (PRD 4.9 P1): generic signed inbound webhooks. Third parties
 * POST provider events here; HMAC-SHA256 over the raw body with the org's
 * inboundWebhookSecret authenticates them (no session). activity.logged
 * dedupes on externalId; contact.upserted matches by email.
 */
@Injectable()
export class InboundService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(IdentityDb) private readonly identity: IdentityDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async rotateSecret(orgId: string): Promise<{ secret: string }> {
    const secret = randomUUID().replace(/-/g, '');
    await this.tenantDb.tx(orgId, async (db) => {
      const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
      if (!org) throw new NotFoundException({ message: 'Workspace not found', code: 'ORG_NOT_FOUND' });
      const settings = (org.settings ?? {}) as unknown as Record<string, unknown>;
      const merged: OrganizationSettings = {
        ...settings,
        inboundWebhookSecret: secret,
      } as OrganizationSettings;
      await db
        .update(organizations)
        .set({
          settings: merged,
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, orgId));
    });
    return { secret };
  }

  /**
   * Signature = HMAC-SHA256(secret, exact JSON bytes POSTed). The server
   * re-serializes the parsed body (V8 preserves key order), so clients
   * must sign their compact JSON.stringify output. Documented contract,
   * verified by integration tests on both sides.
   */
  async ingest(
    source: string,
    rawBody: string,
    signature: string | undefined,
    input: InboundEventInput,
  ): Promise<{ ok: true; deduped: boolean; id?: string }> {
    if (!/^[a-z0-9-]{1,40}$/.test(source)) {
      throw new BadRequestException({ message: 'Unknown source', code: 'UNKNOWN_SOURCE' });
    }
    // Resolve org by finding a stored secret match (constant-time compare).
    const orgs = await this.identity.db
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations);
    let orgId: string | null = null;
    for (const org of orgs) {
      const secret = ((org.settings ?? {}) as unknown as Record<string, unknown>)[
        'inboundWebhookSecret'
      ];
      if (typeof secret !== 'string' || !signature) continue;
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      if (signature.length === expected.length) {
        try {
          if (timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
            orgId = org.id;
            break;
          }
        } catch {
          // Length/type mismatch — try next org.
        }
      }
    }
    if (!orgId) {
      throw new UnauthorizedException({ message: 'Invalid webhook signature', code: 'BAD_SIGNATURE' });
    }
    const resolvedOrgId = orgId;
    return this.tenantDb.tx(resolvedOrgId, async (db) => {
      if (input.event === 'activity.logged') {
        return this.ingestActivity(db, resolvedOrgId, source, input);
      }
      return this.ingestContact(db, resolvedOrgId, source, input);
    });
  }

  private async ingestActivity(
    db: NexusDb,
    orgId: string,
    source: string,
    input: InboundEventInput,
  ): Promise<{ ok: true; deduped: boolean; id?: string }> {
    const details = input.activity;
    if (!details) {
      throw new BadRequestException({ message: 'activity payload is required', code: 'MISSING_ACTIVITY' });
    }
    if (input.externalId) {
      const [existing] = await db
        .select({ id: activities.id })
        .from(activities)
        .where(
          and(
            eq(activities.orgId, orgId),
            eq(activities.provider, `inbound-${source}`),
            eq(activities.externalId, input.externalId),
          ),
        );
      if (existing) return { ok: true, deduped: true, id: existing.id };
    }
    let contactId: string | null = null;
    if (details.email) {
      const [contact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, orgId),
            sql`lower(${contacts.email}) = ${details.email!.toLowerCase()}`,
            isNull(contacts.deletedAt),
          ),
        );
      contactId = contact?.id ?? null;
    }
    const [created] = await db
      .insert(activities)
      .values({
        orgId,
        ownerId: null,
        contactId,
        type: details.type === 'note' ? 'meeting' : details.type,
        subject: details.subject ?? null,
        body: details.body ?? null,
        occurredAt: details.occurredAt ? new Date(details.occurredAt) : new Date(),
        provider: `inbound-${source}`,
        externalId: input.externalId ?? null,
      })
      .returning();
    if (!created) throw new Error('Inbound activity insert returned no row');
    await this.audit.record(db, {
      orgId,
      actorUserId: null,
      actorEmail: null,
      action: 'activity.logged',
      entityType: 'contact',
      entityId: contactId ?? created.id,
      newValues: { provider: `inbound-${source}`, activityId: created.id },
    });
    return { ok: true, deduped: false, id: created.id };
  }

  private async ingestContact(
    db: NexusDb,
    orgId: string,
    _source: string,
    input: InboundEventInput,
  ): Promise<{ ok: true; deduped: boolean; id?: string }> {
    void _source;
    const details = input.contact;
    if (!details?.email) {
      throw new BadRequestException({
        message: 'contact.email is required for upsert',
        code: 'MISSING_EMAIL',
      });
    }
    const email = details.email.toLowerCase();
    const [existing] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(eq(contacts.orgId, orgId), sql`lower(${contacts.email}) = ${email}`, isNull(contacts.deletedAt)),
      );
    if (existing) return { ok: true, deduped: true, id: existing.id };
    const [created] = await db
      .insert(contacts)
      .values({
        orgId,
        name: details.name ?? email.split('@')[0]!,
        email,
        phone: details.phone ?? null,
      })
      .returning();
    if (!created) throw new Error('Inbound contact insert returned no row');
    await this.audit.record(db, {
      orgId,
      actorUserId: null,
      actorEmail: null,
      action: 'contact.created',
      entityType: 'contact',
      entityId: created.id,
      newValues: { name: created.name, email: created.email },
    });
    return { ok: true, deduped: false, id: created.id };
  }
}
