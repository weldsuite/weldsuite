import { describe, it, expect } from 'vitest';
import { PLAN_FEATURES, formatPlanFeatures, resolvePlanKey } from './plan-features';

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
