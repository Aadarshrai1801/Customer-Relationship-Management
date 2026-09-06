import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { customFieldDefinitions, type CustomFieldType } from '@nexus/db';
import { TenantDb, type NexusDb } from '../database/tenant-db.service';
import type { AuthContext } from '../common/auth-context';
import { AuditService } from '../audit/audit.service';
import { isValidFieldKey, type FieldDefinition } from './field-validation';
import { collectRefs, parseFormula } from './formula';
import type { CreateFieldInput, UpdateFieldInput } from './custom-fields.schemas';

export interface SerializedField {
  id: string;
  entityType: 'contact' | 'account';
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  options: Record<string, unknown>;
}

const MAX_FIELDS_PER_ENTITY = 100;

function serialize(row: typeof customFieldDefinitions.$inferSelect): SerializedField {
  return {
    id: row.id,
    entityType: row.entityType,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    options: row.options,
  };
}

interface FieldRow {
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  options: Record<string, unknown>;
}

function toFieldDef(row: FieldRow): FieldDefinition {
  return {
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    options: row.options,
  };
}

@Injectable()
export class CustomFieldsService {
  constructor(
    @Inject(TenantDb) private readonly tenantDb: TenantDb,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(auth: AuthContext, entityType: 'contact' | 'account'): Promise<SerializedField[]> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const rows = await db
        .select()
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.orgId, auth.org.id),
            eq(customFieldDefinitions.entityType, entityType),
          ),
        );
      return rows.map(serialize);
    });
  }

  async loadDefinitions(
    db: NexusDb,
    orgId: string,
    entityType: 'contact' | 'account',
  ): Promise<FieldDefinition[]> {
    const rows = await db
      .select()
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.orgId, orgId),
          eq(customFieldDefinitions.entityType, entityType),
        ),
      );
    return rows.map(toFieldDef);
  }

  async create(auth: AuthContext, input: CreateFieldInput): Promise<SerializedField> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      if (!isValidFieldKey(input.key)) {
        throw new BadRequestException({ message: 'Invalid field key', code: 'FIELD_KEY_INVALID' });
      }
      const existing = await db
        .select()
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.orgId, auth.org.id),
            eq(customFieldDefinitions.entityType, input.entityType),
          ),
        );
      if (existing.some((r) => r.key === input.key)) {
        throw new ConflictException({
          message: 'A field with this key already exists',
          code: 'FIELD_KEY_TAKEN',
        });
      }
      if (existing.length >= MAX_FIELDS_PER_ENTITY) {
        throw new ConflictException({
          message: `Field limit reached (${MAX_FIELDS_PER_ENTITY} per record type)`,
          code: 'FIELD_LIMIT_REACHED',
        });
      }
      if (input.type === 'formula') {
        const expression = input.options['expression'];
        if (typeof expression !== 'string') {
          throw new BadRequestException({
            message: 'Formula fields need an expression',
            code: 'FIELD_OPTIONS_INVALID',
          });
        }
        this.assertFormulaValid(expression, input.key, existing.map(toFieldDef));
      }
      const [created] = await db
        .insert(customFieldDefinitions)
        .values({
          orgId: auth.org.id,
          entityType: input.entityType,
          key: input.key,
          label: input.label,
          type: input.type,
          required: input.required,
          options: input.options as Record<string, unknown>,
        })
        .returning();
      if (!created) throw new Error('Failed to create custom field');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'custom_field.created',
        entityType: 'custom_field',
        entityId: created.id,
        newValues: { entityType: created.entityType, key: created.key, type: created.type },
      });
      return serialize(created);
    });
  }

  async update(auth: AuthContext, id: string, input: UpdateFieldInput): Promise<SerializedField> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.findInOrg(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'Custom field not found', code: 'FIELD_NOT_FOUND' });
      }
      const nextOptions = { ...row.options, ...(input.options ?? {}) };
      if (row.type === 'picklist' || row.type === 'multi_select') {
        const options = nextOptions['options'];
        if (!Array.isArray(options) || options.length === 0) {
          throw new BadRequestException({
            message: 'Picklist fields need at least one option',
            code: 'FIELD_OPTIONS_INVALID',
          });
        }
      }
      if (row.type === 'formula' && input.options?.['expression'] !== undefined) {
        const expression = input.options['expression'];
        if (typeof expression !== 'string' || !expression.trim()) {
          throw new BadRequestException({
            message: 'Formula expression is required',
            code: 'FIELD_OPTIONS_INVALID',
          });
        }
        const siblings = await db
          .select()
          .from(customFieldDefinitions)
          .where(
            and(
              eq(customFieldDefinitions.orgId, auth.org.id),
              eq(customFieldDefinitions.entityType, row.entityType),
            ),
          );
        this.assertFormulaValid(
          expression,
          row.key,
          siblings.filter((s) => s.id !== row.id).map(toFieldDef),
        );
      }
      const [updated] = await db
        .update(customFieldDefinitions)
        .set({
          label: input.label ?? row.label,
          required: input.required ?? row.required,
          options: nextOptions,
          updatedAt: new Date(),
        })
        .where(eq(customFieldDefinitions.id, row.id))
        .returning();
      if (!updated) throw new Error('Failed to update custom field');
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'custom_field.updated',
        entityType: 'custom_field',
        entityId: updated.id,
      });
      return serialize(updated);
    });
  }

  async remove(auth: AuthContext, id: string): Promise<{ ok: true }> {
    return this.tenantDb.tx(auth.org.id, async (db) => {
      const row = await this.findInOrg(db, auth.org.id, id);
      if (!row) {
        throw new NotFoundException({ message: 'Custom field not found', code: 'FIELD_NOT_FOUND' });
      }
      await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, row.id));
      await this.audit.record(db, {
        orgId: auth.org.id,
        actorUserId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'custom_field.deleted',
        entityType: 'custom_field',
        entityId: row.id,
        oldValues: { key: row.key, label: row.label, type: row.type },
      });
      return { ok: true as const };
    });
  }

  private assertFormulaValid(
    expression: string,
    ownKey: string,
    siblings: FieldDefinition[],
  ): void {
    const parsed = parseFormula(expression);
    if (!parsed.ok) {
      throw new BadRequestException({
        message: `Invalid formula: ${parsed.error}`,
        code: 'FORMULA_INVALID',
      });
    }
    const byKey = new Map(siblings.map((s) => [s.key, s]));
    for (const ref of collectRefs(parsed.ast)) {
      if (ref === ownKey) {
        throw new BadRequestException({
          message: 'Formula cannot reference itself',
          code: 'FORMULA_SELF_REFERENCE',
        });
      }
      const target = byKey.get(ref);
      if (!target) {
        throw new BadRequestException({
          message: `Formula references unknown field {${ref}}`,
          code: 'FORMULA_UNKNOWN_FIELD',
        });
      }
      if (target.type === 'formula') {
        throw new BadRequestException({
          message: 'Formulas cannot reference other formulas',
          code: 'FORMULA_CHAINED',
        });
      }
      if (target.type === 'date') {
        throw new BadRequestException({
          message: `Date field {${ref}} is not usable in formulas yet`,
          code: 'FORMULA_TYPE_UNSUPPORTED',
        });
      }
    }
  }

  private async findInOrg(db: NexusDb, orgId: string, id: string) {
    const [row] = await db
      .select()
      .from(customFieldDefinitions)
      .where(and(eq(customFieldDefinitions.id, id), eq(customFieldDefinitions.orgId, orgId)));
    return row ?? null;
  }
}
