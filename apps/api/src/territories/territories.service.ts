import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { accounts, contacts, leads, territories, users, type Territory } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import type { CreateTerritoryInput, TerritoryRule } from './territories.schemas';

export interface SerializedTerritory {
  id: string;
  owner: { id: string; name: string } | null;
  name: string;
  rules: Array<Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
}

function emailDomain(email: string | null): string {
  if (!email) return '';
  const parts = email.toLowerCase().split('@');
  return parts.length === 2 ? (parts[1] as string) : '';
}

function recordField(
  record: { name: string; email: string; company?: string | null; title?: string | null },
  field: string,
): string {
  if (field === 'email_domain') return emailDomain(record.email);
  if (field === 'company') return record.company ?? '';
  if (field === 'title') return record.title ?? '';
  return record.name;
}

function ruleMatches(
  record: { name: string; email: string; company?: string | null; title?: string | null },
  rule: TerritoryRule,
): boolean {
  const actual = recordField(record, rule.field).toLowerCase();
  const expected = rule.value.toLowerCase();
  if (rule.operator === 'equals') return actual === expected;
  if (rule.operator === 'not_equals') return actual !== expected;
  return actual.includes(expected);
}

@Injectable()
export class TerritoriesService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(auth: AuthContext, input: CreateTerritoryInput) {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      let ownerId: string | null = null;
      if (input.ownerId) {
        const [member] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, input.ownerId), eq(users.orgId, auth.org.id)));
        if (!member) {
          throw new BadRequestException({
            message: 'Owner must be a workspace member',
            code: 'OWNER_NOT_MEMBER',
          });
        }
        ownerId = member.id;
      }
      const [duplicate] = await db
        .select({ id: territories.id })
        .from(territories)
        .where(
          and(
            eq(territories.orgId, auth.org.id),
            eq(territories.name, input.name),
            isNull(territories.deletedAt),
          ),
        );
      if (duplicate) {
        throw new ConflictException({
          message: 'A territory with this name already exists',
          code: 'TERRITORY_NAME_TAKEN',
        });
      }
      const [created] = await db
        .insert(territories)
        .values({
          orgId: auth.org.id,
          ownerId,
          name: input.name,
          rules: input.rules as Array<Record<string, unknown>>,
        })
        .returning();
      if (!created) throw new Error('Territory insert returned no row');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'territory.created',
        entityType: 'territory',
        entityId: created.id,
        newValues: { name: created.name },
      });
      return { territory: await this.serializeById(db, auth, created.id) };
    });
  }

  async list(auth: AuthContext): Promise<SerializedTerritory[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db
        .select({ territory: territories, owner: users })
        .from(territories)
        .leftJoin(users, eq(territories.ownerId, users.id))
        .where(and(eq(territories.orgId, auth.org.id), isNull(territories.deletedAt)))
        .orderBy(asc(territories.name));
      return rows.map((row) => this.serialize(row.territory, row.owner));
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const territory = await this.requireLive(db, auth.org.id, id);
      await db
        .update(territories)
        .set({ deletedAt: new Date() })
        .where(eq(territories.id, territory.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'territory.deleted',
        entityType: 'territory',
        entityId: territory.id,
        oldValues: { name: territory.name },
      });
      return { ok: true as const };
    });
  }

  /**
   * Matches a contact or lead against all territories. All rules in a
   * territory must match (AND). Used for assignment suggestions.
   */
  async evaluate(
    auth: AuthContext,
    query: { contactId?: string; leadId?: string },
  ): Promise<{ matches: SerializedTerritory[] }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      let record: { name: string; email: string; company?: string | null; title?: string | null } | null = null;
      if (query.contactId) {
        const [contact] = await db
          .select()
          .from(contacts)
          .where(
            and(eq(contacts.id, query.contactId), eq(contacts.orgId, auth.org.id), isNull(contacts.deletedAt)),
          );
        if (!contact) {
          throw new NotFoundException({ message: 'Contact not found', code: 'CONTACT_NOT_FOUND' });
        }
        record = { name: contact.name, email: contact.email, company: contact.accountId, title: contact.title };
        if (contact.accountId) {
          const [account] = await db
            .select({ name: accounts.name })
            .from(accounts)
            .where(eq(accounts.id, contact.accountId));
          if (account) record.company = account.name;
        }
      } else if (query.leadId) {
        const [lead] = await db
          .select()
          .from(leads)
          .where(and(eq(leads.id, query.leadId), eq(leads.orgId, auth.org.id)));
        if (!lead) {
          throw new NotFoundException({ message: 'Lead not found', code: 'LEAD_NOT_FOUND' });
        }
        record = { name: lead.name, email: lead.email, company: lead.company, title: lead.title };
      } else {
        throw new BadRequestException({
          message: 'contactId or leadId is required',
          code: 'MISSING_RECORD',
        });
      }
      const rows = await db
        .select({ territory: territories, owner: users })
        .from(territories)
        .leftJoin(users, eq(territories.ownerId, users.id))
        .where(and(eq(territories.orgId, auth.org.id), isNull(territories.deletedAt)));
      return {
        matches: rows
          .filter((row) =>
            ((row.territory.rules ?? []) as TerritoryRule[]).every((rule) =>
              ruleMatches(record as { name: string; email: string }, rule),
            ),
          )
          .map((row) => this.serialize(row.territory, row.owner)),
      };
    });
  }

  private async requireLive(db: NexusDb, orgId: string, id: string): Promise<Territory> {
    const [row] = await db
      .select()
      .from(territories)
      .where(and(eq(territories.id, id), eq(territories.orgId, orgId), isNull(territories.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Territory not found', code: 'TERRITORY_NOT_FOUND' });
    }
    return row;
  }

  private async serializeById(db: NexusDb, auth: AuthContext, id: string): Promise<SerializedTerritory> {
    const [row] = await db
      .select({ territory: territories, owner: users })
      .from(territories)
      .leftJoin(users, eq(territories.ownerId, users.id))
      .where(and(eq(territories.id, id), eq(territories.orgId, auth.org.id), isNull(territories.deletedAt)));
    if (!row) {
      throw new NotFoundException({ message: 'Territory not found', code: 'TERRITORY_NOT_FOUND' });
    }
    return this.serialize(row.territory, row.owner);
  }

  private serialize(
    territory: Territory,
    owner: { id: string; name: string } | null,
  ): SerializedTerritory {
    return {
      id: territory.id,
      owner: owner ? { id: owner.id, name: owner.name } : null,
      name: territory.name,
      rules: (territory.rules ?? []) as Array<Record<string, unknown>>,
      createdAt: territory.createdAt,
      updatedAt: territory.updatedAt,
    };
  }
}
