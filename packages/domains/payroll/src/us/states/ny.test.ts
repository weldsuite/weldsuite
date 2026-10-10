import { describe, expect, it } from 'vitest';
import { roundHalfAwayFromZero } from '../../money';
import { NY_MODULE, nyExactWithholding } from './ny';
import { certificate, stateInput } from './test-input';

const ny = (overrides: Parameters<typeof stateInput>[1]) => NY_MODULE.calculate(stateInput('NY', overrides));
const exact = (period: 'weekly' | 'semimonthly' | 'monthly', status: 'single' | 'married', allowances: number, dollars: number, periodsPerYear: number) =>
  roundHalfAwayFromZero(nyExactWithholding({ period, status, allowances, wagesCents: dollars * 100, periodsPerYear }));

describe('New York exact calculation method — NYS-50-T-NYS (1/26) examples', () => {
  it('single example 1: weekly $400, 3 exemptions — $8.01', () => {
    expect(exact('weekly', 'single', 3, 400, 52)).toBe(801);
  });

  it('single example 2: semimonthly $5,000, 1 exemption — $258.50 (the publication prints $258.51)', () => {
    // Step 4 is $165.00 × 0.0753 = $12.4245, which the publication shows as $12.43; the exact sum is $258.5045.
    expect(exact('semimonthly', 'single', 1, 5000, 24)).toBe(25850);
  });

  it('single example 3: monthly $50,000, 3 exemptions — $3,576.63', () => {
    expect(exact('monthly', 'single', 3, 50000, 12)).toBe(357663);
  });

  it('married example 1: weekly $400, 4 exemptions — $6.69', () => {
    expect(exact('weekly', 'married', 4, 400, 52)).toBe(669);
  });

  it('married example 2: semimonthly $5,000, 3 exemptions — $248.12 (the publication prints $248.11)', () => {
    // Step 4 is $58.80 × 0.0707 = $4.157, which the publication truncates to $4.15.
    expect(exact('semimonthly', 'married', 3, 5000, 24)).toBe(24812);
  });

  it('married example 3: monthly $50,000, 3 exemptions — $3,622.09', () => {
    expect(exact('monthly', 'married', 3, 50000, 12)).toBe(362209);
  });

  it('uses Method III at the top line: weekly single net wages of $25,000 at 10.45%', () => {
    // Net = $25,142.30 − $142.30 = $25,000 ≥ $20,722; annualized $1.3M < $5M → 10.45% of net.
    expect(exact('weekly', 'single', 0, 25142.3, 52)).toBe(261250);
  });
});

describe('New York module', () => {
  it('withholds, and takes PFL, DBL, UI and RSF', () => {
    const r = ny({ periodsPerYear: 52, regularWagesCents: 51900, certificate: certificate({ filingStatus: 'single', allowances: 0 }), suiRatePercent: 4.025 });
    // PFL: "$519 a week … about $2.24" (paidfamilyleave.ny.gov/2026).
    expect(r.programs.find((p) => p.code === 'ny_pfl')).toMatchObject({ wagesCents: 51900, employeeCents: 224, employerCents: 0 });
    // DBL: 0.5% = $2.60, capped at $0.60 a week.
    expect(r.programs.find((p) => p.code === 'ny_dbl')?.employeeCents).toBe(60);
    expect(r.sui.employerCents).toBe(roundHalfAwayFromZero(51900 * 0.04025));
    expect(r.programs.find((p) => p.code === 'ny_rsf')?.employerCents).toBe(39);
    expect(r.incomeTaxCents).toBe(exact('weekly', 'single', 0, 519, 52));
    expect(r.ruleSet).toBe('us-ny-2026.1');
  });

  it('caps DBL per period ($1.30 semimonthly, $2.60 monthly) and PFL at $411.91 a year', () => {
    expect(ny({ periodsPerYear: 24, regularWagesCents: 500000 }).programs.find((p) => p.code === 'ny_dbl')?.employeeCents).toBe(130);
    expect(ny({ periodsPerYear: 12, regularWagesCents: 500000 }).programs.find((p) => p.code === 'ny_dbl')?.employeeCents).toBe(260);
    const nearCap = ny({ periodsPerYear: 12, regularWagesCents: 1000000, ytd: { 'us.state.NY.ny_pfl_employee': 41100, 'us.state.NY.ny_pfl_wages': 9000000 } });
    const pfl = nearCap.programs.find((p) => p.code === 'ny_pfl');
    expect(pfl?.employeeCents).toBe(91);
    expect(nearCap.ytdUpdates['us.state.NY.ny_pfl_employee']).toBe(41191);
  });

  it('lets the employer carry the PFL and DBL employee shares', () => {
    const r = ny({ periodsPerYear: 52, regularWagesCents: 100000, extraRates: { ny_pfl_employee: 0, ny_dbl_employee: 0 } });
    expect(r.programs.find((p) => p.code === 'ny_pfl')?.employeeCents).toBe(0);
    expect(r.programs.find((p) => p.code === 'ny_dbl')?.employeeCents).toBe(0);
  });

  it('applies the $17,600 UI wage base; UI wages include 401(k) and Section 125, withholding wages do not', () => {
    const r = ny({
      periodsPerYear: 12,
      regularWagesCents: 1000000,
      pretax: { retirement401kCents: 50000, section125Cents: 30000, hsaCents: 0, dependentCareCents: 0 },
      ytd: { 'us.state.NY.sui_wages': 1500000 },
    });
    expect(r.stateWagesCents).toBe(920000);
    expect(r.sui.grossWagesCents).toBe(1000000);
    expect(r.sui.taxableWagesCents).toBe(260000);
  });

  it('withholds supplemental pay at 11.70% next to taxed regular pay', () => {
    const r = ny({ periodsPerYear: 26, regularWagesCents: 300000, supplementalWagesCents: 100000, certificate: certificate({ filingStatus: 'married', allowances: 2 }) });
    const regular = roundHalfAwayFromZero(nyExactWithholding({ period: 'biweekly', status: 'married', allowances: 2, wagesCents: 300000, periodsPerYear: 26 }));
    expect(r.incomeTaxCents).toBe(regular + 11700);
  });

  it('converts quarterly payrolls through the monthly table (factor 3)', () => {
    const r = ny({ periodsPerYear: 4, regularWagesCents: 675000, certificate: certificate({ filingStatus: 'married', allowances: 2 }) });
    const monthly = nyExactWithholding({ period: 'monthly', status: 'married', allowances: 2, wagesCents: 225000, periodsPerYear: 12 });
    expect(r.incomeTaxCents).toBe(roundHalfAwayFromZero(monthly * 3));
  });

  it('withholds as single with zero allowances without an IT-2104, nothing when exempt, plus the extra amount', () => {
    expect(ny({ periodsPerYear: 52, regularWagesCents: 40000 }).incomeTaxCents).toBe(exact('weekly', 'single', 0, 400, 52));
    expect(ny({ periodsPerYear: 52, regularWagesCents: 40000, certificate: certificate({ exempt: true }) }).incomeTaxCents).toBe(0);
    expect(ny({ periodsPerYear: 52, regularWagesCents: 40000, certificate: certificate({ filingStatus: 'single', allowances: 3, extraWithholding: 10 }) }).incomeTaxCents).toBe(801 + 1000);
  });

  it('warns that New York City and Yonkers resident taxes are not withheld', () => {
    const r = ny({ periodsPerYear: 52, regularWagesCents: 40000, certificate: certificate({ filingStatus: 'single', values: { nyc_resident: true } }) });
    expect(r.issues).toContainEqual({ severity: 'warning', code: 'local_tax_not_supported', params: { state: 'NY', locality: 'NYC' } });
  });
});
