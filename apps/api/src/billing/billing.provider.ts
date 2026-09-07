import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export interface ChargeInput {
  orgId: string;
  amount: number;
  currency: string;
  description: string;
}

export interface BillingProvider {
  readonly name: string;
  charge(input: ChargeInput): Promise<{ transactionId: string }>;
}

/**
 * Stand-in charge adapter used until Stripe keys exist. Records nothing
 * externally and always succeeds — the swap point is providerFor() below,
 * which selects a real Stripe adapter when STRIPE_SECRET_KEY is set and
 * the stripe package is installed.
 */
@Injectable()
export class StubBillingProvider implements BillingProvider {
  readonly name = 'stub';

  async charge(input: ChargeInput): Promise<{ transactionId: string }> {
    if (input.amount <= 0) throw new Error('Charge amount must be positive');
    return { transactionId: `stub_${randomUUID().replace(/-/g, '').slice(0, 24)}` };
  }
}

export function providerFor(): 'stub' {
  if (process.env.STRIPE_SECRET_KEY) {
    // Real adapter not vendored yet — fail loud, never silently use test charges.
    throw new Error(
      'STRIPE_SECRET_KEY is set but no Stripe adapter is installed; refusing to bill',
    );
  }
  return 'stub';
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

export function provideBillingProvider() {
  return {
    provide: BILLING_PROVIDER,
    useFactory: () => {
      providerFor();
      return new StubBillingProvider();
    },
  };
}
