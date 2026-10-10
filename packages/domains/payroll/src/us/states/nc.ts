/**
 * North Carolina: income tax withholding (NC-4, NC-30 percentage method)
 * and UI.
 *
 * Sources (fetched 9 October 2026):
 * - NCDOR, NC-30 "2026 Income Tax Withholding Tables and Instructions for
 *   Employers" (Web 11-25), https://www.ncdor.gov/income-tax-withholding-tables-and-instructions-employers:
 *   rate 3.99% for 2026, withholding at 4.09% (3.99% + 0.1%); standard
 *   deduction $12,750 (single, married, surviving spouse) / $19,125 (head of
 *   household); $2,500 per allowance; percentage method per payroll period
 *   and annualized method, rounded to the nearest whole dollar, with examples
 *   (p. 17–20); supplemental wages at a flat 4.09% or aggregated (section 12);
 *   no NC-4 → single with no allowances (section 13); wages as in IRC § 3401
 *   (section 9).
 * - NC DES, Tax Rate Information, https://des.nc.gov/employers/tax-rate-information:
 *   2026 taxable wage base $34,200; beginning employers 1%; no surtax in 2026.
 */

import { percentOf, type Cents } from '../../money';
import {
  FEDERAL_INCOME_TAX_LIKE,
  FICA_LIKE,
  YtdWriter,
  certAllowances,
  certBoolean,
  certExtraCents,
  computeSui,
  d,
  nominalPeriods,
  periodTypeOf,
  recordIncomeTax,
  residenceIssue,
  roundToDollar,
  taxableWages,
  unsupportedYearResult,
} from './common';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'NC';
const RULE_SET = 'us-nc-2026.1';

type NcStatus = 'single' | 'married' | 'head_of_household';

const WITHHOLDING_RATE_PERCENT = 4.09;
const STANDARD_DEDUCTION = { regular: d(12750), head_of_household: d(19125) };
const ALLOWANCE = d(2500);

/** NC-30 p. 17–18: per-period standard deduction portion [single/married/surviving spouse, head of household] and allowance. */
const PER_PERIOD: Partial<Record<number, { deduction: [number, number]; allowance: number }>> = {
  52: { deduction: [245.19, 367.79], allowance: 48.08 },
  26: { deduction: [490.38, 735.58], allowance: 96.15 },
  24: { deduction: [531.25, 796.88], allowance: 104.17 },
  12: { deduction: [1062.5, 1593.75], allowance: 208.33 },
};

const UI_WAGE_BASE = d(34200);
const UI_NEW_EMPLOYER_RATE_PERCENT = 1.0;

/** NC-30 percentage method (or the annualized method for other periods), rounded to whole dollars. */
export function ncWithholding(wagesCents: Cents, status: NcStatus, allowances: number, periodsPerYear: number): Cents {
  const hoh = status === 'head_of_household';
  const table = PER_PERIOD[nominalPeriods(periodsPerYear)];
  if (table) {
    const net = wagesCents - d(table.deduction[hoh ? 1 : 0]) - allowances * d(table.allowance);
    return net > 0 ? roundToDollar((net * WITHHOLDING_RATE_PERCENT) / 100) : 0;
  }
  const annual = wagesCents * periodsPerYear - (hoh ? STANDARD_DEDUCTION.head_of_household : STANDARD_DEDUCTION.regular) - allowances * ALLOWANCE;
  return annual > 0 ? roundToDollar((annual * WITHHOLDING_RATE_PERCENT) / 100 / periodsPerYear) : 0;
}

function ncStatus(raw: string | null | undefined): NcStatus {
  return raw === 'married' || raw === 'head_of_household' ? raw : 'single';
}

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const ytd = new YtdWriter(input, STATE);
  const issues = [...residenceIssue(input, STATE)];

  const wages = taxableWages(input, FEDERAL_INCOME_TAX_LIKE);
  const cert = input.certificate;
  let incomeTax = 0;
  const exempt = cert?.exempt === true || certBoolean(input, 'military_spouse_exempt');
  if (!exempt) {
    // No NC-4: single with no allowances (NC-30 section 13).
    const status = ncStatus(cert?.filingStatus);
    const allowances = cert ? certAllowances(input) : 0;
    const regularTax = wages.regular > 0 ? ncWithholding(wages.regular, status, allowances, input.periodsPerYear) : 0;
    let supplementalTax = 0;
    if (wages.supplemental > 0) {
      // Flat 4.09% when tax is withheld from regular wages; otherwise aggregate (method b).
      supplementalTax =
        wages.regular > 0 && regularTax === 0
          ? ncWithholding(wages.regular + wages.supplemental, status, allowances, input.periodsPerYear) - regularTax
          : percentOf(wages.supplemental, WITHHOLDING_RATE_PERCENT);
    }
    incomeTax = regularTax + supplementalTax;
    if (wages.total > 0) incomeTax += certExtraCents(input);
  }
  recordIncomeTax(ytd, wages.total, incomeTax);

  const sui = computeSui(input, STATE, { wageBaseCents: UI_WAGE_BASE, newEmployerRatePercent: UI_NEW_EMPLOYER_RATE_PERCENT, exclusions: FICA_LIKE }, ytd);
  issues.push(...sui.issues);

  return {
    stateWagesCents: wages.total,
    incomeTaxCents: incomeTax,
    sui: sui.sui,
    programs: sui.programs,
    ytdUpdates: ytd.updates,
    issues,
    ruleSet: RULE_SET,
  };
}

export const NC_MODULE: StateModule = {
  code: STATE,
  name: 'North Carolina',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'NC-4',
    filingStatuses: ['single', 'married', 'head_of_household'],
    usesAllowances: true,
    fields: [
      { key: 'filingStatus', type: 'select', options: ['single', 'married', 'head_of_household'], required: true, labelKey: 'NC.filingStatus' },
      { key: 'allowances', type: 'number', labelKey: 'NC.allowances' },
      { key: 'extraWithholding', type: 'money', labelKey: 'NC.extraWithholding' },
      { key: 'exempt', type: 'boolean', labelKey: 'NC.exempt' },
      { key: 'military_spouse_exempt', type: 'boolean', labelKey: 'NC.military_spouse_exempt' },
    ],
  },
  calculate,
};
