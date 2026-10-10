import { describe, expect, it } from 'vitest';
import { roundHalfAwayFromZero } from '../../money';
import { CA_MODULE, caMethodB } from './ca';
import { certificate, stateInput } from './test-input';

const ca = (overrides: Parameters<typeof stateInput>[1]) => CA_MODULE.calculate(stateInput('CA', overrides));

describe('California Method B — examples of the 2026 withholding schedules (26methb.pdf)', () => {
  it('Example A: weekly $210, single, 1 allowance — under the low-income exemption', () => {
    expect(caMethodB({ period: 'weekly', status: 'single', regularAllowances: 1, estimatedDeductionAllowances: 0, wagesCents: 21000 })).toBe(0);
  });

  it('Example B: biweekly $1,600, married, 3 allowances of which 1 for estimated deductions — $2.38', () => {
    const tax = caMethodB({ period: 'biweekly', status: 'married', regularAllowances: 2, estimatedDeductionAllowances: 1, wagesCents: 160000 });
    expect(roundHalfAwayFromZero(tax)).toBe(238);
  });

  it('Example C: monthly $5,100, married, 5 allowances — $0.82', () => {
    const tax = caMethodB({ period: 'monthly', status: 'married', regularAllowances: 5, estimatedDeductionAllowances: 0, wagesCents: 510000 });
    expect(roundHalfAwayFromZero(tax)).toBe(82);
  });

  it('Example D: weekly $950, unmarried head of household, 3 allowances — $1.69', () => {
    const tax = caMethodB({ period: 'weekly', status: 'head_of_household', regularAllowances: 3, estimatedDeductionAllowances: 0, wagesCents: 95000 });
    expect(roundHalfAwayFromZero(tax)).toBe(169);
  });

  it('Example E: annualized semi-monthly $2,400, married, 4 allowances — $99.20 a year, $4.13 a period', () => {
    const annual = caMethodB({ period: 'annual', status: 'married', regularAllowances: 4, estimatedDeductionAllowances: 0, wagesCents: 5760000 });
    expect(roundHalfAwayFromZero(annual)).toBe(9920);
    expect(roundHalfAwayFromZero(annual / 24)).toBe(413);
  });

  it('Example F: annual $57,000, married, 4 allowances — $86.00 a year, $7.17 a month', () => {
    const annual = caMethodB({ period: 'annual', status: 'married', regularAllowances: 4, estimatedDeductionAllowances: 0, wagesCents: 5700000 });
    expect(roundHalfAwayFromZero(annual)).toBe(8600);
    expect(roundHalfAwayFromZero(annual / 12)).toBe(717);
  });

  it('more than 10 allowances use n × the amount for one (weekly, 15 allowances: $48.60 credit)', () => {
    // Weekly $3,000 single: tax before credit minus 15 × $3.24.
    const with15 = caMethodB({ period: 'weekly', status: 'single', regularAllowances: 15, estimatedDeductionAllowances: 0, wagesCents: 300000 });
    const with0 = caMethodB({ period: 'weekly', status: 'single', regularAllowances: 0, estimatedDeductionAllowances: 0, wagesCents: 300000 });
    expect(roundHalfAwayFromZero(with0 - with15)).toBe(4860);
  });
});

describe('California module', () => {
  it('runs Example B through the module, with SDI, UI and ETT', () => {
    const r = ca({
      periodsPerYear: 26,
      regularWagesCents: 160000,
      certificate: certificate({ filingStatus: 'married', allowances: 2, values: { estimated_deduction_allowances: 1 } }),
      suiRatePercent: 3.4,
    });
    expect(r.incomeTaxCents).toBe(238);
    expect(r.stateWagesCents).toBe(160000);
    expect(r.programs.find((p) => p.code === 'ca_sdi')).toMatchObject({ wagesCents: 160000, employeeCents: 2080, employerCents: 0 });
    expect(r.sui).toEqual({ taxableWagesCents: 160000, grossWagesCents: 160000, employerCents: 5440, employeeCents: 0 });
    expect(r.programs.find((p) => p.code === 'ca_ett')).toMatchObject({ wagesCents: 160000, employerCents: 160 });
    expect(r.ruleSet).toBe('us-ca-2026.1');
    expect(r.issues).toEqual([]);
  });

  it('without a DE 4 withholds as Single with zero allowances', () => {
    const none = ca({ periodsPerYear: 52, regularWagesCents: 95000 });
    const single0 = caMethodB({ period: 'weekly', status: 'single', regularAllowances: 0, estimatedDeductionAllowances: 0, wagesCents: 95000 });
    expect(none.incomeTaxCents).toBe(roundHalfAwayFromZero(single0));
  });

  it('excludes 401(k), Section 125 and dependent care from PIT wages but not HSA; SDI/UI keep 401(k)', () => {
    const r = ca({
      periodsPerYear: 12,
      regularWagesCents: 600000,
      pretax: { retirement401kCents: 30000, section125Cents: 20000, hsaCents: 10000, dependentCareCents: 5000 },
    });
    expect(r.stateWagesCents).toBe(600000 - 30000 - 20000 - 5000);
    const sdi = r.programs.find((p) => p.code === 'ca_sdi');
    expect(sdi?.wagesCents).toBe(600000 - 20000 - 5000);
    expect(r.sui.grossWagesCents).toBe(600000 - 20000 - 5000);
    expect(r.sui.taxableWagesCents).toBe(575000);
  });

  it('caps UI and ETT at $7,000 a year but keeps SDI uncapped', () => {
    const r = ca({ periodsPerYear: 12, regularWagesCents: 1000000, ytd: { 'us.state.CA.sui_wages': 650000, 'us.state.CA.ca_sdi_wages': 5000000 } });
    expect(r.sui.taxableWagesCents).toBe(50000);
    expect(r.programs.find((p) => p.code === 'ca_ett')?.employerCents).toBe(50);
    expect(r.programs.find((p) => p.code === 'ca_sdi')?.employeeCents).toBe(13000);
    expect(r.ytdUpdates['us.state.CA.sui_wages']).toBe(700000);
    expect(r.ytdUpdates['us.state.CA.ca_sdi_wages']).toBe(6000000);
  });

  it('treats supplemental pay with regular pay as regular wages, and alone at the 10.23% bonus rate', () => {
    const together = ca({ periodsPerYear: 26, regularWagesCents: 160000, supplementalWagesCents: 100000, certificate: certificate({ filingStatus: 'married', allowances: 2 }) });
    const aggregate = caMethodB({ period: 'biweekly', status: 'married', regularAllowances: 2, estimatedDeductionAllowances: 0, wagesCents: 260000 });
    expect(together.incomeTaxCents).toBe(roundHalfAwayFromZero(aggregate));
    const alone = ca({ periodsPerYear: 26, supplementalWagesCents: 100000 });
    expect(alone.incomeTaxCents).toBe(10230);
  });

  it('adds the DE 4 extra amount, and withholds nothing when exempt (SDI still applies)', () => {
    const extra = ca({ periodsPerYear: 52, regularWagesCents: 21000, certificate: certificate({ filingStatus: 'single', allowances: 1, extraWithholding: 15 }) });
    expect(extra.incomeTaxCents).toBe(1500);
    const exempt = ca({ periodsPerYear: 52, regularWagesCents: 200000, certificate: certificate({ exempt: true, extraWithholding: 15 }) });
    expect(exempt.incomeTaxCents).toBe(0);
    expect(exempt.programs.find((p) => p.code === 'ca_sdi')?.employeeCents).toBe(2600);
  });

  it('falls back to the new-employer rate with a warning, and warns about another residence state', () => {
    const r = ca({ periodsPerYear: 52, regularWagesCents: 100000, suiRatePercent: null, residenceState: 'NV' });
    expect(r.sui.employerCents).toBe(3400);
    expect(r.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'employer_incomplete', severity: 'warning', params: expect.objectContaining({ state: 'CA' }) }),
        expect.objectContaining({ code: 'residence_state_differs', severity: 'warning', params: { state: 'CA', residenceState: 'NV' } }),
      ]),
    );
  });

  it('refuses other tax years and pay frequencies without tables', () => {
    expect(ca({ taxYear: 2027 }).issues[0]).toMatchObject({ severity: 'error', code: 'unsupported_tax_year' });
    expect(ca({ periodsPerYear: 13 }).issues[0]).toMatchObject({ severity: 'error', code: 'unsupported_frequency' });
  });

  it('skips SUI and ETT for SUI-exempt employment', () => {
    const r = ca({ periodsPerYear: 52, regularWagesCents: 100000, exemptFromSui: true });
    expect(r.sui.employerCents).toBe(0);
    expect(r.programs.find((p) => p.code === 'ca_ett')).toBeUndefined();
  });
});
