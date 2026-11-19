import { describe, expect, it } from 'vitest';
import {
  countryName,
  formatPlanPrice,
  hasPaidPlan,
  vatOfCents,
  vatRateText,
  type PlanOfSubscription,
} from './plan-pricing';

const starter = (overrides: PlanOfSubscription): PlanOfSubscription => ({
  planId: 'plan_starter',
  planSlug: 'starter',
  status: 'active',
  ...overrides,
});

describe('hasPaidPlan', () => {
  it('reads Mollie’s price per cycle', () => {
    expect(hasPaidPlan(starter({ provider: 'mollie', pricePerCycle: 1200 }))).toBe(true);
    expect(hasPaidPlan(starter({ provider: 'mollie', pricePerCycle: 0 }))).toBe(false);
  });

  it('is false on Mollie without a price: a comp, a trial, a plan in its grace period', () => {
    expect(hasPaidPlan(starter({ provider: 'mollie' }))).toBe(false);
    expect(hasPaidPlan(starter({ provider: 'mollie', status: 'canceled' }))).toBe(false);
  });

  it('falls back to an active or past-due plan on Global', () => {
    expect(hasPaidPlan(starter({}))).toBe(true);
    expect(hasPaidPlan(starter({ status: 'past_due' }))).toBe(true);
    expect(hasPaidPlan(starter({ status: 'trialing' }))).toBe(false);
    expect(hasPaidPlan(starter({ status: 'canceled' }))).toBe(false);
    expect(hasPaidPlan(starter({ planSlug: 'free' }))).toBe(false);
    expect(hasPaidPlan(starter({ planId: null }))).toBe(false);
  });

  it('is false without a subscription', () => {
    expect(hasPaidPlan(null)).toBe(false);
    expect(hasPaidPlan(undefined)).toBe(false);
  });
});

describe('formatPlanPrice', () => {
  it('drops the decimals of a whole amount and keeps two otherwise', () => {
    expect(formatPlanPrice(1200, 'EUR')).toBe('€12');
    expect(formatPlanPrice(1452, 'EUR')).toBe('€14.52');
    expect(formatPlanPrice(4900)).toBe('$49');
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
