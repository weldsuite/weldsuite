import { describe, expect, it } from 'vitest';
import { NC_MODULE, ncWithholding } from './nc';
import { certificate, stateInput } from './test-input';

const nc = (overrides: Parameters<typeof stateInput>[1]) => NC_MODULE.calculate(stateInput('NC', overrides));

describe('North Carolina — NC-30 (2026) examples', () => {
  it('percentage method: weekly $450, single, 2 allowances — $4.00', () => {
    // 450 − 245.19 − 96.16 = 108.65 × 0.0409 = 4.44 → nearest whole dollar.
    expect(ncWithholding(45000, 'single', 2, 52)).toBe(400);
  });

  it('annualized method: same employee — $231.09 a year, $4.00 a week', () => {
    // A quarterly payroll has no per-period table, so it takes the annualized route: (23,400 − 12,750 − 5,000) × 4.09% = 231.09.
    expect(ncWithholding(585000, 'single', 2, 4)).toBe(Math.round(23109 / 4 / 100) * 100);
  });
});

describe('North Carolina module', () => {
  it('runs the example, uses the head-of-household deduction, and adds the NC-4 line 2 amount', () => {
    expect(nc({ periodsPerYear: 52, regularWagesCents: 45000, certificate: certificate({ filingStatus: 'single', allowances: 2 }) }).incomeTaxCents).toBe(400);
    // Monthly $4,000, head of household, 0 allowances: (4,000 − 1,593.75) × 4.09% = 98.42 → $98.
    expect(nc({ periodsPerYear: 12, regularWagesCents: 400000, certificate: certificate({ filingStatus: 'head_of_household', extraWithholding: 10 }) }).incomeTaxCents).toBe(9800 + 1000);
  });

  it('withholds as single with no allowances without an NC-4; supplemental pay at a flat 4.09%', () => {
    const r = nc({ periodsPerYear: 12, regularWagesCents: 400000, supplementalWagesCents: 100000 });
    // (4,000 − 1,062.50) × 4.09% = 120.14 → $120, plus 4.09% of $1,000.
    expect(r.incomeTaxCents).toBe(12000 + 4090);
  });

  it('applies the $34,200 UI wage base with the 1% beginning rate', () => {
    const r = nc({ periodsPerYear: 12, regularWagesCents: 500000, suiRatePercent: null, ytd: { 'us.state.NC.sui_wages': 3000000 } });
    expect(r.sui.taxableWagesCents).toBe(420000);
    expect(r.sui.employerCents).toBe(4200);
    expect(r.ruleSet).toBe('us-nc-2026.1');
  });
});
