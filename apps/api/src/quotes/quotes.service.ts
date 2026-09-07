import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { contacts, dealLineItems, deals, quotes, users, type Quote } from '@nexus/db';
import { TenantDb, IdentityDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { checkRecordAccess } from '../rbac/permissions';
import type { AcceptQuoteInput, CreateQuoteInput, DeclineQuoteInput } from './quotes.schemas';

export interface SerializedQuote {
  id: string;
  deal: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  number: string;
  lines: Array<Record<string, unknown>>;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  currency: string;
  validUntil: Date | null;
  status: string;
  publicToken: string | null;
  signature: Record<string, unknown> | null;
  sentAt: Date | null;
  decidedAt: Date | null;
  expired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toNumber(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function quoteNumber(): string {
  return `Q-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

@Injectable()
export class QuotesService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(IdentityDb) private readonly identity: IdentityDb,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /**
   * Snapshots the deal's current line items into an immutable quote draft.
   * Later catalog edits never rewrite the quote (same snapshot rule as
   * line items themselves).
   */
  async create(auth: AuthContext, input: CreateQuoteInput): Promise<{ quote: SerializedQuote }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const deal = await this.requireReadableDeal(db, auth, input.dealId);
      const lines = await db
        .select()
        .from(dealLineItems)
        .where(and(eq(dealLineItems.dealId, deal.id), eq(dealLineItems.orgId, auth.org.id)));
      if (lines.length === 0) {
        throw new BadRequestException({
          message: 'Deal has no line items to quote',
          code: 'NO_LINE_ITEMS',
        });
      }
      const snapshot = lines.map((l) => ({
        name: l.name,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountRate: l.discountRate,
        taxRate: l.taxRate,
        lineTotal: l.lineTotal,
        currency: l.currency,
      }));
      // Pre-tax nets first (lineTotal already includes tax — reusing it
      // would double-count). Quote discount shrinks the taxable base.
      const preTax = (l: (typeof snapshot)[number]): number =>
        toNumber(l.quantity) * toNumber(l.unitPrice) * (1 - toNumber(l.discountRate));
      const subtotal = round2(snapshot.reduce((sum, l) => sum + preTax(l), 0));
      const discountTotal = round2(subtotal * input.discountRate);
      const net = subtotal - discountTotal;
      const taxTotal = round2(
        snapshot.reduce((sum, l) => sum + preTax(l) * toNumber(l.taxRate), 0) *
          (net / (subtotal || 1)),
      );
      const total = round2(net + taxTotal);
      const [created] = await db
        .insert(quotes)
        .values({
          orgId: auth.org.id,
          dealId: deal.id,
          ownerId: auth.user.id,
          number: quoteNumber(),
          lines: snapshot,
          subtotal: String(subtotal),
          discountTotal: String(discountTotal),
          taxTotal: String(taxTotal),
          total: String(total),
          currency: deal.currency,
          validUntil: new Date(Date.now() + input.validUntilDays * 86400000),
          status: 'draft',
          publicToken: randomUUID().replace(/-/g, ''),
        })
        .returning();
      if (!created) throw new Error('Quote insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'quote.created',
        entityType: 'deal',
        entityId: deal.id,
        newValues: { quoteId: created.id, number: created.number, total: created.total },
      });
      return { quote: await this.serializeById(db, auth, created.id, true) };
    });
  }

  async list(auth: AuthContext, dealId?: string): Promise<SerializedQuote[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const conditions = [eq(quotes.orgId, auth.org.id)];
      if (dealId) {
        await this.requireReadableDeal(db, auth, dealId);
        conditions.push(eq(quotes.dealId, dealId));
      } else if ((auth.role.permissions?.recordAccess?.['deal'] ?? 'own') !== 'all') {
        const mine = await db
          .select({ id: deals.id })
          .from(deals)
          .where(and(eq(deals.orgId, auth.org.id), eq(deals.ownerId, auth.user.id)));
        const ids = new Set(mine.map((d) => d.id));
        const rows = await db
          .select()
          .from(quotes)
          .where(eq(quotes.orgId, auth.org.id))
          .orderBy(desc(quotes.createdAt));
        return Promise.all(
          rows.filter((q) => ids.has(q.dealId)).map((q) => this.serialize(db, auth, q, true)),
        );
      }
      const rows = await db
        .select()
        .from(quotes)
        .where(and(...conditions))
        .orderBy(desc(quotes.createdAt));
      return Promise.all(rows.map((q) => this.serialize(db, auth, q, true)));
    });
  }

  async getById(auth: AuthContext, id: string): Promise<SerializedQuote> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      return this.serializeById(db, auth, id, true);
    });
  }

  async send(auth: AuthContext, id: string, to?: string): Promise<{ quote: SerializedQuote }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.requireLiveQuote(db, auth.org.id, id);
      await this.requireReadableDeal(db, auth, row.dealId);
      if (row.status !== 'draft') {
        throw new ConflictException({ message: 'Only drafts can be sent', code: 'QUOTE_LOCKED' });
      }
      const recipient = to ?? (await this.dealContactEmail(db, auth.org.id, row.dealId)) ?? null;
      if (!recipient) {
        throw new BadRequestException({
          message: 'No recipient: pass "to" or link the deal to a contact',
          code: 'NO_RECIPIENT',
        });
      }
      const link = `${this.mail.trackingBaseUrl.replace(/:\d+$/, ':5173')}/quotes/${row.publicToken}`;
      await this.mail.sendEmail({
        to: recipient,
        subject: `Quote ${row.number}`,
        text: `Please review quote ${row.number} (${row.currency} ${row.total}): ${link}`,
      });
      const [updated] = await db
        .update(quotes)
        .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
        .where(eq(quotes.id, row.id))
        .returning();
      if (!updated) throw new Error('Quote send returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'quote.sent',
        entityType: 'deal',
        entityId: row.dealId,
        newValues: { quoteId: row.id, to: recipient },
      });
      return { quote: await this.serializeById(db, auth, updated.id, true) };
    });
  }

  /** Public client view (token-gated, no session). Never exposes internals. */
  async publicView(publicToken: string): Promise<SerializedQuote> {
    // IdentityDb (BYPASSRLS role) resolves the token, then every write
    // below runs tenant-scoped on the quote's own org.
    const [row] = await this.identity.db
      .select()
      .from(quotes)
      .where(eq(quotes.publicToken, publicToken));
    if (!row) {
      throw new NotFoundException({ message: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    }
    return this.serializePublic(row);
  }

  /**
   * Client acceptance. The signature object (name + timestamp + IP) is
   * the e-signature integration point — a DocuSign adapter slots in here
   * without changing the API shape.
   */
  async accept(
    publicToken: string,
    input: AcceptQuoteInput,
    ip: string | undefined,
  ): Promise<SerializedQuote> {
    return this.decide(publicToken, 'accepted', {
      name: input.name,
      email: input.email ?? null,
      at: new Date().toISOString(),
      ip: ip ?? null,
      provider: 'stub',
    });
  }

  async decline(publicToken: string, input: DeclineQuoteInput): Promise<SerializedQuote> {
    return this.decide(publicToken, 'declined', null, input.reason ?? null);
  }

  private async decide(
    publicToken: string,
    status: 'accepted' | 'declined',
    signature: Record<string, unknown> | null,
    reason: string | null = null,
  ): Promise<SerializedQuote> {
    const [row] = await this.identity.db
      .select()
      .from(quotes)
      .where(eq(quotes.publicToken, publicToken));
    if (!row) {
      throw new NotFoundException({ message: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    }
    if (row.status !== 'sent') {
      throw new ConflictException({
        message: 'Only sent quotes can be decided',
        code: 'QUOTE_LOCKED',
      });
    }
    if (row.validUntil && row.validUntil.getTime() < Date.now()) {
      throw new ConflictException({ message: 'Quote has expired', code: 'QUOTE_EXPIRED' });
    }
    return this.tenantDb.tx(row.orgId, async (db) => {
      const [updated] = await db
        .update(quotes)
        .set({
          status,
          signature,
          decidedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(quotes.id, row.id))
        .returning();
      if (!updated) throw new Error('Quote decision returned no row');
      await this.audit.record(db, {
        orgId: row.orgId,
        actorUserId: null,
        actorEmail: null,
        action: `quote.${status}`,
        entityType: 'deal',
        entityId: row.dealId,
        newValues: { quoteId: row.id, reason },
      });
      return this.serializePublic(updated);
    });
  }

  private async requireReadableDeal(db: NexusDb, auth: AuthContext, dealId: string) {
    const [deal] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, auth.org.id), isNull(deals.deletedAt)));
    if (!deal) {
      throw new NotFoundException({ message: 'Deal not found', code: 'DEAL_NOT_FOUND' });
    }
    try {
      checkRecordAccess(auth.role.permissions, 'deal', deal.ownerId ?? '', auth.user.id);
    } catch {
      throw new ForbiddenException({
        message: 'Not allowed to access this record',
        code: 'RECORD_FORBIDDEN',
      });
    }
    return deal;
  }

  private async requireLiveQuote(db: NexusDb, orgId: string, id: string): Promise<Quote> {
    const [row] = await db
      .select()
      .from(quotes)
      .where(and(eq(quotes.id, id), eq(quotes.orgId, orgId)));
    if (!row) {
      throw new NotFoundException({ message: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    }
    return row;
  }

  private async dealContactEmail(
    db: NexusDb,
    orgId: string,
    dealId: string,
  ): Promise<string | null> {
    const [deal] = await db
      .select({ contactId: deals.contactId })
      .from(deals)
      .where(and(eq(deals.id, dealId), eq(deals.orgId, orgId)));
    if (!deal?.contactId) return null;
    const [contact] = await db
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.id, deal.contactId), eq(contacts.orgId, orgId)));
    return contact?.email ?? null;
  }

  private async serializeById(
    db: NexusDb,
    auth: AuthContext,
    id: string,
    includeToken: boolean,
  ): Promise<SerializedQuote> {
    const [row] = await db
      .select()
      .from(quotes)
      .where(and(eq(quotes.id, id), eq(quotes.orgId, auth.org.id)));
    if (!row) {
      throw new NotFoundException({ message: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    }
    await this.requireReadableDeal(db, auth, row.dealId);
    return this.serialize(db, auth, row, includeToken);
  }

  private async serialize(
    db: NexusDb,
    auth: AuthContext,
    quote: Quote,
    includeToken: boolean,
  ): Promise<SerializedQuote> {
    const [deal] = await db
      .select({ id: deals.id, name: deals.name })
      .from(deals)
      .where(eq(deals.id, quote.dealId));
    const [owner] = quote.ownerId
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.id, quote.ownerId))
      : [undefined];
    void auth;
    const expired =
      (quote.status === 'draft' || quote.status === 'sent') &&
      !!quote.validUntil &&
      quote.validUntil.getTime() < Date.now();
    return {
      id: quote.id,
      deal: deal ?? null,
      owner: owner ?? null,
      number: quote.number,
      lines: (quote.lines ?? []) as Array<Record<string, unknown>>,
      subtotal: toNumber(quote.subtotal),
      discountTotal: toNumber(quote.discountTotal),
      taxTotal: toNumber(quote.taxTotal),
      total: toNumber(quote.total),
      currency: quote.currency,
      validUntil: quote.validUntil,
      status: expired ? 'expired' : quote.status,
      publicToken: includeToken ? quote.publicToken : null,
      signature: (quote.signature ?? null) as Record<string, unknown> | null,
      sentAt: quote.sentAt,
      decidedAt: quote.decidedAt,
      expired,
      createdAt: quote.createdAt,
      updatedAt: quote.updatedAt,
    };
  }

  private serializePublic(quote: Quote): SerializedQuote {
    const expired =
      (quote.status === 'draft' || quote.status === 'sent') &&
      !!quote.validUntil &&
      quote.validUntil.getTime() < Date.now();
    const signature = (quote.signature ?? null) as Record<string, unknown> | null;
    return {
      id: quote.id,
      deal: null,
      owner: null,
      number: quote.number,
      lines: (quote.lines ?? []) as Array<Record<string, unknown>>,
      subtotal: toNumber(quote.subtotal),
      discountTotal: toNumber(quote.discountTotal),
      taxTotal: toNumber(quote.taxTotal),
      total: toNumber(quote.total),
      currency: quote.currency,
      validUntil: quote.validUntil,
      status: expired ? 'expired' : quote.status,
      publicToken: quote.publicToken,
      // Client-visible proof of signing; signer IP stays private.
      signature: signature
        ? {
            name: signature['name'] ?? null,
            email: signature['email'] ?? null,
            at: signature['at'] ?? null,
            provider: signature['provider'] ?? null,
          }
        : null,
      sentAt: quote.sentAt,
      decidedAt: quote.decidedAt,
      expired,
      createdAt: quote.createdAt,
      updatedAt: quote.updatedAt,
    };
  }
}
