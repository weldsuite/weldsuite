import { describe, expect, it } from 'vitest';
import type { UsW4Input } from '../../types';
import { CO_MODULE } from './co';
import { certificate, stateInput } from './test-input';

const co = (overrides: Parameters<typeof stateInput>[1]) => CO_MODULE.calculate(stateInput('CO', overrides));
const w4 = (overrides: Partial<UsW4Input>): UsW4Input => ({
  formYear: 2026,
  filingStatus: 'single',
  multipleJobs: false,
  dependentsAmount: 0,
  otherIncome: 0,
  deductions: 0,
  extraWithholding: 0,
  exempt: false,
  allowances: null,
  nonresidentAlien: false,
  ...overrides,
});

describe('Colorado — DR 1098 (2026) worksheet', () => {
  it('uses $5,500 for a single W-4 (or no certificate at all) and $11,000 for married filing jointly', () => {
    // Bi-weekly $2,000: (52,000 − 5,500) × 4.40% ÷ 26 = $78.69; (52,000 − 11,000) × 4.40% ÷ 26 = $69.38.
    expect(co({ periodsPerYear: 26, regularWagesCents: 200000 }).incomeTaxCents).toBe(7869);
    expect(co({ periodsPerYear: 26, regularWagesCents: 200000, federalW4: w4({ filingStatus: 'head_of_household' }) }).incomeTaxCents).toBe(7869);
    expect(co({ periodsPerYear: 26, regularWagesCents: 200000, federalW4: w4({ filingStatus: 'married_jointly' }) }).incomeTaxCents).toBe(6938);
  });

  it('uses the DR 0004 line 2 amount, zero included, and adds line 3', () => {
    const zero = co({ periodsPerYear: 26, regularWagesCents: 200000, federalW4: w4({ filingStatus: 'married_jointly' }), certificate: certificate({ values: { withholding_allowance: 0 } }) });
    expect(zero.incomeTaxCents).toBe(8800);
    const own = co({ periodsPerYear: 12, regularWagesCents: 500000, certificate: certificate({ values: { withholding_allowance: 20000 }, extraWithholding: 25 }) });
    // (60,000 − 20,000) × 4.40% ÷ 12 = $146.67, plus $25.
    expect(own.incomeTaxCents).toBe(14667 + 2500);
  });

  it('withholds nothing for a W-4 exempt claim without a DR 0004', () => {
    expect(co({ periodsPerYear: 26, regularWagesCents: 200000, federalW4: w4({ exempt: true }) }).incomeTaxCents).toBe(0);
  });
});

describe('Colorado FAMLI and UI', () => {
  it('splits FAMLI 0.88% evenly up to $184,500, without an employer half under 10 employees', () => {
    const big = co({ periodsPerYear: 12, regularWagesCents: 1000000, employeeCountEstimate: 25 });
    expect(big.programs.find((p) => p.code === 'co_famli')).toMatchObject({ wagesCents: 1000000, employeeCents: 4400, employerCents: 4400 });
    const small = co({ periodsPerYear: 12, regularWagesCents: 1000000, employeeCountEstimate: 9 });
    expect(small.programs.find((p) => p.code === 'co_famli')).toMatchObject({ employeeCents: 4400, employerCents: 0 });
    const capped = co({ periodsPerYear: 12, regularWagesCents: 1000000, ytd: { 'us.state.CO.co_famli_wages': 18000000 } });
    expect(capped.programs.find((p) => p.code === 'co_famli')?.wagesCents).toBe(450000);
  });

  it('charges the full 0.88% and warns when the headcount is unknown', () => {
    const r = co({ periodsPerYear: 12, regularWagesCents: 1000000, employeeCountEstimate: null });
    expect(r.programs.find((p) => p.code === 'co_famli')?.employerCents).toBe(4400);
    expect(r.issues).toContainEqual(expect.objectContaining({ code: 'employer_incomplete', params: { state: 'CO', field: 'employeeCountEstimate' } }));
  });

  it('applies the $30,600 chargeable wage base at the 3.05% introductory combined rate', () => {
    const r = co({ periodsPerYear: 12, regularWagesCents: 500000, suiRatePercent: null, ytd: { 'us.state.CO.sui_wages': 2800000 } });
    expect(r.sui.taxableWagesCents).toBe(260000);
    expect(r.sui.employerCents).toBe(7930);
    expect(r.ruleSet).toBe('us-co-2026.1');
  });
});
