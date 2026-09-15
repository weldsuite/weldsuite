import { describe, expect, it } from 'vitest';
import {
  catalogNumberTypeFromTelnyx,
  medianMonthlyCost,
  monthlyCostsFromAvailable,
  parseCoverageMap,
  seedCombosFromCoverage,
} from './phone-pricing-seed';

describe('catalogNumberTypeFromTelnyx', () => {
  it('maps Telnyx types onto catalog types', () => {
    expect(catalogNumberTypeFromTelnyx('local')).toBe('local');
    expect(catalogNumberTypeFromTelnyx('toll_free')).toBe('toll-free');
    expect(catalogNumberTypeFromTelnyx('mobile')).toBe('mobile');
    expect(catalogNumberTypeFromTelnyx('national')).toBeNull();
  });
});

describe('medianMonthlyCost', () => {
  it('returns the middle value', () => {
    expect(medianMonthlyCost([1, 9, 3])).toBe('3.00');
  });

  it('averages the two middle values', () => {
    expect(medianMonthlyCost([2, 4])).toBe('3.00');
  });

  it('ignores zeros and empties', () => {
    expect(medianMonthlyCost([0, -1])).toBeNull();
  });
});

describe('seedCombosFromCoverage', () => {
  it('keeps only types Telnyx lists for that country', () => {
    const coverage = parseCoverageMap({
      Netherlands: { code: 'NL', numbers: true, phone_number_type: ['local', 'mobile'] },
    });
    const combos = seedCombosFromCoverage(coverage, ['NL']);
    expect(combos.map((c) => c.numberType).sort()).toEqual(['local', 'mobile']);
  });

  it('falls back to all catalog types when coverage is missing', () => {
    const combos = seedCombosFromCoverage(new Map(), ['NL']);
    expect(combos.map((c) => c.numberType)).toEqual(['local', 'toll-free', 'mobile']);
  });

  it('skips countries Telnyx reports as uncovered', () => {
    const coverage = parseCoverageMap({
      Nowhere: { code: 'XX', numbers: false, phone_number_type: [] },
    });
    expect(seedCombosFromCoverage(coverage, ['XX'])).toEqual([]);
  });
});

describe('monthlyCostsFromAvailable', () => {
  it('collects monthly costs and currency', () => {
    const { costs, currency } = monthlyCostsFromAvailable([
      { cost_information: { monthly_cost: '2.00', currency: 'EUR' } },
      { cost_information: { monthly_cost: '4.00', currency: 'EUR' } },
      { cost_information: { monthly_cost: '0' } },
    ]);
    expect(costs).toEqual([2, 4]);
    expect(currency).toBe('EUR');
  });
});
