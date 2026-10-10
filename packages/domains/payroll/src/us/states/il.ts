/**
 * Illinois: income tax withholding (IL-W-4, IL-700-T automated payroll
 * method) and UI.
 *
 * Sources (fetched 9 October 2026):
 * - IDOR Booklet IL-700-T (R-12/25), "Illinois Withholding Tax Tables",
 *   effective 1 January 2026, tax.illinois.gov: rate 4.95%, basic allowance
 *   $2,925 (IL-W-4 line 1), additional allowance $1,000 (line 2); automated
 *   payroll method and its example (p. 4).
 * - IDOR Publication 130 (R-02/26), "Who is Required to Withhold Illinois
 *   Income Tax": withhold from compensation subject to federal income tax
 *   withholding; no IL-W-4 → no allowances (p. 7); state wages (W-2 box 16)
 *   tie to box 1, so IL wages follow federal income tax wages.
 * - IDES EA-50 (11/2025), 2026 contribution rates,
 *   https://ides.illinois.gov/content/dam/soi/en/web/ides/ides_forms_and_publications/EA-50_2026.pdf:
 *   wage base $14,250; new employer rate 3.350% (3.450% in NAICS 56),
 *   including the 0.550% fund building rate.
 */

import { percentOf, type Cents } from '../../money';
import {
  FEDERAL_INCOME_TAX_LIKE,
  FICA_LIKE,
  YtdWriter,
  certAllowances,
  certExtraCents,
  certNumber,
  computeSui,
  d,
  recordIncomeTax,
  residenceIssue,
  roundCents,
  taxableWages,
  unsupportedYearResult,
} from './common';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'IL';
const RULE_SET = 'us-il-2026.1';

const RATE_PERCENT = 4.95;
const BASIC_ALLOWANCE = d(2925);
const ADDITIONAL_ALLOWANCE = d(1000);

const UI_WAGE_BASE = d(14250);
const UI_NEW_EMPLOYER_RATE_PERCENT = 3.35;

/** IL-700-T automated payroll method for one period's wages, in cents (exported for the publication example). */
export function ilWithholding(wagesCents: Cents, basicAllowances: number, additionalAllowances: number, periodsPerYear: number): Cents {
  // Step 2: exemptions per period, rounded to the cent as in the booklet's example ($7,850 ÷ 52 = $150.96).
  const exemptions = roundCents((basicAllowances * BASIC_ALLOWANCE + additionalAllowances * ADDITIONAL_ALLOWANCE) / periodsPerYear);
  const taxable = Math.max(0, wagesCents - exemptions);
  return percentOf(taxable, RATE_PERCENT);
}

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const ytd = new YtdWriter(input, STATE);
  const issues = [...residenceIssue(input, STATE)];

  const wages = taxableWages(input, FEDERAL_INCOME_TAX_LIKE);
  const cert = input.certificate;
  let incomeTax = 0;
  if (!cert?.exempt) {
    // No IL-W-4: no allowances (Pub 130).
    const basic = cert ? certAllowances(input) : 0;
    const additional = cert ? Math.max(0, Math.trunc(certNumber(input, 'additional_allowances'))) : 0;
    // The exemption is a per-payroll-period amount: it reduces regular pay; supplemental pay is taxed at the flat rate.
    incomeTax = (wages.regular > 0 ? ilWithholding(wages.regular, basic, additional, input.periodsPerYear) : 0) + percentOf(wages.supplemental, RATE_PERCENT);
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

export const IL_MODULE: StateModule = {
  code: STATE,
  name: 'Illinois',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'IL-W-4',
    usesAllowances: true,
    fields: [
      { key: 'allowances', type: 'number', labelKey: 'IL.allowances' },
      { key: 'additional_allowances', type: 'number', labelKey: 'IL.additional_allowances' },
      { key: 'extraWithholding', type: 'money', labelKey: 'IL.extraWithholding' },
    ],
  },
  calculate,
};
