import { describe, expect, it } from 'vitest';
import { Billing } from '@/lib/api/types/apps/billing.types';
import { countryName, hasPaidPlan, vatOfCents, vatRateText } from './plan-pricing';

function subscription(overrides: Partial<Billing.Subscription>): Billing.Subscription {
  return {
    id: 'ws_1',
    planId: 'plan_starter',
    planName: 'Starter',
    planSlug: 'starter',
    status: Billing.SubscriptionStatus.Active,
    cycle: Billing.BillingCycle.Monthly,
    purchasedSeats: 1,
    usedSeats: 1,
    ...overrides,
  } as Billing.Subscription;
}

describe('hasPaidPlan', () => {
  it('reads Mollie’s price per cycle', () => {
    expect(hasPaidPlan(subscription({ pricePerCycle: 1200, currency: 'EUR' }))).toBe(true);
    expect(hasPaidPlan(subscription({ pricePerCycle: 0 }))).toBe(false);
  });

  it('falls back to the plan where the subscription has no price (Global)', () => {
    expect(hasPaidPlan(subscription({}))).toBe(true);
    expect(hasPaidPlan(subscription({ planSlug: 'free' }))).toBe(false);
    expect(hasPaidPlan(subscription({ planId: null as unknown as string }))).toBe(false);
  });

  it('is false without a subscription', () => {
    expect(hasPaidPlan(null)).toBe(false);
    expect(hasPaidPlan(undefined)).toBe(false);
  });
});

describe('vatOfCents', () => {
  it('rounds half up, as the server totals a line', () => {
    expect(vatOfCents(1200, 2100)).toBe(252);
    expect(vatOfCents(3333, 2100)).toBe(700); // 699.93
    expect(vatOfCents(50, 2100)).toBe(11); // 10.5
    expect(vatOfCents(1000, 2550)).toBe(255);
  });

  it('is zero for reverse charge, outside the EU and nothing to charge', () => {
    expect(vatOfCents(1200, 0)).toBe(0);
    expect(vatOfCents(0, 2100)).toBe(0);
  });
});

describe('vatRateText', () => {
  it('drops a whole rate’s decimals and keeps a fraction', () => {
    expect(vatRateText(2100, 'en')).toBe('21');
    expect(vatRateText(2550, 'en')).toBe('25.5');
    expect(vatRateText(2550, 'nl')).toBe('25,5');
  });
});

describe('countryName', () => {
  it('names the country in the UI language', () => {
    expect(countryName('NL', 'en')).toBe('Netherlands');
    expect(countryName('BE', 'nl')).toBe('België');
  });

  it('keeps the code when it cannot be named', () => {
    expect(countryName('not a code', 'en')).toBe('not a code');
  });
});
