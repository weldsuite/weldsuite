import { describe, expect, it } from 'vitest';
import { PA_MODULE } from './pa';
import { certificate, stateInput } from './test-input';

const pa = (overrides: Parameters<typeof stateInput>[1]) => PA_MODULE.calculate(stateInput('PA', overrides));

describe('Pennsylvania', () => {
  it('withholds 3.07% of compensation including 401(k) and dependent care, excluding Section 125 health and HSA', () => {
    const r = pa({
      periodsPerYear: 26,
      regularWagesCents: 300000,
      supplementalWagesCents: 50000,
      pretax: { retirement401kCents: 30000, section125Cents: 10000, hsaCents: 5000, dependentCareCents: 4000 },
    });
    expect(r.stateWagesCents).toBe(335000);
    expect(r.incomeTaxCents).toBe(10285);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'provisional_rules', params: expect.objectContaining({ state: 'PA' }) }));
  });

  it('takes 0.07% employee UC on all wages without a cap, employer UC up to $10,000 (new employer 3.822%)', () => {
    const r = pa({ periodsPerYear: 12, regularWagesCents: 1500000, suiRatePercent: null, ytd: { 'us.state.PA.sui_wages': 900000 } });
    expect(r.sui).toEqual({ taxableWagesCents: 100000, grossWagesCents: 1500000, employerCents: 3822, employeeCents: 1050 });
    expect(r.issues).toEqual([expect.objectContaining({ code: 'employer_incomplete' })]);
  });

  it('withholds nothing with a REV-419 (an NJ resident) and warns about the residence state; UC still applies', () => {
    const r = pa({ periodsPerYear: 52, regularWagesCents: 100000, residenceState: 'NJ', certificate: certificate({ exempt: true }) });
    expect(r.incomeTaxCents).toBe(0);
    expect(r.sui.employeeCents).toBe(70);
    expect(r.issues).toContainEqual({ severity: 'warning', code: 'residence_state_differs', params: { state: 'PA', residenceState: 'NJ' } });
    expect(r.ruleSet).toBe('us-pa-2026.1');
  });
});
