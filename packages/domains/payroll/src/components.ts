/**
 * The catalog of pay components: everything that can appear as a recurring
 * component on an employee (`hr_pay_components`) or as a one-off input on a
 * pay run (`hr_pay_run_inputs`).
 *
 * The catalog says what a code is and what it needs. How it is taxed is the
 * country engine's business (nl/calculate.ts, us/calculate.ts), keyed by the
 * same code. hr-api validates codes against this list, and the UI builds its
 * pickers and forms from it; labels are translated by `labelKey` in
 * @weldsuite/i18n (`weldhr.payroll.components.<labelKey>`).
 */

import type { PayrollCountry } from './types';

export type ComponentKind = 'earning' | 'deduction' | 'reimbursement' | 'employer';

/** What the user enters for the component. */
export type ComponentEntry =
  /** Hours (`quantity`), optionally with a `rate` (hourly rate or a percentage for overtime). */
  | 'hours'
  /** A money amount. */
  | 'amount'
  /** Days (`quantity`), e.g. home-working days. */
  | 'days'
  /** Only `params` (company car: list price and percentage). */
  | 'params';

export interface ComponentParamDef {
  key: string;
  type: 'number' | 'percent' | 'money' | 'boolean' | 'date';
  required?: boolean;
}

export interface ComponentDef {
  code: string;
  countries: PayrollCountry[];
  kind: ComponentKind;
  entry: ComponentEntry;
  /** Can be set up as a recurring component on the employee. */
  recurring: boolean;
  /** Can be added as a one-off input on a pay run. */
  oneOff: boolean;
  /** Collected automatically when a run is prepared (attendance, leave, declarations). */
  collected?: boolean;
  params?: ComponentParamDef[];
  /** Translation key under `weldhr.payroll.components`. */
  labelKey: string;
}

export const PAY_COMPONENTS: readonly ComponentDef[] = [
  // ---- Both countries ------------------------------------------------------
  { code: 'hours.regular', countries: ['NL', 'US'], kind: 'earning', entry: 'hours', recurring: false, oneOff: true, collected: true, labelKey: 'hoursRegular' },
  {
    code: 'hours.overtime',
    countries: ['NL', 'US'],
    kind: 'earning',
    entry: 'hours',
    recurring: false,
    oneOff: true,
    // NL: `rate` is the overtime percentage (125 = 125%). US: computed from regular hours per FLSA workweek;
    // a manual line is for overtime outside that rule (e.g. a double-time agreement), rate = multiplier percent.
    labelKey: 'hoursOvertime',
  },
  { code: 'hours.unpaid_leave', countries: ['NL', 'US'], kind: 'deduction', entry: 'hours', recurring: false, oneOff: true, collected: true, labelKey: 'hoursUnpaidLeave' },
  { code: 'hours.paid_leave', countries: ['US'], kind: 'earning', entry: 'hours', recurring: false, oneOff: true, collected: true, labelKey: 'hoursPaidLeave' },
  { code: 'bonus', countries: ['NL', 'US'], kind: 'earning', entry: 'amount', recurring: false, oneOff: true, labelKey: 'bonus' },
  { code: 'commission', countries: ['NL', 'US'], kind: 'earning', entry: 'amount', recurring: false, oneOff: true, labelKey: 'commission' },
  { code: 'allowance.taxable', countries: ['NL', 'US'], kind: 'earning', entry: 'amount', recurring: true, oneOff: true, labelKey: 'allowanceTaxable' },
  { code: 'reimbursement', countries: ['NL', 'US'], kind: 'reimbursement', entry: 'amount', recurring: true, oneOff: true, collected: true, labelKey: 'reimbursement' },
  { code: 'deduction.net', countries: ['NL', 'US'], kind: 'deduction', entry: 'amount', recurring: true, oneOff: true, labelKey: 'deductionNet' },
  { code: 'advance', countries: ['NL', 'US'], kind: 'reimbursement', entry: 'amount', recurring: false, oneOff: true, labelKey: 'advance' },

  // ---- Netherlands ---------------------------------------------------------
  {
    code: 'nl.travel_allowance',
    countries: ['NL'],
    kind: 'reimbursement',
    entry: 'amount',
    recurring: true,
    oneOff: true,
    // Either a fixed amount, or `km_per_day` × `days_per_month`: tax-free up to the yearly per-km limit.
    params: [
      { key: 'km_per_day', type: 'number' },
      { key: 'days_per_month', type: 'number' },
    ],
    labelKey: 'nlTravelAllowance',
  },
  { code: 'nl.home_working_allowance', countries: ['NL'], kind: 'reimbursement', entry: 'days', recurring: true, oneOff: true, labelKey: 'nlHomeWorkingAllowance' },
  {
    code: 'nl.company_car',
    countries: ['NL'],
    kind: 'earning',
    entry: 'params',
    recurring: true,
    oneOff: false,
    params: [
      { key: 'list_price', type: 'money', required: true },
      { key: 'percent', type: 'percent', required: true },
      { key: 'zero_emission_cap', type: 'money' },
      { key: 'zero_emission_percent', type: 'percent' },
      { key: 'employee_contribution', type: 'money' },
    ],
    labelKey: 'nlCompanyCar',
  },
  {
    code: 'nl.pension_employee',
    countries: ['NL'],
    kind: 'deduction',
    entry: 'amount',
    recurring: true,
    oneOff: false,
    // Insured pension: the employee's premium. `percent` of the pension base (salary minus `franchise` per year) or a fixed amount.
    params: [
      { key: 'percent', type: 'percent' },
      { key: 'franchise_per_year', type: 'money' },
    ],
    labelKey: 'nlPensionEmployee',
  },
  {
    code: 'nl.pension_employer',
    countries: ['NL'],
    kind: 'employer',
    entry: 'amount',
    recurring: true,
    oneOff: false,
    params: [
      { key: 'percent', type: 'percent' },
      { key: 'franchise_per_year', type: 'money' },
    ],
    labelKey: 'nlPensionEmployer',
  },
  { code: 'nl.thirteenth_month', countries: ['NL'], kind: 'earning', entry: 'amount', recurring: false, oneOff: true, labelKey: 'nlThirteenthMonth' },
  { code: 'nl.leave_payout', countries: ['NL'], kind: 'earning', entry: 'hours', recurring: false, oneOff: true, labelKey: 'nlLeavePayout' },
  { code: 'nl.holiday_allowance_payout', countries: ['NL'], kind: 'earning', entry: 'amount', recurring: false, oneOff: true, labelKey: 'nlHolidayAllowancePayout' },
  {
    code: 'nl.sick_pay',
    countries: ['NL'],
    kind: 'deduction',
    entry: 'hours',
    recurring: false,
    oneOff: true,
    collected: true,
    // Sick hours paid at `rate` percent (70 by law, 100 when the employer tops up). Below 100 reduces pay.
    labelKey: 'nlSickPay',
  },
  { code: 'nl.transition_payment', countries: ['NL'], kind: 'earning', entry: 'amount', recurring: false, oneOff: true, labelKey: 'nlTransitionPayment' },

  // ---- United States -------------------------------------------------------
  { code: 'us.tips_cash', countries: ['US'], kind: 'earning', entry: 'amount', recurring: false, oneOff: true, labelKey: 'usTipsCash' },
  {
    code: 'us.401k',
    countries: ['US'],
    kind: 'deduction',
    entry: 'amount',
    recurring: true,
    oneOff: false,
    params: [{ key: 'percent', type: 'percent' }],
    labelKey: 'us401k',
  },
  {
    code: 'us.roth_401k',
    countries: ['US'],
    kind: 'deduction',
    entry: 'amount',
    recurring: true,
    oneOff: false,
    params: [{ key: 'percent', type: 'percent' }],
    labelKey: 'usRoth401k',
  },
  {
    code: 'us.401k_employer_match',
    countries: ['US'],
    kind: 'employer',
    entry: 'amount',
    recurring: true,
    oneOff: false,
    params: [
      { key: 'match_percent', type: 'percent' },
      { key: 'match_limit_percent', type: 'percent' },
    ],
    labelKey: 'us401kEmployerMatch',
  },
  { code: 'us.section125_health', countries: ['US'], kind: 'deduction', entry: 'amount', recurring: true, oneOff: false, labelKey: 'usSection125Health' },
  { code: 'us.employer_health', countries: ['US'], kind: 'employer', entry: 'amount', recurring: true, oneOff: false, labelKey: 'usEmployerHealth' },
  { code: 'us.hsa', countries: ['US'], kind: 'deduction', entry: 'amount', recurring: true, oneOff: false, labelKey: 'usHsa' },
  { code: 'us.dependent_care', countries: ['US'], kind: 'deduction', entry: 'amount', recurring: true, oneOff: false, labelKey: 'usDependentCare' },
];

const byCode = new Map(PAY_COMPONENTS.map((c) => [c.code, c]));

export function componentDef(code: string): ComponentDef | undefined {
  return byCode.get(code);
}

export function componentsFor(country: PayrollCountry, use: 'recurring' | 'oneOff'): ComponentDef[] {
  return PAY_COMPONENTS.filter((c) => c.countries.includes(country) && c[use]);
}

/**
 * Issue codes the engines and hr-api raise. The UI translates
 * `weldhr.payroll.issues.<code>` with the issue's `params`.
 */
export const ISSUE_CODES = [
  // Setup — block the run for that employee
  'missing_compensation',
  'missing_tax_id',
  'missing_bank_account',
  'missing_date_of_birth',
  'missing_tax_election',
  'missing_work_state',
  'unsupported_state',
  'unsupported_tax_year',
  'unsupported_frequency',
  'unsupported_component',
  'employer_incomplete',
  'negative_net_pay',
  'below_minimum_wage',
  // Warnings
  'provisional_rules',
  'anonymous_rate',
  'first_payslip',
  'large_change',
  'partial_period',
  'no_hours',
  'w4_missing_default_single',
  'ss_wage_base_reached',
  'additional_medicare_started',
  'net_pay_zero',
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];
