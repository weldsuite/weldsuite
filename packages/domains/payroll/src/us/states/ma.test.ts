import { describe, expect, it } from 'vitest';
import { roundHalfAwayFromZero } from '../../money';
import { MA_MODULE, maRegularWithholding, maSupplementalWithholding } from './ma';
import { certificate, stateInput } from './test-input';

const ma = (overrides: Parameters<typeof stateInput>[1]) => MA_MODULE.calculate(stateInput('MA', overrides));

describe('Massachusetts — Circular M (Rev. 12/25) percentage method', () => {
  it('section G example: $350,000 bonus on a $948,000 salary, 1 exemption — $24,854 with the 4% surtax', () => {
    // Annualized regular wages − $2,000 FICA − $4,400 exemption = $941,600; with the bonus $1,291,600.
    expect(maSupplementalWithholding(35000000, 94160000, 0)).toBe(2485400);
  });

  it('withholds 5% of a bonus when the total stays under $1,107,750', () => {
    expect(maSupplementalWithholding(100000, 6000000, 0)).toBe(5000);
  });

  it('regular wages: weekly $1,000, 2 exemptions, $76.50 FICA → $40.98; head of household $2.31 less', () => {
    // (1,000 − 76.50 − (19 × 2 + 66)) × 52 × 5% ÷ 52.
    const base = { period: 'weekly' as const, periodsPerYear: 52, wagesCents: 100000, ficaDeductionCents: 7650, exemptions: 2, headOfHousehold: false, blindCount: 0 };
    expect(roundHalfAwayFromZero(maRegularWithholding(base))).toBe(4098);
    expect(roundHalfAwayFromZero(maRegularWithholding({ ...base, headOfHousehold: true }))).toBe(3867);
    expect(roundHalfAwayFromZero(maRegularWithholding({ ...base, blindCount: 2 }))).toBe(4098 - 424);
  });

  it('applies the 9% rate above $1,107,750 annualized', () => {
    const tax = maRegularWithholding({ period: 'monthly', periodsPerYear: 12, wagesCents: 10000000, ficaDeductionCents: 0, exemptions: 0, headOfHousehold: false, blindCount: 0 });
    expect(roundHalfAwayFromZero(tax)).toBe(530750);
  });

  it('does not withhold below the low-wage threshold when an exemption is claimed', () => {
    expect(maRegularWithholding({ period: 'weekly', periodsPerYear: 52, wagesCents: 15000, ficaDeductionCents: 0, exemptions: 1, headOfHousehold: false, blindCount: 0 })).toBe(0);
  });
});

describe('Massachusetts module', () => {
  it('subtracts FICA up to $2,000 a year (passed in or estimated at 7.65%)', () => {
    const passed = ma({ periodsPerYear: 52, regularWagesCents: 100000, ficaEmployeeCents: 7650, certificate: certificate({ allowances: 2 }) });
    expect(passed.incomeTaxCents).toBe(4098);
    expect(passed.ytdUpdates['us.state.MA.fica_deduction']).toBe(7650);
    const estimated = ma({ periodsPerYear: 52, regularWagesCents: 100000, certificate: certificate({ allowances: 2 }) });
    expect(estimated.incomeTaxCents).toBe(4098);
    const nearCap = ma({ periodsPerYear: 52, regularWagesCents: 100000, ficaEmployeeCents: 7650, ytd: { 'us.state.MA.fica_deduction': 199000 }, certificate: certificate({ allowances: 2 }) });
    expect(nearCap.ytdUpdates['us.state.MA.fica_deduction']).toBe(200000);
  });

  it('withholds nothing for a full-time student (M-4 line D), with no exemptions without an M-4, plus line 5', () => {
    expect(ma({ periodsPerYear: 52, regularWagesCents: 100000, certificate: certificate({ allowances: 1, values: { full_time_student: true } }) }).incomeTaxCents).toBe(0);
    const none = ma({ periodsPerYear: 52, regularWagesCents: 100000, ficaEmployeeCents: 0 });
    expect(none.incomeTaxCents).toBe(5000);
    expect(ma({ periodsPerYear: 52, regularWagesCents: 100000, ficaEmployeeCents: 0, certificate: certificate({ extraWithholding: 10 }) }).incomeTaxCents).toBe(6000);
  });

  it('takes PFML 0.46% from the employee and 0.42% from employers with 25 or more, none under 25', () => {
    const big = ma({ periodsPerYear: 12, regularWagesCents: 1000000, employeeCountEstimate: 40 });
    expect(big.programs.find((p) => p.code === 'ma_pfml')).toMatchObject({ employeeCents: 4600, employerCents: 4200 });
    const small = ma({ periodsPerYear: 12, regularWagesCents: 1000000, employeeCountEstimate: 12 });
    // PFML wages include Section 125 salary reductions.
    const cafeteria = ma({ periodsPerYear: 12, regularWagesCents: 1000000, employeeCountEstimate: 40, pretax: { retirement401kCents: 0, section125Cents: 50000, hsaCents: 0, dependentCareCents: 0 } });
    expect(cafeteria.programs.find((p) => p.code === 'ma_pfml')?.wagesCents).toBe(1000000);
    expect(small.programs.find((p) => p.code === 'ma_pfml')).toMatchObject({ employeeCents: 4600, employerCents: 0 });
  });

  it('charges a new employer UI 2.42% + WTFP 0.056% on the first $15,000, without COVID-19 recovery assessment or EMAC', () => {
    const r = ma({ periodsPerYear: 12, regularWagesCents: 1000000, suiRatePercent: null, ytd: { 'us.state.MA.sui_wages': 1000000 } });
    expect(r.sui).toMatchObject({ taxableWagesCents: 500000, employerCents: 12100 });
    expect(r.programs.find((p) => p.code === 'ma_covid_recovery')?.employerCents).toBe(0);
    expect(r.programs.find((p) => p.code === 'ma_wtf')?.employerCents).toBe(280);
    expect(r.programs.find((p) => p.code === 'ma_emac')?.employerCents).toBe(0);
  });

  it('derives the COVID-19 recovery rate from an experience UI rate and warns when EMAC was not entered', () => {
    const r = ma({ periodsPerYear: 12, regularWagesCents: 1000000, suiRatePercent: 1.08 });
    expect(r.programs.find((p) => p.code === 'ma_covid_recovery')?.employerCents).toBe(2040);
    expect(r.programs.find((p) => p.code === 'ma_emac')?.employerCents).toBe(3400);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'employer_incomplete', params: expect.objectContaining({ field: 'ma_emac' }) }));
    const entered = ma({ periodsPerYear: 12, regularWagesCents: 1000000, suiRatePercent: 1.08, extraRates: { ma_emac: 0.12 } });
    expect(entered.programs.find((p) => p.code === 'ma_emac')?.employerCents).toBe(1200);
    expect(entered.ruleSet).toBe('us-ma-2026.1');
  });
});
