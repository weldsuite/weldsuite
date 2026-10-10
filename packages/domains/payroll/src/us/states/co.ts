/**
 * Colorado: income tax withholding (DR 0004 or the federal W-4, DR 1098
 * worksheet), FAMLI and UI.
 *
 * Sources (fetched 9 October 2026):
 * - CDOR, DR 1098 (10/21/25), "2026 Colorado Withholding Worksheet for
 *   Employers", tax.colorado.gov: annualize; subtract the DR 0004 line 2
 *   allowance, else $11,000 (W-4 married filing jointly / qualifying surviving
 *   spouse) or $5,500 (otherwise, and when no W-4 or DR 0004 was given);
 *   4.40%; de-annualize; add DR 0004 line 3. A W-4 claiming exempt without a
 *   DR 0004 means no withholding.
 * - CDOR, Colorado Wage Withholding Tax Guide (revised January 2026), Part 2:
 *   wages subject to Colorado withholding are the wages subject to federal
 *   withholding (bonuses included, so supplemental pay is simply part of the
 *   period's wages).
 * - Colorado FAMLI, https://famli.colorado.gov (premium calculator and
 *   "Update Your Employee Headcount for 2026 Premiums"): 0.88% of wages up to
 *   the Social Security wage base ($184,500), half employer, half employee;
 *   employers with nine or fewer employees pay 0.44% (the employee half);
 *   without a refreshed headcount 0.88% applies.
 * - CDLE, Unemployment Insurance Premiums: premium rates and introductory
 *   rates, https://cdle.colorado.gov/employers/unemployment-insurance-premiums/introductory-rates:
 *   2026 chargeable wage base $30,600; new non-construction employer combined
 *   rate 3.05% (base 1.53% + support 0.17% + solvency surcharge 1.35%).
 *   cdle.colorado.gov refuses automated fetches; read through search extracts.
 *   The employer's notice gives the combined rate, which is what
 *   `suiRatePercent` holds.
 */

import { type Cents } from '../../money';
import type { PayrollIssue } from '../../types';
import {
  FEDERAL_INCOME_TAX_LIKE,
  FICA_LIKE,
  YtdWriter,
  certExtraCents,
  computeSharedProgram,
  computeSui,
  d,
  recordIncomeTax,
  residenceIssue,
  roundCents,
  taxableWages,
  unsupportedYearResult,
  rateCode,
} from './common';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'CO';
const RULE_SET = 'us-co-2026.1';

const RATE_PERCENT = 4.4;
const ALLOWANCE_MARRIED_JOINTLY = d(11000);
const ALLOWANCE_OTHER = d(5500);

const FAMLI_RATE_PERCENT = 0.88;
const FAMLI_WAGE_BASE = d(184500);
const FAMLI_SMALL_EMPLOYER_LIMIT = 10;

const UI_WAGE_BASE = d(30600);
const UI_NEW_EMPLOYER_RATE_PERCENT = 3.05;

/** DR 0004 line 2 when the employee filled it in (zero counts), else the W-4 filing-status amount. */
function annualAllowance(input: StateCalcInput): Cents {
  const line2 = input.certificate?.values?.withholding_allowance;
  if (typeof line2 === 'number' && Number.isFinite(line2)) return Math.max(0, d(line2));
  if (typeof line2 === 'string' && line2.trim() !== '' && Number.isFinite(Number(line2))) return Math.max(0, d(Number(line2)));
  return input.federalW4?.filingStatus === 'married_jointly' ? ALLOWANCE_MARRIED_JOINTLY : ALLOWANCE_OTHER;
}

/** DR 1098 step 2 for one period's wages (unrounded cents). Exported for tests. */
export function coWithholding(wagesCents: Cents, annualAllowanceCents: Cents, periodsPerYear: number): number {
  const annual = Math.max(0, wagesCents * periodsPerYear - annualAllowanceCents);
  return (annual * RATE_PERCENT) / 100 / periodsPerYear;
}

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const ytd = new YtdWriter(input, STATE);
  const issues: PayrollIssue[] = [...residenceIssue(input, STATE)];

  const wages = taxableWages(input, FEDERAL_INCOME_TAX_LIKE);
  const hasDr0004 = input.certificate !== null;
  const w4Exempt = !hasDr0004 && input.federalW4?.exempt === true;
  let incomeTax = 0;
  if (!w4Exempt && !input.certificate?.exempt && wages.total > 0) {
    incomeTax = roundCents(coWithholding(wages.total, annualAllowance(input), input.periodsPerYear)) + certExtraCents(input);
  }
  recordIncomeTax(ytd, wages.total, incomeTax);

  const sui = computeSui(input, STATE, { wageBaseCents: UI_WAGE_BASE, newEmployerRatePercent: UI_NEW_EMPLOYER_RATE_PERCENT, exclusions: FICA_LIKE }, ytd);
  issues.push(...sui.issues);

  const headcount = input.employeeCountEstimate;
  if (headcount === null) {
    issues.push({ severity: 'warning', code: 'employer_incomplete', params: { state: STATE, field: 'employeeCountEstimate' } });
  }
  const employerOwesHalf = headcount === null || headcount >= FAMLI_SMALL_EMPLOYER_LIMIT;
  // The employer may carry (part of) the employee half: `extraRates.co_famli_employee` (percent).
  const famli = computeSharedProgram(
    input,
    STATE,
    {
      code: 'co_famli',
      labelKey: 'us.state_program.co_famli',
      wagesCents: input.exemptFromSui ? 0 : taxableWages(input, FICA_LIKE).total,
      wageBaseCents: FAMLI_WAGE_BASE,
      totalRatePercent: FAMLI_RATE_PERCENT,
      employeeMaxRatePercent: FAMLI_RATE_PERCENT / 2,
      employeeRatePercent: input.extraRates.co_famli_employee,
      employerOwesShare: employerOwesHalf,
    },
    ytd,
  );

  return {
    stateWagesCents: wages.total,
    incomeTaxCents: incomeTax,
    sui: sui.sui,
    programs: [famli, ...sui.programs],
    ytdUpdates: ytd.updates,
    issues,
    ruleSet: RULE_SET,
  };
}

export const CO_MODULE: StateModule = {
  code: STATE,
  name: 'Colorado',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'DR 0004',
    usesAllowances: false,
    fields: [
      { key: 'withholding_allowance', type: 'money', labelKey: 'CO.withholding_allowance' },
      { key: 'extraWithholding', type: 'money', labelKey: 'CO.extraWithholding' },
    ],
  },
  employerRateCodes: [rateCode('co_famli_employee', 0.44)],
  calculate,
};
