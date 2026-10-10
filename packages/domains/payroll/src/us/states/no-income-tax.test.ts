import { describe, expect, it } from 'vitest';
import { AK_MODULE } from './ak';
import { FL_MODULE } from './fl';
import { NH_MODULE } from './nh';
import { NV_MODULE } from './nv';
import { SD_MODULE } from './sd';
import { TN_MODULE } from './tn';
import { TX_MODULE } from './tx';
import { stateInput } from './test-input';
import type { StateModule } from './types';

const run = (module: StateModule, overrides: Parameters<typeof stateInput>[1]) => module.calculate(stateInput(module.code, overrides));

describe('states without a wage income tax', () => {
  it.each([
    [FL_MODULE, 700000, 2.7],
    [TN_MODULE, 700000, 2.7],
    [TX_MODULE, 900000, 2.7],
    [NV_MODULE, 4370000, 2.95],
    [NH_MODULE, 1400000, 1.7],
    [SD_MODULE, 1500000, 1.2],
    [AK_MODULE, 5420000, 1.0],
  ] as const)('%s: no income tax, SUI up to the 2026 wage base at the new-employer rate', (module, baseCents, newRate) => {
    const below = run(module, { periodsPerYear: 12, regularWagesCents: 500000, suiRatePercent: null, payDate: '2026-03-31' });
    expect(below.incomeTaxCents).toBe(0);
    expect(below.stateWagesCents).toBe(0);
    expect(below.sui.employerCents).toBe(Math.round(500000 * newRate) / 100);
    expect(below.issues).toContainEqual(expect.objectContaining({ code: 'employer_incomplete', params: expect.objectContaining({ state: module.code }) }));
    expect(module.certificate).toBeNull();
    expect(module.hasIncomeTax).toBe(false);

    const atBase = run(module, { periodsPerYear: 12, regularWagesCents: 500000, ytd: { [`us.state.${module.code}.sui_wages`]: baseCents - 100000 } });
    expect(atBase.sui.taxableWagesCents).toBe(100000);
    expect(atBase.sui.grossWagesCents).toBe(500000);
    expect(atBase.ytdUpdates[`us.state.${module.code}.sui_wages`]).toBe(baseCents);
  });

  it('Alaska takes the 0.5% employee share on the same $54,200 base', () => {
    const r = run(AK_MODULE, { periodsPerYear: 12, regularWagesCents: 500000, ytd: { 'us.state.AK.sui_wages': 5170000 } });
    expect(r.sui).toEqual({ taxableWagesCents: 250000, grossWagesCents: 500000, employerCents: 5000, employeeCents: 1250 });
  });

  it('Nevada adds the 0.05% Career Enhancement Program, except at the 5.4% rate', () => {
    const r = run(NV_MODULE, { periodsPerYear: 12, regularWagesCents: 500000, suiRatePercent: 2.95 });
    expect(r.programs).toEqual([{ code: 'nv_cep', labelKey: 'us.state_program.nv_cep', wagesCents: 500000, employeeCents: 0, employerCents: 250 }]);
    expect(run(NV_MODULE, { periodsPerYear: 12, regularWagesCents: 500000, suiRatePercent: 5.4 }).programs[0]!.employerCents).toBe(0);
  });

  it('South Dakota adds the 0.55% investment fee, and the 0.08% administrative fee once experience rated', () => {
    const fresh = run(SD_MODULE, { periodsPerYear: 12, regularWagesCents: 500000, suiRatePercent: null });
    expect(fresh.programs.map((p) => [p.code, p.employerCents])).toEqual([['sd_investment_fee', 2750], ['sd_admin_fee', 0]]);
    const rated = run(SD_MODULE, { periodsPerYear: 12, regularWagesCents: 500000, suiRatePercent: 0.5, extraRates: { sd_investment_fee: 0.2 } });
    expect(rated.programs.map((p) => [p.code, p.employerCents])).toEqual([['sd_investment_fee', 1000], ['sd_admin_fee', 400]]);
  });

  it('New Hampshire flags the new-employer fallback as provisional after the second quarter of 2026', () => {
    expect(run(NH_MODULE, { payDate: '2026-06-30', regularWagesCents: 100000, suiRatePercent: null }).issues.map((i) => i.code)).not.toContain('provisional_rules');
    expect(run(NH_MODULE, { payDate: '2026-07-15', regularWagesCents: 100000, suiRatePercent: null }).issues.map((i) => i.code)).toContain('provisional_rules');
    expect(run(NH_MODULE, { payDate: '2026-07-15', regularWagesCents: 100000, suiRatePercent: 1.2 }).issues).toEqual([]);
  });

  it('leaves Section 125 out of SUI wages but keeps 401(k) in', () => {
    const r = run(FL_MODULE, { periodsPerYear: 26, regularWagesCents: 200000, pretax: { retirement401kCents: 20000, section125Cents: 10000, hsaCents: 0, dependentCareCents: 0 } });
    expect(r.sui.grossWagesCents).toBe(190000);
  });

  it('refuses other years and warns about another residence state', () => {
    expect(run(TX_MODULE, { taxYear: 2025 }).issues[0]).toMatchObject({ severity: 'error', code: 'unsupported_tax_year' });
    expect(run(TX_MODULE, { residenceState: 'ok', regularWagesCents: 1000 }).issues).toContainEqual({ severity: 'warning', code: 'residence_state_differs', params: { state: 'TX', residenceState: 'OK' } });
  });
});
