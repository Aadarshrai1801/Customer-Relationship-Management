import { describe, expect, it } from 'vitest';
import {
  isValidFieldKey,
  validateCustomFields,
  validateFieldValue,
  type FieldDefinition,
} from '../src/custom-fields/field-validation';
import {
  collectRefs,
  evaluateFormula,
  parseFormula,
  type RefResolver,
} from '../src/custom-fields/formula';

function def(
  partial: Partial<FieldDefinition> & { key: string; type: FieldDefinition['type'] },
): FieldDefinition {
  return { label: partial.key, required: false, options: {}, ...partial };
}

function resolver(values: Record<string, unknown>): RefResolver {
  return (key) => {
    if (!(key in values)) return { found: false };
    return { found: true, value: values[key] };
  };
}

function evaluated(expr: string, values: Record<string, unknown>): unknown {
  const parsed = parseFormula(expr);
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
  const result = evaluateFormula(parsed.ast, resolver(values));
  if (!result.ok) throw new Error(`eval failed: ${result.error}`);
  return result.value;
}

describe('field keys', () => {
  it('accepts snake_case and rejects the rest', () => {
    expect(isValidFieldKey('annual_revenue')).toBe(true);
    expect(isValidFieldKey('a')).toBe(false);
    expect(isValidFieldKey('Annual')).toBe(false);
    expect(isValidFieldKey('has space')).toBe(false);
    expect(isValidFieldKey('1abc')).toBe(false);
  });
});

describe('validateFieldValue', () => {
  it('validates text bounds', () => {
    const d = def({ key: 't', type: 'text' });
    expect(validateFieldValue(d, 'hello').errors).toEqual([]);
    expect(validateFieldValue(d, 42).errors).toHaveLength(1);
    const bounded = def({ key: 't', type: 'text', options: { minLength: 2, maxLength: 3 } });
    expect(validateFieldValue(bounded, 'x').errors).toHaveLength(1);
    expect(validateFieldValue(bounded, 'abcd').errors).toHaveLength(1);
    expect(validateFieldValue(bounded, 'abc').errors).toEqual([]);
  });

  it('validates numbers and ranges', () => {
    const d = def({ key: 'n', type: 'number', options: { min: 0, max: 10 } });
    expect(validateFieldValue(d, 5).errors).toEqual([]);
    expect(validateFieldValue(d, -1).errors).toHaveLength(1);
    expect(validateFieldValue(d, 11).errors).toHaveLength(1);
    expect(validateFieldValue(d, '5').errors).toHaveLength(1);
    expect(validateFieldValue(d, Number.NaN).errors).toHaveLength(1);
  });

  it('validates ISO dates', () => {
    const d = def({ key: 'd', type: 'date' });
    expect(validateFieldValue(d, '2026-09-06').errors).toEqual([]);
    expect(validateFieldValue(d, '2026-09-06T10:00:00Z').errors).toEqual([]);
    expect(validateFieldValue(d, '09/06/2026').errors).toHaveLength(1);
    expect(validateFieldValue(d, 'yesterday').errors).toHaveLength(1);
  });

  it('validates picklist and multi-select membership', () => {
    const pick = def({ key: 'p', type: 'picklist', options: { options: ['a', 'b'] } });
    expect(validateFieldValue(pick, 'a').errors).toEqual([]);
    expect(validateFieldValue(pick, 'c').errors).toHaveLength(1);
    const multi = def({ key: 'm', type: 'multi_select', options: { options: ['a', 'b'] } });
    expect(validateFieldValue(multi, ['a', 'b']).errors).toEqual([]);
    expect(validateFieldValue(multi, ['a', 'a']).normalized).toEqual(['a']);
    expect(validateFieldValue(multi, ['a', 'z']).errors).toHaveLength(1);
    expect(validateFieldValue(multi, 'a').errors).toHaveLength(1);
  });

  it('validates checkboxes', () => {
    const d = def({ key: 'c', type: 'checkbox' });
    expect(validateFieldValue(d, true).errors).toEqual([]);
    expect(validateFieldValue(d, 'true').errors).toHaveLength(1);
  });

  it('normalizes currency and validates ISO codes', () => {
    const d = def({ key: 'amt', type: 'currency', options: { currency: 'EUR' } });
    expect(validateFieldValue(d, 100)).toEqual({
      errors: [],
      normalized: { amount: 100, currency: 'EUR' },
    });
    expect(validateFieldValue(d, { amount: 10, currency: 'USD' }).errors).toEqual([]);
    expect(validateFieldValue(d, { amount: 10, currency: 'US' }).errors).toHaveLength(1);
    expect(validateFieldValue(d, { amount: 'x', currency: 'USD' }).errors).toHaveLength(1);
  });

  it('rejects direct writes to formula fields', () => {
    const d = def({ key: 'f', type: 'formula' });
    expect(validateFieldValue(d, 42).errors).toHaveLength(1);
  });
});

describe('validateCustomFields', () => {
  const defs = [
    def({ key: 'nickname', type: 'text' }),
    def({ key: 'score', type: 'number', required: true, label: 'Score' }),
  ];

  it('rejects unknown keys and enforces required', () => {
    const { values, issues } = validateCustomFields(defs, { nickname: 'Al', bogus: 1 });
    expect(values).toEqual({ nickname: 'Al' });
    expect(issues.map((i) => i.code).sort()).toEqual([
      'REQUIRED_CUSTOM_FIELD',
      'UNKNOWN_CUSTOM_FIELD',
    ]);
  });

  it('accepts a fully valid payload', () => {
    const { values, issues } = validateCustomFields(defs, { nickname: 'Al', score: 9 });
    expect(issues).toEqual([]);
    expect(values).toEqual({ nickname: 'Al', score: 9 });
  });

  it('rejects values for formula fields explicitly', () => {
    const withFormula = [...defs, def({ key: 'total', type: 'formula' })];
    const { issues } = validateCustomFields(withFormula, { score: 1, total: 2 });
    expect(issues.map((i) => i.code)).toContain('FORMULA_FIELD_READONLY');
  });
});

describe('parseFormula', () => {
  it('parses arithmetic with precedence', () => {
    expect(evaluated('1 + 2 * 3', {})).toBe(7);
    expect(evaluated('(1 + 2) * 3', {})).toBe(9);
    expect(evaluated('10 / 4', {})).toBe(2.5);
    expect(evaluated('-5 + 8', {})).toBe(3);
  });

  it('resolves field references', () => {
    expect(evaluated('{qty} * {price}', { qty: 3, price: 9.5 })).toBe(28.5);
    expect(evaluated('{amount}', { amount: { amount: 42, currency: 'USD' } })).toBe(42);
  });

  it('evaluates comparisons and logic', () => {
    expect(evaluated('{score} >= 90', { score: 95 })).toBe(true);
    expect(evaluated('{a} = {b} AND NOT {flag}', { a: 1, b: 1, flag: false })).toBe(true);
    expect(evaluated('{a} != "x" OR {b} < 0', { a: 'x', b: 5 })).toBe(false);
  });

  it('evaluates functions', () => {
    expect(evaluated('CONCAT({first}, " ", {last})', { first: 'Ada', last: 'L' })).toBe('Ada L');
    expect(evaluated('ROUND(3.14159, 2)', {})).toBe(3.14);
    expect(evaluated('IF({n} > 10, "big", "small")', { n: 20 })).toBe('big');
    expect(evaluated('MIN(3, 1, 2)', {})).toBe(1);
    expect(evaluated('MAX(3, 1, 2)', {})).toBe(3);
  });

  it('reports evaluation errors without throwing', () => {
    const parsed = parseFormula('{a} / {b}');
    if (!parsed.ok) throw new Error('should parse');
    expect(evaluateFormula(parsed.ast, resolver({ a: 1, b: 0 }))).toEqual({
      ok: false,
      error: 'Division by zero',
    });
    expect(evaluateFormula(parsed.ast, resolver({}))).toMatchObject({ ok: false });
    expect(() => evaluated('{t} + 1', { t: 'text' })).toThrow(/must be a number/);
  });

  it('rejects bad syntax with messages', () => {
    expect(parseFormula('')).toMatchObject({ ok: false });
    expect(parseFormula('1 +')).toMatchObject({ ok: false });
    expect(parseFormula('NOSUCHFN(1)')).toMatchObject({ ok: false });
    expect(parseFormula('{unclosed')).toMatchObject({ ok: false });
    expect(parseFormula('"unterminated')).toMatchObject({ ok: false });
    expect(parseFormula('1 2')).toMatchObject({ ok: false });
  });

  it('collects referenced keys', () => {
    const parsed = parseFormula('IF({a} > 1, CONCAT({b}, "!"), "x")');
    if (!parsed.ok) throw new Error('should parse');
    expect(collectRefs(parsed.ast).sort()).toEqual(['a', 'b']);
  });
});
