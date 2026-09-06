import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Response } from 'express';
import { accounts, contacts, users } from '@nexus/db';
import { TenantDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { escapeCsvCell, safeCell } from './csv-utils';

const EXPORT_PAGE = 1000;

function vcfEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

@Injectable()
export class ExportsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(CustomFieldsService) private readonly fields: CustomFieldsService,
  ) {}

  private recordScope(auth: AuthContext, entity: 'contact' | 'account'): 'all' | 'own' {
    return auth.role.permissions?.recordAccess?.[entity] ?? 'own';
  }

  async streamContactsCsv(
    auth: AuthContext,
    filter: { accountId?: string; lifecycleStage?: string },
    res: Response,
  ): Promise<void> {
    const defs = await this.tenantDb.tx(auth.org.id, (db) =>
      this.fields.loadDefinitions(db, auth.org.id, 'contact'),
    );
    const customKeys = defs.map((d) => d.key).sort();
    const headers = [
      'id',
      'name',
      'firstName',
      'lastName',
      'email',
      'phone',
      'title',
      'lifecycleStage',
      'accountName',
      'ownerEmail',
      'tags',
      'createdAt',
      ...customKeys,
    ];
    res.write(`${headers.map(escapeCsvCell).join(',')}\n`);
    const canSeeAll = this.recordScope(auth, 'contact') === 'all';
    let offset = 0;
    for (;;) {
      const page = await this.tenantDb.tx(auth.org.id, (db) => {
        const conditions = [eq(contacts.orgId, auth.org.id), isNull(contacts.deletedAt)];
        if (!canSeeAll) conditions.push(eq(contacts.ownerId, auth.user.id));
        if (filter.accountId) conditions.push(eq(contacts.accountId, filter.accountId));
        if (filter.lifecycleStage)
          conditions.push(eq(contacts.lifecycleStage, filter.lifecycleStage));
        return db
          .select({ contact: contacts, accountName: accounts.name, ownerEmail: users.email })
          .from(contacts)
          .leftJoin(accounts, eq(contacts.accountId, accounts.id))
          .leftJoin(users, eq(contacts.ownerId, users.id))
          .where(and(...conditions))
          .orderBy(contacts.createdAt, contacts.id)
          .limit(EXPORT_PAGE)
          .offset(offset);
      });
      if (page.length === 0) break;
      for (const row of page) {
        const custom = (row.contact.customFields ?? {}) as Record<string, unknown>;
        const cells = [
          row.contact.id,
          row.contact.name,
          row.contact.firstName ?? '',
          row.contact.lastName ?? '',
          row.contact.email,
          row.contact.phone ?? '',
          row.contact.title ?? '',
          row.contact.lifecycleStage,
          row.accountName ?? '',
          row.ownerEmail ?? '',
          row.contact.tags.join(';'),
          row.contact.createdAt.toISOString(),
          ...customKeys.map((k) => String(custom[k] ?? '')),
        ];
        if (!res.write(`${cells.map((c) => escapeCsvCell(safeCell(c))).join(',')}\n`)) {
          await new Promise<void>((resolve) => res.once('drain', () => resolve()));
        }
      }
      offset += page.length;
      if (page.length < EXPORT_PAGE) break;
    }
    res.end();
  }

  async streamAccountsCsv(auth: AuthContext, res: Response): Promise<void> {
    const defs = await this.tenantDb.tx(auth.org.id, (db) =>
      this.fields.loadDefinitions(db, auth.org.id, 'account'),
    );
    const customKeys = defs.map((d) => d.key).sort();
    const headers = [
      'id',
      'name',
      'website',
      'domains',
      'phone',
      'industry',
      'ownerEmail',
      'tags',
      'createdAt',
      ...customKeys,
    ];
    res.write(`${headers.map(escapeCsvCell).join(',')}\n`);
    const canSeeAll = this.recordScope(auth, 'account') === 'all';
    let offset = 0;
    for (;;) {
      const page = await this.tenantDb.tx(auth.org.id, (db) => {
        const conditions = [eq(accounts.orgId, auth.org.id), isNull(accounts.deletedAt)];
        if (!canSeeAll) conditions.push(eq(accounts.ownerId, auth.user.id));
        return db
          .select({ account: accounts, ownerEmail: users.email })
          .from(accounts)
          .leftJoin(users, eq(accounts.ownerId, users.id))
          .where(and(...conditions))
          .orderBy(accounts.createdAt, accounts.id)
          .limit(EXPORT_PAGE)
          .offset(offset);
      });
      if (page.length === 0) break;
      for (const row of page) {
        const custom = (row.account.customFields ?? {}) as Record<string, unknown>;
        const cells = [
          row.account.id,
          row.account.name,
          row.account.website ?? '',
          row.account.domains.join(';'),
          row.account.phone ?? '',
          row.account.industry ?? '',
          row.ownerEmail ?? '',
          row.account.tags.join(';'),
          row.account.createdAt.toISOString(),
          ...customKeys.map((k) => String(custom[k] ?? '')),
        ];
        if (!res.write(`${cells.map((c) => escapeCsvCell(safeCell(c))).join(',')}\n`)) {
          await new Promise<void>((resolve) => res.once('drain', () => resolve()));
        }
      }
      offset += page.length;
      if (page.length < EXPORT_PAGE) break;
    }
    res.end();
  }

  async buildContactVcf(
    auth: AuthContext,
    id: string,
  ): Promise<{ filename: string; body: string }> {
    const row = await this.tenantDb.tx(auth.org.id, (db) =>
      db
        .select({ contact: contacts, account: accounts })
        .from(contacts)
        .leftJoin(accounts, eq(contacts.accountId, accounts.id))
        .where(
          and(eq(contacts.id, id), eq(contacts.orgId, auth.org.id), isNull(contacts.deletedAt)),
        )
        .then((rows) => rows[0] ?? null),
    );
    if (!row) {
      throw new NotFoundException({ message: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
    }
    const canSeeAll = this.recordScope(auth, 'contact') === 'all';
    if (!canSeeAll && row.contact.ownerId !== auth.user.id) {
      throw new NotFoundException({ message: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
    }
    const c = row.contact;
    const lines = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      `FN:${vcfEscape(c.name)}`,
      `N:${vcfEscape(c.lastName ?? '')};${vcfEscape(c.firstName ?? '')};;;`,
      `EMAIL:${vcfEscape(c.email)}`,
    ];
    if (c.phone) lines.push(`TEL:${vcfEscape(c.phone)}`);
    if (c.title) lines.push(`TITLE:${vcfEscape(c.title)}`);
    if (row.account) lines.push(`ORG:${vcfEscape(row.account.name)}`);
    lines.push('END:VCARD');
    return {
      filename: `${c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.vcf`,
      body: lines.join('\r\n'),
    };
  }
}
