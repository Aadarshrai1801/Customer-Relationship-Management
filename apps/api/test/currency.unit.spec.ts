import { describe, expect, it } from 'vitest';
import {
  assertCurrencyCode,
  assertPositiveRates,
  convertToBaseCurrency,
  resolveBaseCurrency,
} from '../src/pipelines/currency';

describe('currency helpers', () => {
  it('normalizes and validates ISO codes', () => {
    expect(assertCurrencyCode('usd')).toBe('USD');
    expect(() => assertCurrencyCode('US')).toThrowError(/3-letter ISO/);
    expect(() => assertCurrencyCode('US1')).toThrowError(/3-letter ISO/);
  });

  it('resolves the org base currency with a USD fallback', () => {
    expect(resolveBaseCurrency({ baseCurrency: 'eur' })).toBe('EUR');
    expect(resolveBaseCurrency({})).toBe('USD');
    expect(resolveBaseCurrency(null)).toBe('USD');
    expect(resolveBaseCurrency({ baseCurrency: 'XX' })).toBe('USD');
  });

  it('converts foreign amounts with daily snapshot rates', () => {
    expect(
      convertToBaseCurrency({
        amount: 92,
        currency: 'EUR',
        baseCurrency: 'USD',
        rates: { EUR: 0.92 },
        rateDate: '2026-09-07',
      }),
    ).toEqual({ baseAmount: 100, exchangeRate: 0.92, baseCurrency: 'USD', rateDate: '2026-09-07' });
  });

  it('uses rate 1 for same-currency amounts', () => {
    expect(
      convertToBaseCurrency({
        amount: 10.5,
        currency: 'USD',
        baseCurrency: 'USD',
        rates: {},
        rateDate: '2026-09-07',
      }),
    ).toMatchObject({ baseAmount: 10.5, exchangeRate: 1 });
  });

  it('rejects bad amounts, dates, and missing rates', () => {
    expect(() =>
      convertToBaseCurrency({
        amount: -1,
        currency: 'USD',
        baseCurrency: 'USD',
        rates: {},
        rateDate: '2026-09-07',
      }),
    ).toThrowError(/greater than or equal to 0/);
    expect(() =>
      convertToBaseCurrency({
        amount: 1,
        currency: 'EUR',
        baseCurrency: 'USD',
        rates: {},
        rateDate: '2026-09-07',
      }),
    ).toThrowError(/Missing exchange rate/);
    expect(() =>
      convertToBaseCurrency({
        amount: 1,
        currency: 'USD',
        baseCurrency: 'USD',
        rates: {},
        rateDate: '09/07/2026',
      }),
    ).toThrowError(/YYYY-MM-DD/);
  });

  it('validates rate tables', () => {
    expect(assertPositiveRates({ eur: 0.92 })).toEqual({ EUR: 0.92 });
    expect(() => assertPositiveRates({ EUR: 0 })).toThrowError(/greater than 0/);
    expect(() => assertPositiveRates({})).toThrowError(/at least one currency/);
  });
});
