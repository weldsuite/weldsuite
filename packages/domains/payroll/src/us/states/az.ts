/**
 * Arizona: income tax withholding as the percentage of gross taxable wages
 * the employee elects on Form A-4, and UI.
 *
 * Sources (fetched 9 October 2026):
 * - ADOR, Form A-4 (2026) and its instructions, https://azdor.gov/forms/withholding-forms/employees-arizona-withholding-election:
 *   percentages 0.5, 1.0, 1.5, 2.0, 2.5, 3.0 and 3.5; an extra amount per
 *   paycheck; a zero election for employees expecting no Arizona liability;
 *   "gross taxable wages" are the wages in box 1 of the federal W-2; without
 *   an A-4 the employer must withhold 2.0%.
 * - AZ DES, UIT-0603A Unemployment Insurance Tax Rate Chart for 2026,
 *   https://des.az.gov/sites/default/files/dl/UIT-0603A_FY26.pdf: taxable wage
 *   limit $8,000; new employer rate 2.00%. (des.az.gov refuses automated
 *   fetches; read through search extracts.)
 */

import { percentOf } from '../../money';
import {
  FEDERAL_INCOME_TAX_LIKE,
  FICA_LIKE,
  YtdWriter,
  certExtraCents,
  certString,
  computeSui,
  d,
  recordIncomeTax,
  residenceIssue,
  taxableWages,
  unsupportedYearResult,
} from './common';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'AZ';
const RULE_SET = 'us-az-2026.1';

/** Form A-4 (2026) box 1. */
export const AZ_A4_PERCENTAGES = ['0.5', '1.0', '1.5', '2.0', '2.5', '3.0', '3.5'] as const;
const DEFAULT_PERCENT = 2.0;

const UI_WAGE_BASE = d(8000);
const UI_NEW_EMPLOYER_RATE_PERCENT = 2.0;

function electedPercent(input: StateCalcInput): number {
  const chosen = certString(input, 'withholding_percent');
  return chosen && (AZ_A4_PERCENTAGES as readonly string[]).includes(chosen) ? Number(chosen) : DEFAULT_PERCENT;
}

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const ytd = new YtdWriter(input, STATE);
  const issues = [...residenceIssue(input, STATE)];

  const wages = taxableWages(input, FEDERAL_INCOME_TAX_LIKE);
  let incomeTax = 0;
  // A-4 box 2 (zero election) is the certificate's `exempt`; without an A-4 the default 2.0% applies.
  if (!input.certificate?.exempt) {
    incomeTax = percentOf(wages.total, electedPercent(input));
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

export const AZ_MODULE: StateModule = {
  code: STATE,
  name: 'Arizona',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'A-4',
    usesAllowances: false,
    fields: [
      { key: 'withholding_percent', type: 'select', options: [...AZ_A4_PERCENTAGES], required: true, labelKey: 'AZ.withholding_percent' },
      { key: 'extraWithholding', type: 'money', labelKey: 'AZ.extraWithholding' },
      { key: 'exempt', type: 'boolean', labelKey: 'AZ.exempt' },
    ],
  },
  calculate,
};
