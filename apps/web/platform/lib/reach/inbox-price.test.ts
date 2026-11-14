import { describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({ value: 'stripe' as 'stripe' | 'mollie' }));
vi.mock('@/lib/edition', () => ({ billingProvider: () => provider.value }));

import { inboxPrice } from './inbox-price';

describe('inboxPrice', () => {
  it("is Global's Stripe price on its own", () => {
    provider.value = 'stripe';
    expect(inboxPrice()).toEqual({ cents: 800, currency: 'usd', withPlan: false });
  });

  it('is €8.00 on the plan\'s charge where plans are billed through Mollie', () => {
    provider.value = 'mollie';
    expect(inboxPrice()).toEqual({ cents: 800, currency: 'eur', withPlan: true });
  });
});
