/**
 * Pennsylvania: personal income tax withholding (flat 3.07%, no allowances)
 * and unemployment compensation (employer and the 0.07% employee share).
 * Local earned income and local services taxes are out of scope in v1.
 *
 * Sources (fetched 9 October 2026):
 * - PA DOR, Employer Withholding,
 *   https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/employer-withholding:
 *   flat 3.07% of compensation; REV-415 (Employer Withholding Information
 *   Guide) p. 11–12: supplemental compensation is added to the period's
 *   compensation at the same rate. Budget Office payroll memo #26-01: "remains
 *   at 3.07 percent for 2026".
 * - PA PIT Guide, Gross Compensation (08-2025), p. 31–32 and 51; REV-415 p. 6;
 *   letter ruling PIT-06-005: 401(k) deferrals and dependent care are PA
 *   compensation; Section 125 health/medical coverage and HSA contributions
 *   through the cafeteria plan are not.
 * - PA L&I, UC Yearly Tax Highlights, calendar year 2026,
 *   https://www.pa.gov/agencies/dli/resources/for-employers-and-educators/how-to-file/uc-tax/yearly-tax-highlights:
 *   wage base $10,000; new non-construction employer 3.8220% (surcharge
 *   included, no additional contributions); employee 0.07% of all gross wages,
 *   no cap. UC-820 (REV 09-25): construction 10.5924%.
 * - REV-419 (Employee's Nonwithholding Application Certificate): NJ residents
 *   under the NJ–PA reciprocal agreement and employees under Tax Forgiveness
 *   may stop PA withholding.
 *
 * Not verified: whether Section 125 health, HSA and dependent care salary
 * reductions are UC wages. UC Law section 4(x) (43 P.S. § 753(x)) names no
 * cafeteria plan; 401(k) deferrals are FUTA wages and so UC wages under
 * 4(x)(6). The module leaves those three out of UC wages (as for FUTA) and
 * flags the payslip `provisional_rules` when any of them is present.
 */

import { percentOf } from '../../money';
import {
  FICA_LIKE,
  YtdWriter,
  computeSui,
  d,
  provisionalIssue,
  recordIncomeTax,
  residenceIssue,
  taxableWages,
  unsupportedYearResult,
  type PretaxExclusions,
} from './common';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'PA';
const RULE_SET = 'us-pa-2026.1';

const RATE_PERCENT = 3.07;
const PIT_EXCLUSIONS: PretaxExclusions = { retirement401k: false, section125: true, hsa: true, dependentCare: false };

const UC_WAGE_BASE = d(10000);
const UC_NEW_EMPLOYER_RATE_PERCENT = 3.822;
const UC_EMPLOYEE_RATE_PERCENT = 0.07;

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const ytd = new YtdWriter(input, STATE);
  const p = input.pretax;
  const ucUnverified = p.section125Cents > 0 || p.hsaCents > 0 || p.dependentCareCents > 0;
  const issues = [...residenceIssue(input, STATE), ...provisionalIssue(STATE, ucUnverified ? ['UC wages of Section 125, HSA and dependent care salary reductions'] : [])];

  const wages = taxableWages(input, PIT_EXCLUSIONS);
  // REV-419 on file (NJ resident under reciprocity, or Tax Forgiveness): no PA withholding.
  const incomeTax = input.certificate?.exempt ? 0 : percentOf(wages.total, RATE_PERCENT);
  recordIncomeTax(ytd, wages.total, incomeTax);

  const sui = computeSui(
    input,
    STATE,
    {
      wageBaseCents: UC_WAGE_BASE,
      newEmployerRatePercent: UC_NEW_EMPLOYER_RATE_PERCENT,
      exclusions: FICA_LIKE,
      employee: { ratePercent: UC_EMPLOYEE_RATE_PERCENT, wageBaseCents: null },
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

export const PA_MODULE: StateModule = {
  code: STATE,
  name: 'Pennsylvania',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'REV-419',
    usesAllowances: false,
    fields: [{ key: 'exempt', type: 'boolean', labelKey: 'PA.exempt' }],
  },
  calculate,
};
