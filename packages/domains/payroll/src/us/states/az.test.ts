import { describe, expect, it } from 'vitest';
import { AZ_MODULE } from './az';
import { certificate, stateInput } from './test-input';

const az = (overrides: Parameters<typeof stateInput>[1]) => AZ_MODULE.calculate(stateInput('AZ', overrides));

describe('Arizona', () => {
  it('withholds the elected A-4 percentage of gross taxable wages (W-2 box 1), supplemental pay included, plus the extra amount', () => {
    const r = az({
      periodsPerYear: 26,
      regularWagesCents: 300000,
      supplementalWagesCents: 100000,
      pretax: { retirement401kCents: 20000, section125Cents: 10000, hsaCents: 0, dependentCareCents: 0 },
      certificate: certificate({ values: { withholding_percent: '3.5' }, extraWithholding: 5 }),
    });
    expect(r.stateWagesCents).toBe(370000);
    expect(r.incomeTaxCents).toBe(12950 + 500);
  });

  it('withholds the 2.0% default without an A-4, and nothing with the zero election', () => {
    expect(az({ periodsPerYear: 26, regularWagesCents: 300000 }).incomeTaxCents).toBe(6000);
    expect(az({ periodsPerYear: 26, regularWagesCents: 300000, certificate: certificate({ exempt: true }) }).incomeTaxCents).toBe(0);
  });

  it('applies the $8,000 UI wage base at the 2.00% new-employer rate', () => {
    const r = az({ periodsPerYear: 12, regularWagesCents: 500000, suiRatePercent: null, ytd: { 'us.state.AZ.sui_wages': 600000 } });
    expect(r.sui.taxableWagesCents).toBe(200000);
    expect(r.sui.employerCents).toBe(4000);
    expect(r.ruleSet).toBe('us-az-2026.1');
  });
});
