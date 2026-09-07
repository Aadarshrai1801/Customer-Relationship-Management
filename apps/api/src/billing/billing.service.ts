import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { invoices, organizations, subscriptions, users, type Subscription } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { BILLING_PROVIDER, type BillingProvider } from './billing.provider';
import type { ApplySeatsInput, PreviewSeatsInput } from './billing.schemas';

/** Per-seat monthly prices (USD). Trial is free; changes take effect inline. */
export const PLAN_UNIT_PRICES: Record<string, number> = {
  trial: 0,
  starter: 15,
  growth: 30,
  enterprise: 60,
};

export const BILLING_CYCLE_DAYS = 30;
export const BILLING_CURRENCY = 'USD';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function invoiceNumber(): string {
  return `INV-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export interface SeatPreview {
  plan: string;
  previousPlan: string;
  seats: number;
  previousSeats: number;
  seatDelta: number;
  unitPrice: number;
  currency: string;
  daysRemainingInCycle: number;
  proratedCharge: number;
  newMrr: number;
}

@Injectable()
export class BillingService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  async getSubscription(auth: AuthContext): Promise<Record<string, unknown>> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const sub = await this.ensureSubscription(db, auth);
      return this.serializeSubscription(db, auth.org.id, sub);
    });
  }

  /**
   * Prorated preview shown BEFORE confirmation (PRD 4.15: no surprise
   * charges). Added seats bill at the new plan rate for the days left in
   * the cycle; plan uplifts apply to kept seats; removals credit (never
   * invoiced — only positive nets produce an invoice on apply).
   */
  async previewSeats(auth: AuthContext, input: PreviewSeatsInput): Promise<SeatPreview> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const sub = await this.ensureSubscription(db, auth);
      return this.buildPreview(db, auth.org.id, sub, input);
    });
  }

  async applySeats(
    auth: AuthContext,
    input: ApplySeatsInput,
  ): Promise<{ subscription: Record<string, unknown>; invoice: unknown | null; charged: number }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const sub = await this.ensureSubscription(db, auth);
      const preview = await this.buildPreview(db, auth.org.id, sub, input);
      const [updated] = await db
        .update(subscriptions)
        .set({ plan: preview.plan, seats: preview.seats, updatedAt: new Date() })
        .where(eq(subscriptions.id, sub.id))
        .returning();
      if (!updated) throw new Error('Subscription update returned no row');
      let invoice: unknown | null = null;
      let charged = 0;
      if (preview.proratedCharge > 0) {
        const { transactionId } = await this.provider.charge({
          orgId: auth.org.id,
          amount: preview.proratedCharge,
          currency: preview.currency,
          description: `Nexus ${preview.plan} — ${preview.seats} seats`,
        });
        const now = new Date();
        const [created] = await db
          .insert(invoices)
          .values({
            orgId: auth.org.id,
            number: invoiceNumber(),
            amount: String(preview.proratedCharge),
            currency: preview.currency,
            status: 'paid',
            periodStart: now,
            periodEnd: new Date(now.getTime() + BILLING_CYCLE_DAYS * 86400000),
            lines: [
              {
                kind: 'seat_change',
                previousPlan: preview.previousPlan,
                plan: preview.plan,
                previousSeats: preview.previousSeats,
                seats: preview.seats,
                unitPrice: preview.unitPrice,
                daysRemaining: preview.daysRemainingInCycle,
                amount: preview.proratedCharge,
              },
            ],
            providerRef: `${this.provider.name}:${transactionId}`,
          })
          .returning();
        if (!created) throw new Error('Invoice insert returned no row');
        invoice = created;
        charged = preview.proratedCharge;
      }
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'subscription.updated',
        entityType: 'subscription',
        entityId: updated.id,
        oldValues: { plan: sub.plan, seats: sub.seats },
        newValues: {
          plan: updated.plan,
          seats: updated.seats,
          charged,
          invoiceId: invoice ? (invoice as { id: string }).id : null,
        },
      });
      return {
        subscription: await this.serializeSubscription(db, auth.org.id, updated),
        invoice,
        charged,
      };
    });
  }

  async listInvoices(auth: AuthContext): Promise<unknown[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return db
        .select()
        .from(invoices)
        .where(eq(invoices.orgId, auth.org.id))
        .orderBy(desc(invoices.createdAt), desc(invoices.id));
    });
  }

  private async buildPreview(
    db: NexusDb,
    orgId: string,
    sub: Subscription,
    input: PreviewSeatsInput,
  ): Promise<SeatPreview> {
    const plan = input.plan ?? sub.plan;
    const unitPrice = PLAN_UNIT_PRICES[plan];
    if (unitPrice === undefined) {
      throw new BadRequestException({ message: 'Unknown plan', code: 'UNKNOWN_PLAN' });
    }
    const [headcount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.status, 'active')));
    const activeUsers = headcount?.count ?? 0;
    if (input.seats < activeUsers) {
      throw new BadRequestException({
        message: `Seats (${input.seats}) cannot drop below active users (${activeUsers})`,
        code: 'SEATS_BELOW_HEADCOUNT',
      });
    }
    const now = Date.now();
    const elapsedDays = Math.floor((now - sub.cycleStart.getTime()) / 86400000);
    const daysRemaining = Math.max(0, BILLING_CYCLE_DAYS - elapsedDays);
    const keptSeats = Math.min(sub.seats, input.seats);
    const addedSeats = Math.max(0, input.seats - sub.seats);
    const oldUnit = PLAN_UNIT_PRICES[sub.plan] ?? 0;
    const uplift = round2(((unitPrice - oldUnit) * keptSeats * daysRemaining) / BILLING_CYCLE_DAYS);
    const additions = round2((addedSeats * unitPrice * daysRemaining) / BILLING_CYCLE_DAYS);
    const proratedCharge = Math.max(0, round2(uplift + additions));
    return {
      plan,
      previousPlan: sub.plan,
      seats: input.seats,
      previousSeats: sub.seats,
      seatDelta: input.seats - sub.seats,
      unitPrice,
      currency: BILLING_CURRENCY,
      daysRemainingInCycle: daysRemaining,
      proratedCharge,
      newMrr: round2(unitPrice * input.seats),
    };
  }

  private async ensureSubscription(db: NexusDb, auth: AuthContext): Promise<Subscription> {
    const [existing] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.orgId, auth.org.id));
    if (existing) return existing;
    const [org] = await db
      .select({ planTier: organizations.planTier })
      .from(organizations)
      .where(eq(organizations.id, auth.org.id));
    const plan =
      org?.planTier && PLAN_UNIT_PRICES[org.planTier] !== undefined ? org.planTier : 'growth';
    const [headcount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.orgId, auth.org.id), eq(users.status, 'active')));
    const [created] = await db
      .insert(subscriptions)
      .values({
        orgId: auth.org.id,
        plan,
        seats: Math.max(headcount?.count ?? 1, 1),
        status: 'active',
        cycleStart: new Date(),
      })
      .returning();
    if (!created) throw new Error('Subscription insert returned no row');
    await this.audit.record(db, {
      orgId: auth.org.id,
      actorUserId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'subscription.created',
      entityType: 'subscription',
      entityId: created.id,
      newValues: { plan: created.plan, seats: created.seats },
    });
    return created;
  }

  private async serializeSubscription(
    db: NexusDb,
    orgId: string,
    sub: Subscription,
  ): Promise<Record<string, unknown>> {
    const [headcount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.status, 'active')));
    const unitPrice = PLAN_UNIT_PRICES[sub.plan] ?? 0;
    const cycleEnd = new Date(sub.cycleStart.getTime() + BILLING_CYCLE_DAYS * 86400000);
    return {
      id: sub.id,
      plan: sub.plan,
      seats: sub.seats,
      status: sub.status,
      unitPrice,
      currency: BILLING_CURRENCY,
      mrr: round2(unitPrice * sub.seats),
      activeUsers: headcount?.count ?? 0,
      cycleStart: sub.cycleStart,
      cycleEnd,
      provider: this.provider.name,
    };
  }

  assertBillingManager(auth: AuthContext): void {
    // Route scopes already enforce org:manage; defense in depth for
    // service-level callers (workers, future internal APIs).
    const scopes = auth.role.permissions?.scopes ?? [];
    if (!scopes.includes('*') && !scopes.includes('org:manage')) {
      throw new ForbiddenException({
        message: 'Billing requires org:manage',
        code: 'SCOPE_FORBIDDEN',
      });
    }
  }
}
