import { describe, it, expect } from 'vitest';
import {
  PLAN_FEATURES,
  annualSavingPercent,
  annualSavingSummary,
  fillTemplate,
  formatPlanFeatures,
  planCardFeatures,
  planSeatCell,
  planSeatLimit,
  planSeatLine,
  resolvePlanKey,
} from './plan-features';

describe('formatPlanFeatures', () => {
  it('keys the feature list by slug', () => {
    expect(formatPlanFeatures({ slug: 'business', name: 'Business Plan' })).toEqual(PLAN_FEATURES.business);
    expect(formatPlanFeatures({ slug: 'scale', name: 'Scale (Annual)' })).toEqual(PLAN_FEATURES.scale);
  });

  it('falls back to the lowercased name when the slug is unknown', () => {
    expect(formatPlanFeatures({ slug: 'legacy-scale', name: 'Scale' })).toEqual(PLAN_FEATURES.scale);
  });

  it('returns an empty list for an unknown plan', () => {
    expect(formatPlanFeatures({ slug: 'mystery', name: 'Mystery' })).toEqual([]);
  });
});

describe('resolvePlanKey', () => {
  it('prefers the slug when the table has a column for it', () => {
    const row = { free: true, business: false };
    expect(resolvePlanKey({ slug: 'business', name: 'Business Plan' }, row)).toBe('business');
    expect(resolvePlanKey({ slug: 'other', name: 'Free' }, row)).toBe('free');
  });
});

const copy = {
  seatsOne: '1 user',
  seatsUpTo: 'Up to {count} users',
  seatsUnlimited: 'Unlimited users',
  seatsCustom: 'Custom seat limit',
  allAppsIncluded: 'All apps included (calls billed separately)',
};

describe('planSeatLimit / planSeatLine', () => {
  it('follows the enforced member cap (plans.max_users)', () => {
    expect(planSeatLimit({ slug: 'free', maxMembers: 1 })).toEqual({ kind: 'exact', count: 1 });
    expect(planSeatLimit({ slug: 'business', maxMembers: 10 })).toEqual({ kind: 'upTo', count: 10 });
    expect(planSeatLimit({ slug: 'scale', maxMembers: undefined })).toEqual({ kind: 'unlimited' });
    expect(planSeatLimit({ slug: 'enterprise', maxMembers: undefined })).toEqual({ kind: 'custom' });
  });

  it('words the seat line from the cap, not from copy written by hand', () => {
    expect(planSeatLine({ slug: 'free', maxMembers: 1 }, copy)).toBe('1 user');
    expect(planSeatLine({ slug: 'business', maxMembers: 10 }, copy)).toBe('Up to 10 users');
    expect(planSeatLine({ slug: 'business', maxMembers: 25 }, copy)).toBe('Up to 25 users');
    expect(planSeatLine({ slug: 'scale', maxMembers: undefined }, copy)).toBe('Unlimited users');
  });

  it('fills the comparison table cell', () => {
    const cell = { seatsOne: '1', seatsUpTo: 'Up to {count}', unlimited: 'Unlimited', custom: 'Custom' };
    expect(planSeatCell({ slug: 'free', maxMembers: 1 }, cell)).toBe('1');
    expect(planSeatCell({ slug: 'business', maxMembers: 10 }, cell)).toBe('Up to 10');
    expect(planSeatCell({ slug: 'enterprise', maxMembers: undefined }, cell)).toBe('Custom');
  });
});

describe('planCardFeatures', () => {
  it('leads with the seat line and only Free claims all apps', () => {
    const free = planCardFeatures({ slug: 'free', name: 'Free', maxMembers: 1 }, copy);
    expect(free.slice(0, 2)).toEqual(['1 user', copy.allAppsIncluded]);
    expect(free).not.toContain('Two-factor authentication');
    const business = planCardFeatures({ slug: 'business', name: 'Business', maxMembers: 10 }, copy);
    expect(business[0]).toBe('Up to 10 users');
    expect(business).not.toContain(copy.allAppsIncluded);
  });
});

describe('annual saving', () => {
  const business = { monthlyPrice: 4000, yearlyPrice: 42000 };
  const scale = { monthlyPrice: 7000, yearlyPrice: 72000 };

  it('is computed from the real monthly and annual prices', () => {
    expect(annualSavingPercent(business)).toBe(13); // $40 -> $35 per month, 12.5%
    expect(annualSavingPercent(scale)).toBe(14); // $70 -> $60 per month, 14.3%
  });

  it('is zero for free, on-request and unpriced-annual plans', () => {
    expect(annualSavingPercent({ monthlyPrice: 0, yearlyPrice: 0 })).toBe(0);
    expect(annualSavingPercent({ monthlyPrice: 4000, yearlyPrice: 0 })).toBe(0);
    expect(annualSavingPercent({ monthlyPrice: 0, yearlyPrice: 0, priceOnRequest: true })).toBe(0);
  });

  it('advertises "up to" the largest saving when the plans differ', () => {
    expect(annualSavingSummary([{ monthlyPrice: 0, yearlyPrice: 0 }, business, scale])).toEqual({ percent: 14, isRange: true });
    expect(annualSavingSummary([scale, scale])).toEqual({ percent: 14, isRange: false });
    expect(annualSavingSummary([{ monthlyPrice: 0, yearlyPrice: 0 }])).toEqual({ percent: 0, isRange: false });
  });
});

describe('fillTemplate', () => {
  it('replaces known placeholders and leaves unknown ones', () => {
    expect(fillTemplate('Up to {count} users', { count: 10 })).toBe('Up to 10 users');
    expect(fillTemplate('{a} {b}', { a: 1 })).toBe('1 {b}');
  });
});
