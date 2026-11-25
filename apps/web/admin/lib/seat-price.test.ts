import { describe, expect, it } from 'vitest';
import type { MollieBillingAccount, WorkspaceBilling } from './billing-types';
import {
  MAX_SEAT_PRICE_CENTS,
  canAdjustSeatPrice,
  formatOffList,
  listSeatPrice,
  offList,
  seatPriceProblem,
  seatPriceRefusal,
  typedSeatPriceProblem,
  type SeatPriceState,
} from './seat-price';

const plan = (slug: string, priceMonthly: string, priceYearly: string, currency = 'EUR') => ({
  slug,
  priceMonthly,
  priceYearly,
  currency,
});

describe('listSeatPrice', () => {
  // The same cases as core-billing's plans.rs `eu_prices_follow_the_rows`.
  it('reads the plan as the Rust billing does', () => {
    const starter = plan('starter', '12.00', '120.00');
    expect(listSeatPrice(starter, 'monthly')).toBe(1200);
    expect(listSeatPrice(starter, 'yearly')).toBe(12_000);
    expect(listSeatPrice(plan('business', '25.00', '0'), 'yearly')).toBe(30_000);
    expect(listSeatPrice(plan('business', '25.00', '0'), null)).toBe(2500);
  });

  it('has none for Free, an unpriced plan, another currency or no plan', () => {
    expect(listSeatPrice(plan('free', '0', '0'), 'monthly')).toBeNull();
    expect(listSeatPrice(plan('enterprise', '0', '0'), 'monthly')).toBeNull();
    expect(listSeatPrice(plan('pro', '25.00', '0', 'USD'), 'monthly')).toBeNull();
    expect(listSeatPrice(null, 'monthly')).toBeNull();
  });
});

describe('seatPriceRefusal', () => {
  const now = new Date('2026-12-01T12:00:00Z');
  const running: SeatPriceState = {
    workspace: {
      planId: 'plan_business',
      subscriptionStatus: 'active',
      subscriptionCurrentPeriodEnd: new Date('2026-12-14T10:00:00Z'),
      deletedAt: null,
    },
    account: { unitAmount: 2500, currency: 'EUR', nextChargeAt: new Date('2026-12-14T10:00:00Z') },
  };
  const workspace = running.workspace!;
  const account = running.account!;

  it('allows a running subscription on Mollie, past due included', () => {
    expect(seatPriceRefusal(running, now)).toBeNull();
    expect(seatPriceRefusal({ ...running, workspace: { ...workspace, subscriptionStatus: 'past_due' } }, now)).toBeNull();
  });

  it('refuses a workspace that is gone', () => {
    expect(seatPriceRefusal({ ...running, workspace: null }, now)).toBe('not_found');
    expect(seatPriceRefusal({ ...running, workspace: { ...workspace, deletedAt: now } }, now)).toBe('not_found');
  });

  it('refuses without a running subscription to reprice', () => {
    const cases: SeatPriceState[] = [
      { ...running, account: null },
      { ...running, account: { ...account, unitAmount: null } },
      { ...running, account: { ...account, nextChargeAt: null } },
      { ...running, workspace: { ...workspace, planId: null } },
      { ...running, workspace: { ...workspace, subscriptionStatus: 'canceled' } },
      { ...running, workspace: { ...workspace, subscriptionCurrentPeriodEnd: new Date('2026-11-30T00:00:00Z') } },
    ];
    for (const state of cases) expect(seatPriceRefusal(state, now)).toBe('no_subscription');
  });

  it('refuses an account in another currency', () => {
    expect(seatPriceRefusal({ ...running, account: { ...account, currency: 'USD' } }, now)).toBe('not_eur');
  });

  it('is what the card offers', () => {
    const mollie = { unitAmount: 2500, currency: 'EUR', nextChargeAt: '2026-12-14T10:00:00.000Z' } as MollieBillingAccount;
    const billing = {
      planId: 'plan_business',
      subscriptionStatus: 'active',
      currentPeriodEnd: '2026-12-14T10:00:00.000Z',
    } as WorkspaceBilling;
    expect(canAdjustSeatPrice(mollie, billing, now)).toBe(true);
    expect(canAdjustSeatPrice({ ...mollie, unitAmount: null }, billing, now)).toBe(false);
    expect(canAdjustSeatPrice(mollie, { ...billing, subscriptionStatus: 'canceled' }, now)).toBe(false);
  });
});

describe('seatPriceProblem', () => {
  it('takes a whole number of cents from zero up to the maximum', () => {
    expect(seatPriceProblem(2000, 2500)).toBeNull();
    expect(seatPriceProblem(0, 2500)).toBeNull();
    expect(seatPriceProblem(MAX_SEAT_PRICE_CENTS, 2500)).toBeNull();
    expect(seatPriceProblem(MAX_SEAT_PRICE_CENTS + 1, 2500)).toBe('too_high');
    expect(seatPriceProblem(-1, 2500)).toBe('format');
    expect(seatPriceProblem(-100, 2500)).toBe('format');
    expect(seatPriceProblem(19.5, 2500)).toBe('format');
    expect(seatPriceProblem(null, 2500)).toBe('format');
  });

  it('refuses the price the workspace already pays, free seats included', () => {
    expect(seatPriceProblem(2500, 2500)).toBe('unchanged');
    expect(seatPriceProblem(0, 0)).toBe('unchanged');
  });

  it('reads what staff type', () => {
    expect(typedSeatPriceProblem('20', 2500)).toBeNull();
    expect(typedSeatPriceProblem('19,50', 2500)).toBeNull();
    expect(typedSeatPriceProblem('25.00', 2500)).toBe('unchanged');
    expect(typedSeatPriceProblem('€20', 2500)).toBe('format');
    expect(typedSeatPriceProblem('0', 2500)).toBeNull();
    expect(typedSeatPriceProblem('0,00', 2500)).toBeNull();
    expect(typedSeatPriceProblem('-5', 2500)).toBe('format');
  });
});

describe('offList', () => {
  it('is the share below (positive) or above (negative) the list price', () => {
    expect(offList(2000, 2500)).toBeCloseTo(0.2);
    expect(offList(2750, 2500)).toBeCloseTo(-0.1);
    expect(formatOffList(0.2)).toBe('20%');
    expect(formatOffList(-0.125)).toBe('12.5%');
    expect(formatOffList(1 / 3)).toBe('33.3%');
  });

  it('is null at the list price or without one', () => {
    expect(offList(2500, 2500)).toBeNull();
    expect(offList(2500, null)).toBeNull();
    expect(offList(null, 2500)).toBeNull();
  });
});
