import { describe, expect, it } from 'vitest';
import { IL_MODULE, ilWithholding } from './il';
import { certificate, stateInput } from './test-input';

const il = (overrides: Parameters<typeof stateInput>[1]) => IL_MODULE.calculate(stateInput('IL', overrides));

describe('Illinois — IL-700-T (R-12/25) automated payroll method', () => {
  it('example: $800 weekly, 2 basic and 2 additional allowances — $32.13', () => {
    expect(ilWithholding(80000, 2, 2, 52)).toBe(3213);
  });

  it('runs the example through the module, with the IL-W-4 line 3 extra amount', () => {
    const r = il({ periodsPerYear: 52, regularWagesCents: 80000, certificate: certificate({ allowances: 2, values: { additional_allowances: 2 }, extraWithholding: 5 }) });
    expect(r.incomeTaxCents).toBe(3213 + 500);
    expect(r.ruleSet).toBe('us-il-2026.1');
  });

  it('withholds with no allowances without an IL-W-4, and 4.95% flat on supplemental pay', () => {
    expect(il({ periodsPerYear: 26, regularWagesCents: 200000 }).incomeTaxCents).toBe(9900);
    expect(il({ periodsPerYear: 26, regularWagesCents: 200000, supplementalWagesCents: 100000 }).incomeTaxCents).toBe(9900 + 4950);
  });

  it('excludes 401(k) and Section 125 from IL wages; UI keeps 401(k) and stops at $14,250', () => {
    const r = il({
      periodsPerYear: 12,
      regularWagesCents: 1000000,
      pretax: { retirement401kCents: 100000, section125Cents: 50000, hsaCents: 0, dependentCareCents: 0 },
      ytd: { 'us.state.IL.sui_wages': 1000000 },
      suiRatePercent: null,
    });
    expect(r.stateWagesCents).toBe(850000);
    expect(r.sui.grossWagesCents).toBe(950000);
    expect(r.sui.taxableWagesCents).toBe(425000);
    expect(r.sui.employerCents).toBe(14238);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'employer_incomplete' }));
  });
});
