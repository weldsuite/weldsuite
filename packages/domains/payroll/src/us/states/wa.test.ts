import { describe, expect, it } from 'vitest';
import { WA_MODULE } from './wa';
import { certificate, stateInput } from './test-input';

const wa = (overrides: Parameters<typeof stateInput>[1]) => WA_MODULE.calculate(stateInput('WA', overrides));
const program = (r: ReturnType<typeof wa>, code: string) => r.programs.find((p) => p.code === code);

describe('Washington', () => {
  it('splits Paid Leave 1.13%: employee wages × 1.13% × 71.43%, employer the rest; WA Cares 0.58% from the employee', () => {
    const r = wa({ periodsPerYear: 12, regularWagesCents: 1000000, suiRatePercent: 1.0, employeeCountEstimate: 100 });
    expect(program(r, 'wa_pfml')).toMatchObject({ wagesCents: 1000000, employeeCents: 8072, employerCents: 3228 });
    expect(program(r, 'wa_cares')).toMatchObject({ employeeCents: 5800, employerCents: 0 });
    expect(r.sui).toMatchObject({ taxableWagesCents: 1000000, employerCents: 10000, employeeCents: 0 });
    expect(program(r, 'wa_eaf')?.employerCents).toBe(300);
    expect(r.incomeTaxCents).toBe(0);
    expect(r.issues).toEqual([]);
  });

  it('drops the employer Paid Leave share under 50 employees and stops at the $184,500 cap; WA Cares has no cap', () => {
    const small = wa({ periodsPerYear: 12, regularWagesCents: 1000000, employeeCountEstimate: 20 });
    expect(program(small, 'wa_pfml')).toMatchObject({ employeeCents: 8072, employerCents: 0 });
    const capped = wa({ periodsPerYear: 12, regularWagesCents: 1000000, ytd: { 'us.state.WA.wa_pfml_wages': 18000000, 'us.state.WA.wa_cares_wages': 18000000 } });
    expect(program(capped, 'wa_pfml')?.wagesCents).toBe(450000);
    expect(program(capped, 'wa_cares')?.wagesCents).toBe(1000000);
  });

  it('lets the employer pay the employee Paid Leave share', () => {
    const r = wa({ periodsPerYear: 12, regularWagesCents: 1000000, employeeCountEstimate: 100, extraRates: { wa_pfml_employee: 0 } });
    expect(program(r, 'wa_pfml')).toMatchObject({ employeeCents: 0, employerCents: 11300 });
  });

  it('skips WA Cares with an approved exemption', () => {
    const r = wa({ periodsPerYear: 12, regularWagesCents: 1000000, certificate: certificate({ values: { wa_cares_exempt: true } }) });
    expect(program(r, 'wa_cares')?.employeeCents).toBe(0);
  });

  it('applies the $78,200 UI base, and makes a missing UI rate an error (new employers get an industry rate)', () => {
    const r = wa({ periodsPerYear: 12, regularWagesCents: 1000000, suiRatePercent: null, ytd: { 'us.state.WA.sui_wages': 7500000 } });
    expect(r.sui.taxableWagesCents).toBe(320000);
    expect(r.sui.employerCents).toBe(0);
    expect(r.issues).toContainEqual({ severity: 'error', code: 'employer_incomplete', params: { state: 'WA', field: 'suiRate' } });
  });

  it('flags Paid Leave and WA Cares wages as provisional when pre-tax deductions are present', () => {
    const r = wa({ periodsPerYear: 12, regularWagesCents: 1000000, suiRatePercent: 1, pretax: { retirement401kCents: 50000, section125Cents: 0, hsaCents: 0, dependentCareCents: 0 } });
    expect(program(r, 'wa_pfml')?.wagesCents).toBe(1000000);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'provisional_rules', params: expect.objectContaining({ state: 'WA' }) }));
    expect(r.ruleSet).toBe('us-wa-2026.1');
  });
});
