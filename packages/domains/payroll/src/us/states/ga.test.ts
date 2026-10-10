import { describe, expect, it } from 'vitest';
import { GA_MODULE } from './ga';
import { certificate, stateInput } from './test-input';

const ga = (overrides: Parameters<typeof stateInput>[1]) => GA_MODULE.calculate(stateInput('GA', overrides));

describe('Georgia percentage method — Employer’s Tax Guide 2026 examples', () => {
  it('September 2026 guide, example 1: married (spouse not working), semi-monthly $2,000, 1 dependent — $27.03', () => {
    const r = ga({ payDate: '2026-06-15', periodsPerYear: 24, regularWagesCents: 200000, certificate: certificate({ filingStatus: 'married_one_working', values: { dependent_allowances: 1 } }) });
    expect(r.incomeTaxCents).toBe(2703);
  });

  it('September 2026 guide, example 2: head of household, bi-weekly $935, 2 dependents — $0.00', () => {
    const r = ga({ payDate: '2026-06-12', periodsPerYear: 26, regularWagesCents: 93500, certificate: certificate({ filingStatus: 'head_of_household', values: { dependent_allowances: 2 } }) });
    expect(r.incomeTaxCents).toBe(0);
  });

  it('December 2025 guide (before HB 463), example: married, semi-monthly $1,470.83, 1 dependent — $15.79 at 5.19%', () => {
    const r = ga({ payDate: '2026-03-13', periodsPerYear: 24, regularWagesCents: 147083, certificate: certificate({ filingStatus: 'married_one_working', values: { dependent_allowances: 1 } }) });
    expect(r.incomeTaxCents).toBe(1579);
  });
});

describe('Georgia module', () => {
  it('switches to 4.99% and the new deductions for pay dates from 11 May 2026, for supplemental pay too', () => {
    const before = ga({ payDate: '2026-05-08', periodsPerYear: 12, regularWagesCents: 500000, supplementalWagesCents: 100000 });
    const after = ga({ payDate: '2026-05-11', periodsPerYear: 12, regularWagesCents: 500000, supplementalWagesCents: 100000 });
    // Single, no G-4: (5,000 − 1,000) × 5.19% + 1,000 × 5.19%, then (5,000 − 1,250) × 4.99% + 1,000 × 4.99%.
    expect(before.incomeTaxCents).toBe(20760 + 5190);
    expect(after.incomeTaxCents).toBe(18713 + 4990);
  });

  it('adds Georgia adjustments allowances to dependent allowances and the line 6 extra amount; withholds nothing when exempt', () => {
    const r = ga({ payDate: '2026-07-15', periodsPerYear: 12, regularWagesCents: 500000, certificate: certificate({ filingStatus: 'single', values: { dependent_allowances: 1, adjustment_allowances: 1 }, extraWithholding: 20 }) });
    expect(r.incomeTaxCents).toBe(Math.round((500000 - 125000 - 2 * 41667) * 0.0499) + 2000);
    expect(ga({ periodsPerYear: 12, regularWagesCents: 500000, certificate: certificate({ exempt: true }) }).incomeTaxCents).toBe(0);
  });

  it('applies the $9,500 UI wage base and the 0.06% administrative assessment', () => {
    const r = ga({ periodsPerYear: 12, regularWagesCents: 500000, suiRatePercent: null, ytd: { 'us.state.GA.sui_wages': 600000 } });
    expect(r.sui.taxableWagesCents).toBe(350000);
    expect(r.sui.employerCents).toBe(9240);
    expect(r.programs.find((p) => p.code === 'ga_admin_assessment')?.employerCents).toBe(210);
    expect(r.ruleSet).toBe('us-ga-2026.2');
  });
});
