import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import {
  activities,
  bookingLinks,
  bookings,
  contacts,
  users,
  type BookingLink,
} from '@nexus/db';
import { TenantDb, IdentityDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import type { BookSlotInput, CreateLinkInput, UpdateLinkInput } from './scheduling.schemas';

/** Working hours model (PRD 4.4 P1): weekdays 9:00–17:00 UTC. */
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 17;

export interface SerializedBookingLink {
  id: string;
  owner: { id: string; name: string } | null;
  name: string;
  slug: string;
  durationMinutes: number;
  description: string | null;
  isActive: boolean;
  publicUrlPath: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TimeSlot {
  startsAt: string;
  endsAt: string;
}

function slugify(name: string): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || `link-${randomUUID().slice(0, 8)}`;
  return /^[a-z0-9]$/.test(base) ? `link-${base}` : base;
}

@Injectable()
export class SchedulingService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(IdentityDb) private readonly identity: IdentityDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createLink(auth: AuthContext, input: CreateLinkInput): Promise<{ link: SerializedBookingLink }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const slug = input.slug ?? slugify(input.name);
      const [clash] = await db
        .select({ id: bookingLinks.id })
        .from(bookingLinks)
        .where(
          and(
            eq(bookingLinks.orgId, auth.org.id),
            eq(bookingLinks.slug, slug),
            isNull(bookingLinks.deletedAt),
          ),
        );
      if (clash) {
        throw new ConflictException({ message: 'Slug is already taken', code: 'SLUG_TAKEN' });
      }
      const [created] = await db
        .insert(bookingLinks)
        .values({
          orgId: auth.org.id,
          ownerId: auth.user.id,
          name: input.name,
          slug,
          durationMinutes: input.durationMinutes,
          description: input.description ?? null,
          isActive: input.isActive,
        })
        .returning();
      if (!created) throw new Error('Booking link insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'booking_link.created',
        entityType: 'booking_link',
        entityId: created.id,
        newValues: { name: created.name, slug: created.slug },
      });
      return { link: await this.serializeLink(db, created) };
    });
  }

  async listLinks(auth: AuthContext): Promise<SerializedBookingLink[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db
        .select()
        .from(bookingLinks)
        .where(and(eq(bookingLinks.orgId, auth.org.id), isNull(bookingLinks.deletedAt)))
        .orderBy(desc(bookingLinks.createdAt));
      return Promise.all(rows.map((row) => this.serializeLink(db, row)));
    });
  }

  async updateLink(
    auth: AuthContext,
    id: string,
    patch: UpdateLinkInput,
  ): Promise<{ link: SerializedBookingLink }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const link = await this.requireLiveLink(db, auth.org.id, id);
      const [updated] = await db
        .update(bookingLinks)
        .set({
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.durationMinutes !== undefined ? { durationMinutes: patch.durationMinutes } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(bookingLinks.id, link.id))
        .returning();
      if (!updated) throw new Error('Booking link update returned no row');
      return { link: await this.serializeLink(db, updated) };
    });
  }

  async removeLink(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const link = await this.requireLiveLink(db, auth.org.id, id);
      await db.update(bookingLinks).set({ deletedAt: new Date() }).where(eq(bookingLinks.id, link.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'booking_link.deleted',
        entityType: 'booking_link',
        entityId: link.id,
        oldValues: { name: link.name },
      });
      return { ok: true as const };
    });
  }

  /** Public availability: next 14 days of weekday slots minus bookings. */
  async availability(slug: string, orgId: string): Promise<{ link: SerializedBookingLink; slots: TimeSlot[] }> {
    const link = await this.resolvePublicLink(orgId, slug);
    const slots = await this.tenantDb.tx(orgId, async (db) => {
      return this.computeSlots(db, orgId, link);
    });
    return { link: await this.serializePublicLink(link), slots };
  }

  /**
   * Public booking: match-or-create the contact by email, log a meeting
   * activity, and hold the slot. Double-booking races resolve via the
   * overlap check inside the transaction.
   */
  async book(
    slug: string,
    orgId: string,
    input: BookSlotInput,
  ): Promise<{ booking: Record<string, unknown> }> {
    const link = await this.resolvePublicLink(orgId, slug);
    return this.tenantDb.tx(orgId, async (db) => {
      const startsAt = new Date(input.startsAt);
      if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now() - 60000) {
        throw new BadRequestException({ message: 'Slot must start in the future', code: 'SLOT_PAST' });
      }
      const endsAt = new Date(startsAt.getTime() + link.durationMinutes * 60000);
      const slots = await this.computeSlots(db, orgId, link);
      if (!slots.some((s) => s.startsAt === startsAt.toISOString())) {
        throw new ConflictException({ message: 'Slot is no longer available', code: 'SLOT_TAKEN' });
      }
      const email = input.email.toLowerCase();
      const [existingContact] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.orgId, orgId),
            sql`lower(${contacts.email}) = ${email}`,
            isNull(contacts.deletedAt),
          ),
        );
      let contactId: string | null = existingContact?.id ?? null;
      if (!contactId) {
        const [created] = await db
          .insert(contacts)
          .values({ orgId, ownerId: link.ownerId, name: input.name, email })
          .returning();
        if (!created) throw new Error('Contact insert returned no row');
        contactId = created.id;
      }
      const [booking] = await db
        .insert(bookings)
        .values({
          orgId,
          linkId: link.id,
          contactId,
          name: input.name,
          email,
          startsAt,
          endsAt,
          status: 'scheduled',
          notes: input.notes ?? null,
        })
        .returning();
      if (!booking) throw new Error('Booking insert returned no row');
      await db.insert(activities).values({
        orgId,
        ownerId: link.ownerId,
        contactId,
        type: 'meeting',
        subject: `Booked: ${link.name}`,
        body: input.notes ?? null,
        occurredAt: startsAt,
        provider: 'nexus-booking',
        externalId: booking.id,
      });
      await this.audit.record(db, {
        orgId,
        actorUserId: null,
        actorEmail: email,
        action: 'booking.created',
        entityType: 'booking',
        entityId: booking.id,
        newValues: { linkId: link.id, startsAt: startsAt.toISOString() },
      });
      return {
        booking: {
          id: booking.id,
          name: booking.name,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
          status: booking.status,
        },
      };
    });
  }

  private async resolvePublicLink(orgId: string, slug: string): Promise<BookingLink> {
    const [link] = await this.identity.db
      .select()
      .from(bookingLinks)
      .where(and(eq(bookingLinks.orgId, orgId), eq(bookingLinks.slug, slug)));
    // IdentityDb bypasses RLS; re-assert org match + liveness explicitly.
    if (!link || link.orgId !== orgId || link.deletedAt || !link.isActive) {
      throw new NotFoundException({ message: 'Booking link not found', code: 'LINK_NOT_FOUND' });
    }
    return link;
  }

  /** Public reads carry orgId from the caller (slug namespace is per-org). */
  async resolveOrgForSlug(slug: string): Promise<string> {
    const rows = await this.identity.db
      .select({ orgId: bookingLinks.orgId })
      .from(bookingLinks)
      .where(and(eq(bookingLinks.slug, slug), eq(bookingLinks.isActive, true), isNull(bookingLinks.deletedAt)));
    if (rows.length !== 1) {
      throw new NotFoundException({ message: 'Booking link not found', code: 'LINK_NOT_FOUND' });
    }
    return (rows[0] as { orgId: string }).orgId;
  }

  private async computeSlots(db: NexusDb, orgId: string, link: BookingLink): Promise<TimeSlot[]> {
    const horizon = new Date(Date.now() + 14 * 86400000);
    const taken = await db
      .select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt })
      .from(bookings)
      .where(
        and(
          eq(bookings.orgId, orgId),
          eq(bookings.linkId, link.id),
          eq(bookings.status, 'scheduled'),
          gte(bookings.startsAt, new Date()),
          lt(bookings.startsAt, horizon),
        ),
      );
    const slots: TimeSlot[] = [];
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    for (let d = 0; d < 14 && slots.length < 60; d += 1) {
      const date = new Date(day.getTime() + d * 86400000);
      const weekday = date.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      for (let h = WORK_START_HOUR; h + link.durationMinutes / 60 <= WORK_END_HOUR; h += 1) {
        const start = new Date(date);
        start.setUTCHours(h, 0, 0, 0);
        if (start.getTime() < Date.now() + 15 * 60000) continue;
        const end = new Date(start.getTime() + link.durationMinutes * 60000);
        const overlaps = taken.some((b) => start < b.endsAt && end > b.startsAt);
        if (!overlaps) {
          slots.push({ startsAt: start.toISOString(), endsAt: end.toISOString() });
        }
        if (slots.length >= 60) break;
      }
    }
    return slots;
  }

  private async requireLiveLink(db: NexusDb, orgId: string, id: string): Promise<BookingLink> {
    const [row] = await db
      .select()
      .from(bookingLinks)
      .where(and(eq(bookingLinks.id, id), eq(bookingLinks.orgId, orgId), isNull(bookingLinks.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Booking link not found', code: 'LINK_NOT_FOUND' });
    }
    return row;
  }

  private async serializeLink(db: NexusDb, link: BookingLink): Promise<SerializedBookingLink> {
    const [owner] = link.ownerId
      ? await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, link.ownerId))
      : [undefined];
    return {
      id: link.id,
      owner: owner ?? null,
      name: link.name,
      slug: link.slug,
      durationMinutes: link.durationMinutes,
      description: link.description,
      isActive: link.isActive,
      publicUrlPath: `/book/${link.slug}`,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    };
  }

  private async serializePublicLink(link: BookingLink): Promise<SerializedBookingLink> {
    return {
      id: link.id,
      owner: null,
      name: link.name,
      slug: link.slug,
      durationMinutes: link.durationMinutes,
      description: link.description,
      isActive: link.isActive,
      publicUrlPath: `/book/${link.slug}`,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    };
  }
}
