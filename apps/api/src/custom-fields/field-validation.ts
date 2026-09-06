import type { CustomFieldType } from '@nexus/db';

export interface FieldDefinition {
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  options: Record<string, unknown>;
}

export interface FieldIssue {
  key: string;
  code: string;
  message: string;
}

export interface NormalizedValues {
  values: Record<string, unknown>;
  issues: FieldIssue[];
}

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function isValidFieldKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function isMissing(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function picklistOptions(def: FieldDefinition): string[] | null {
  const raw = def.options['options'];
  if (!Array.isArray(raw)) return null;
  return raw.filter((o): o is string => typeof o === 'string');
}

function defaultCurrency(def: FieldDefinition): string {
  const raw = def.options['currency'];
  return typeof raw === 'string' && CURRENCY_CODE_PATTERN.test(raw) ? raw : 'USD';
}

/**
 * Validates + normalizes a single custom value. Never throws for bad input;
 * returns issues instead. Normalization is minimal and explicit (currency
 * numbers become { amount, currency } objects).
 */
export function validateFieldValue(
  def: FieldDefinition,
  value: unknown,
): { errors: string[]; normalized: unknown } {
  switch (def.type) {
    case 'text': {
      if (typeof value !== 'string') return err('Must be text');
      const min = typeof def.options['minLength'] === 'number' ? def.options['minLength'] : 0;
      const max = typeof def.options['maxLength'] === 'number' ? def.options['maxLength'] : 10000;
      if (value.length < min) return err(`Must be at least ${min} characters`);
      if (value.length > max) return err(`Must be at most ${max} characters`);
      return ok(value);
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return err('Must be a number');
      const min = typeof def.options['min'] === 'number' ? def.options['min'] : undefined;
      const max = typeof def.options['max'] === 'number' ? def.options['max'] : undefined;
      if (min !== undefined && value < min) return err(`Must be at least ${min}`);
      if (max !== undefined && value > max) return err(`Must be at most ${max}`);
      return ok(value);
    }
    case 'date': {
      if (
        typeof value !== 'string' ||
        !DATE_PATTERN.test(value) ||
        Number.isNaN(Date.parse(value))
      ) {
        return err('Must be an ISO date (YYYY-MM-DD)');
      }
      return ok(value);
    }
    case 'picklist': {
      const options = picklistOptions(def);
      if (!options) return err('Field is misconfigured (no options)');
      if (typeof value !== 'string' || !options.includes(value)) {
        return err(`Must be one of: ${options.join(', ')}`);
      }
      return ok(value);
    }
    case 'multi_select': {
      const options = picklistOptions(def);
      if (!options) return err('Field is misconfigured (no options)');
      if (!Array.isArray(value) || !value.every((v): v is string => typeof v === 'string')) {
        return err('Must be a list of text values');
      }
      const unknown = value.filter((v) => !options.includes(v));
      if (unknown.length > 0) return err(`Unknown options: ${unknown.join(', ')}`);
      return ok([...new Set(value)]);
    }
    case 'checkbox': {
      if (typeof value !== 'boolean') return err('Must be true or false');
      return ok(value);
    }
    case 'currency': {
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return err('Must be a number');
        return ok({ amount: value, currency: defaultCurrency(def) });
      }
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        const amount = record['amount'];
        const currency = record['currency'];
        if (typeof amount !== 'number' || !Number.isFinite(amount))
          return err('Amount must be a number');
        if (typeof currency !== 'string' || !CURRENCY_CODE_PATTERN.test(currency)) {
          return err('Currency must be a 3-letter ISO code');
        }
        return ok({ amount, currency });
      }
      return err('Must be a number or { amount, currency }');
    }
    case 'formula': {
      return err('Formula fields are computed and cannot be set directly');
    }
  }

  function ok(normalized: unknown): { errors: string[]; normalized: unknown } {
    return { errors: [], normalized };
  }
  function err(message: string): { errors: string[]; normalized: unknown } {
    return { errors: [message], normalized: value };
  }
}

/**
 * Validates a full custom-fields payload against the org's definitions.
 * Unknown keys and values for formula fields are rejected explicitly —
 * never silently dropped.
 */
export function validateCustomFields(
  defs: FieldDefinition[],
  values: Record<string, unknown>,
): NormalizedValues {
  const issues: FieldIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const byKey = new Map(defs.map((d) => [d.key, d]));

  for (const key of Object.keys(values)) {
    const def = byKey.get(key);
    if (!def) {
      issues.push({ key, code: 'UNKNOWN_CUSTOM_FIELD', message: `Unknown custom field: ${key}` });
      continue;
    }
    if (def.type === 'formula') {
      issues.push({
        key,
        code: 'FORMULA_FIELD_READONLY',
        message: `Formula field ${key} is computed and cannot be set directly`,
      });
      continue;
    }
    const { errors, normalized: value } = validateFieldValue(def, values[key]);
    for (const message of errors) {
      issues.push({ key, code: 'INVALID_CUSTOM_FIELD', message });
    }
    if (errors.length === 0) normalized[key] = value;
  }

  for (const def of defs) {
    if (def.required && isMissing(values[def.key])) {
      issues.push({
        key: def.key,
        code: 'REQUIRED_CUSTOM_FIELD',
        message: `${def.label} is required`,
      });
    }
  }

  return { values: normalized, issues };
}
