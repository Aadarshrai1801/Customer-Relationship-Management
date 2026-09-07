export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
export const RATE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertCurrencyCode(code: string, field = 'currency'): string {
  const normalized = code.trim().toUpperCase();
  if (!CURRENCY_CODE_PATTERN.test(normalized)) {
    const err = new Error(`${field} must be a 3-letter ISO code`);
    (err as Error & { code?: string }).code = 'CURRENCY_INVALID';
    throw err;
  }
  return normalized;
}

export function resolveBaseCurrency(settings?: { baseCurrency?: string } | null): string {
  const raw = settings?.baseCurrency ?? 'USD';
  try {
    return assertCurrencyCode(raw, 'baseCurrency');
  } catch {
    return 'USD';
  }
}

export interface ConversionInput {
  amount: number;
  currency: string;
  baseCurrency: string;
  rates: Record<string, unknown>;
  rateDate: string;
}

export interface ConversionResult {
  baseAmount: number;
  exchangeRate: number;
  baseCurrency: string;
  rateDate: string;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function fail(message: string, code: string): never {
  const err = new Error(message);
  (err as Error & { code?: string }).code = code;
  throw err;
}

/**
 * Converts a transaction amount to the org base currency using a daily
 * snapshot. `rates` maps foreign ISO codes to units of foreign per 1 base
 * (for example, USD base with EUR: 0.92). Same-currency amounts use rate 1.
 */
export function convertToBaseCurrency(input: ConversionInput): ConversionResult {
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    fail('Amount must be a finite number greater than or equal to 0', 'AMOUNT_INVALID');
  }
  const currency = assertCurrencyCode(input.currency);
  const baseCurrency = assertCurrencyCode(input.baseCurrency, 'baseCurrency');
  if (
    !RATE_DATE_PATTERN.test(input.rateDate) ||
    Number.isNaN(Date.parse(`${input.rateDate}T00:00:00Z`))
  ) {
    fail('rateDate must be an ISO date (YYYY-MM-DD)', 'RATE_DATE_INVALID');
  }
  if (currency === baseCurrency) {
    return {
      baseAmount: round(input.amount, 2),
      exchangeRate: 1,
      baseCurrency,
      rateDate: input.rateDate,
    };
  }
  const rawRate = input.rates[currency];
  if (typeof rawRate !== 'number' || !Number.isFinite(rawRate) || rawRate <= 0) {
    fail(`Missing exchange rate for ${currency} on ${input.rateDate}`, 'RATE_MISSING');
  }
  return {
    baseAmount: round(input.amount / rawRate, 2),
    exchangeRate: round(rawRate, 6),
    baseCurrency,
    rateDate: input.rateDate,
  };
}

export function assertPositiveRates(rates: Record<string, unknown>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [code, value] of Object.entries(rates)) {
    const currency = assertCurrencyCode(code, `rates.${code}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      fail(`Rate for ${currency} must be a number greater than 0`, 'RATE_INVALID');
    }
    normalized[currency] = value;
  }
  if (Object.keys(normalized).length === 0) {
    fail('rates must include at least one currency', 'RATE_INVALID');
  }
  return normalized;
}
