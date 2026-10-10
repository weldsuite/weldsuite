/**
 * Georgia: income tax withholding (G-4, percentage method) and UI with the
 * administrative assessment.
 *
 * 2026 has two parameter sets. HB 463 (signed 11 May 2026, retroactive to
 * 1 January 2026) cut the rate from 5.19% to 4.99%, raised the standard
 * deduction to $15,000 / $30,000 and the dependent allowance to $5,000.
 * The DOR says employers must withhold at 5.19% before the change and can
 * begin withholding at 4.99% from 11 May 2026, so the module switches on
 * the pay date.
 *
 * Sources (fetched 9 October 2026):
 * - GA DOR, Employer's Tax Guide 2026, revised September 2026,
 *   https://dor.georgia.gov/document/document/2026-employers-tax-guide-updated-september-2026/download:
 *   What's new (p. 3); supplemental wages at the rate in effect (p. 14);
 *   no G-4 → single with zero allowances (p. 15–16); 401(k) deferrals come
 *   off wages (p. 27); percentage method, Table E and examples (p. 51–52).
 * - GA DOR, Employer's Tax Guide 2026, revised December 2025 (archived:
 *   https://web.archive.org/web/20260116155245id_/https://dor.georgia.gov/document/document/2026-employers-tax-guide/download):
 *   the pre-HB 463 Table E and example (p. 46).
 * - Form G-4 (Rev. 06/03/26), https://dor.georgia.gov/form-g-4-employee-withholding:
 *   marital status A–D, dependent allowances (line 4), Georgia adjustments
 *   allowances (line 5, $5,000 each per the worksheet), total on line 7.
 * - HB 463 (2026), https://gov.georgia.gov/document/2026-signed-legislation/hb-463/download.
 * - GA DOL employer FAQ, https://dol.georgia.gov/faqs-employers/employers-faqs-unemployment-insurance
 *   (wage base $9,500; new employer total rate 2.70%), and SB 160 (2023),
 *   O.C.G.A. 34-8-151(d) and 34-8-180/181: through 2026 new employers pay
 *   2.64% plus the 0.06% administrative assessment, which is not deducted
 *   from pay.
 *
 * Section 125, HSA and dependent care: the DOR publishes no explicit
 * statement; Georgia taxable income starts from federal AGI (O.C.G.A.
 * 48-7-27), so GA wages follow federal income tax wages.
 */

import { percentOf, type Cents } from '../../money';
import {
  FEDERAL_INCOME_TAX_LIKE,
  FICA_LIKE,
  YtdWriter,
  certBoolean,
  certExtraCents,
  certNumber,
  computeSui,
  d,
  periodTypeOf,
  recordIncomeTax,
  residenceIssue,
  roundCents,
  taxableWages,
  unsupportedFrequencyResult,
  unsupportedYearResult,
  type PeriodType,
  rateCode,
} from './common';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'GA';
const RULE_SET = 'us-ga-2026.2';

type GaStatus = 'single' | 'married_both_working' | 'married_one_working' | 'head_of_household';

interface GaParams {
  ratePercent: number;
  /** Table E: [(1) married filing joint, one spouse working; (2) single or head of household; (3) married filing separate / both working; (4) per allowance]. */
  tableE: Record<PeriodType, [number, number, number, number]>;
}

/** Employer's Tax Guide revised December 2025, Table E (p. 46). Pay dates before 11 May 2026. */
const BEFORE_HB463: GaParams = {
  ratePercent: 5.19,
  tableE: {
    weekly: [461.54, 230.77, 230.77, 76.92],
    biweekly: [923.08, 461.54, 461.54, 153.85],
    semimonthly: [1000, 500, 500, 166.67],
    monthly: [2000, 1000, 1000, 333.33],
    quarterly: [6000, 3000, 3000, 1000],
    semiannual: [12000, 6000, 6000, 2000],
    annual: [24000, 12000, 12000, 4000],
  },
};

/** Employer's Tax Guide revised September 2026, Table E (p. 51). Pay dates from 11 May 2026. */
const AFTER_HB463: GaParams = {
  ratePercent: 4.99,
  tableE: {
    weekly: [576.92, 288.46, 288.46, 96.15],
    biweekly: [1153.85, 576.92, 576.92, 192.31],
    semimonthly: [1250, 625, 625, 208.33],
    monthly: [2500, 1250, 1250, 416.67],
    quarterly: [7500, 3750, 3750, 1250],
    semiannual: [15000, 7500, 7500, 2500],
    annual: [30000, 15000, 15000, 5000],
  },
};

const HB463_WITHHOLDING_FROM = '2026-05-11';

const UI_WAGE_BASE = d(9500);
const UI_NEW_EMPLOYER_RATE_PERCENT = 2.64;
const ADMIN_ASSESSMENT_RATE_PERCENT = 0.06;

export function gaParams(payDate: string): GaParams {
  return payDate >= HB463_WITHHOLDING_FROM ? AFTER_HB463 : BEFORE_HB463;
}

function standardDeductionColumn(status: GaStatus): 0 | 1 | 2 {
  if (status === 'married_one_working') return 0;
  if (status === 'married_both_working') return 2;
  return 1;
}

/** Percentage method for one period (unrounded cents). Exported for the guide's examples. */
export function gaWithholding(wagesCents: Cents, status: GaStatus, allowances: number, period: PeriodType, params: GaParams): number {
  const row = params.tableE[period];
  const subject = wagesCents - d(row[standardDeductionColumn(status)]) - allowances * d(row[3]);
  return subject > 0 ? (subject * params.ratePercent) / 100 : 0;
}

function gaStatus(raw: string | null | undefined): GaStatus {
  return raw === 'married_both_working' || raw === 'married_one_working' || raw === 'head_of_household' ? raw : 'single';
}

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const period = periodTypeOf(input.periodsPerYear);
  if (!period) return unsupportedFrequencyResult(input, STATE, RULE_SET);

  const ytd = new YtdWriter(input, STATE);
  const issues = [...residenceIssue(input, STATE)];
  const params = gaParams(input.payDate);

  const wages = taxableWages(input, FEDERAL_INCOME_TAX_LIKE);
  const cert = input.certificate;
  let incomeTax = 0;
  const exempt = cert?.exempt === true || certBoolean(input, 'military_spouse_exempt');
  if (!exempt) {
    // No G-4: single with zero allowances.
    const status = gaStatus(cert?.filingStatus);
    // G-4 line 7: dependent allowances (line 4) plus Georgia adjustments allowances (line 5).
    const allowances = cert ? Math.max(0, Math.trunc(certNumber(input, 'dependent_allowances')) + Math.trunc(certNumber(input, 'adjustment_allowances'))) : 0;
    const regular = wages.regular > 0 ? roundCents(gaWithholding(wages.regular, status, allowances, period, params)) : 0;
    // Bonuses and other compensation: the rate in effect when paid (guide p. 14).
    incomeTax = regular + percentOf(wages.supplemental, params.ratePercent);
    if (wages.total > 0) incomeTax += certExtraCents(input);
  }
  recordIncomeTax(ytd, wages.total, incomeTax);

  const sui = computeSui(
    input,
    STATE,
    {
      wageBaseCents: UI_WAGE_BASE,
      newEmployerRatePercent: UI_NEW_EMPLOYER_RATE_PERCENT,
      exclusions: FICA_LIKE,
      surcharges: [{ code: 'ga_admin_assessment', labelKey: 'us.state_program.ga_admin_assessment', rateKey: 'ga_admin_assessment', defaultRatePercent: ADMIN_ASSESSMENT_RATE_PERCENT }],
    },
    ytd,
  );
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

export const GA_MODULE: StateModule = {
  code: STATE,
  name: 'Georgia',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'G-4',
    filingStatuses: ['single', 'married_both_working', 'married_one_working', 'head_of_household'],
    usesAllowances: true,
    fields: [
      { key: 'filingStatus', type: 'select', options: ['single', 'married_both_working', 'married_one_working', 'head_of_household'], required: true, labelKey: 'GA.filingStatus' },
      { key: 'dependent_allowances', type: 'number', labelKey: 'GA.dependent_allowances' },
      { key: 'adjustment_allowances', type: 'number', labelKey: 'GA.adjustment_allowances' },
      { key: 'extraWithholding', type: 'money', labelKey: 'GA.extraWithholding' },
      { key: 'exempt', type: 'boolean', labelKey: 'GA.exempt' },
      { key: 'military_spouse_exempt', type: 'boolean', labelKey: 'GA.military_spouse_exempt' },
    ],
  },
  employerRateCodes: [rateCode('ga_admin_assessment', 0.06)],
  calculate,
};
