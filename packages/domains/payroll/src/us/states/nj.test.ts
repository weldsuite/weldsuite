import { describe, expect, it } from 'vitest';
import { roundHalfAwayFromZero } from '../../money';
import { NJ_MODULE, njWithholding } from './nj';
import { certificate, stateInput } from './test-input';

const nj = (overrides: Parameters<typeof stateInput>[1]) => NJ_MODULE.calculate(stateInput('NJ', overrides));
const weekly = (dollars: number, rate: 'A' | 'B', allowances: number) => roundHalfAwayFromZero(njWithholding(dollars * 100, rate, 'weekly', allowances));

describe('New Jersey percentage method — NJ-WT (September 2025) examples, p. 25', () => {
  it('Rate A, weekly, 1 allowance: $300 → $4.21, $700 → $11.84', () => {
    expect(weekly(300, 'A', 1)).toBe(421);
    expect(weekly(700, 'A', 1)).toBe(1184);
  });

  it('Rate A, weekly $1,200, 1 allowance → $40.41 on the current table (the example uses the older $15.28 base: $40.40)', () => {
    expect(weekly(1200, 'A', 1)).toBe(4041);
  });

  it('Rate B, weekly, 3 allowances: $375 → $4.76', () => {
    expect(weekly(375, 'B', 3)).toBe(476);
  });

  it('Rate B, weekly, 3 allowances: $950 → $15.92 and $1,400 → $27.58 on the current table (the example prints $15.93 / $27.60 from older brackets)', () => {
    expect(weekly(950, 'B', 3)).toBe(1592);
    expect(weekly(1400, 'B', 3)).toBe(2758);
  });
});

describe('New Jersey module', () => {
  it('picks Rate B for married filing jointly, and the NJ-W4 line 3 letter when given', () => {
    const joint = nj({ periodsPerYear: 52, regularWagesCents: 95000, certificate: certificate({ filingStatus: 'married_joint', allowances: 3 }) });
    expect(joint.incomeTaxCents).toBe(1592);
    const chosen = nj({ periodsPerYear: 52, regularWagesCents: 95000, certificate: certificate({ filingStatus: 'married_joint', allowances: 3, values: { rate_table: 'A' } }) });
    expect(chosen.incomeTaxCents).toBe(roundHalfAwayFromZero(njWithholding(95000, 'A', 'weekly', 3)));
  });

  it('takes worker UI/WF/SWF, TDI and FLI, and employer UI, WF/SWF and TDI', () => {
    const r = nj({ periodsPerYear: 52, regularWagesCents: 100000, suiRatePercent: 2.8, extraRates: { nj_employer_tdi: 0.5 }, certificate: certificate({ filingStatus: 'single' }) });
    expect(r.sui).toEqual({ taxableWagesCents: 100000, grossWagesCents: 100000, employerCents: 2683, employeeCents: 425 });
    expect(r.programs.find((p) => p.code === 'nj_wf_swf')?.employerCents).toBe(118);
    expect(r.programs.find((p) => p.code === 'nj_tdi')).toMatchObject({ employeeCents: 190, employerCents: 0 });
    expect(r.programs.find((p) => p.code === 'nj_fli')).toMatchObject({ employeeCents: 230, employerCents: 0 });
    expect(r.programs.find((p) => p.code === 'nj_tdi_employer')).toMatchObject({ employeeCents: 0, employerCents: 500 });
    expect(r.issues).toEqual([]);
  });

  it('stops UI/WF/SWF and employer TDI at $44,800 and worker TDI/FLI at $171,100', () => {
    const r = nj({
      periodsPerYear: 12,
      regularWagesCents: 2000000,
      certificate: certificate({ filingStatus: 'single' }),
      extraRates: { nj_employer_tdi: 0.5 },
      ytd: { 'us.state.NJ.sui_wages': 4450000, 'us.state.NJ.nj_tdi_employer_wages': 4450000, 'us.state.NJ.nj_tdi_wages': 17000000, 'us.state.NJ.nj_fli_wages': 17000000 },
    });
    expect(r.sui.taxableWagesCents).toBe(30000);
    expect(r.sui.employeeCents).toBe(128);
    expect(r.programs.find((p) => p.code === 'nj_tdi')).toMatchObject({ wagesCents: 110000, employeeCents: 209 });
    expect(r.programs.find((p) => p.code === 'nj_fli')?.employeeCents).toBe(253);
    expect(r.programs.find((p) => p.code === 'nj_tdi_employer')?.employerCents).toBe(150);
  });

  it('takes 401(k) but not Section 125 off NJ wages; UI wages keep both', () => {
    const r = nj({
      periodsPerYear: 26,
      regularWagesCents: 300000,
      pretax: { retirement401kCents: 20000, section125Cents: 10000, hsaCents: 5000, dependentCareCents: 5000 },
      certificate: certificate({ filingStatus: 'single' }),
    });
    expect(r.stateWagesCents).toBe(280000);
    expect(r.sui.grossWagesCents).toBe(300000);
  });

  it('withholds nothing for a Pennsylvania resident with an NJ-165, and says the residence differs', () => {
    const r = nj({ periodsPerYear: 52, regularWagesCents: 100000, residenceState: 'PA', certificate: certificate({ filingStatus: 'single', values: { nj165_pa_resident: true } }) });
    expect(r.incomeTaxCents).toBe(0);
    expect(r.issues).toContainEqual({ severity: 'warning', code: 'residence_state_differs', params: { state: 'NJ', residenceState: 'PA' } });
    expect(r.programs.find((p) => p.code === 'nj_fli')?.employeeCents).toBe(230);
  });

  it('flags Rate A without allowances as provisional when there is no NJ-W4, and the employer TDI rate as missing', () => {
    const r = nj({ periodsPerYear: 52, regularWagesCents: 30000 });
    expect(r.incomeTaxCents).toBe(450);
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'provisional_rules', params: expect.objectContaining({ state: 'NJ' }) }),
        expect.objectContaining({ code: 'employer_incomplete', params: expect.objectContaining({ field: 'nj_employer_tdi' }) }),
      ]),
    );
  });

  it('withholds supplemental pay alone without allowances', () => {
    const r = nj({ periodsPerYear: 52, supplementalWagesCents: 100000, certificate: certificate({ filingStatus: 'single', allowances: 5 }) });
    expect(r.incomeTaxCents).toBe(roundHalfAwayFromZero(njWithholding(100000, 'A', 'weekly', 0)));
  });
});
