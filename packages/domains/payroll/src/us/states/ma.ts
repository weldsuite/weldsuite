/**
 * Massachusetts: income tax withholding (M-4, Circular M percentage method
 * with the 4% surtax), Paid Family and Medical Leave, UI with the COVID-19
 * recovery assessment, the Workforce Training Fund and EMAC.
 *
 * Sources (fetched 9 October 2026):
 * - MA DOR, Circular M (Rev. 12/25), "Income Tax Withholding Tables at 5.0%
 *   Effective January 1, 2026; Percentage Method Tables updated to include
 *   4% Surtax", mass.gov/dor: percentage method for wages (p. 12): subtract
 *   FICA/Medicare/retirement contributions (at most $2,000 a year) and the
 *   exemption factors, annualize, 5% up to $1,107,750 and 9% above it,
 *   de-annualize, then the head-of-household and blindness tax values; no
 *   withholding below the low-wage thresholds when an exemption is claimed;
 *   supplemental wage payments (section G and its example, p. 13).
 * - Form M-4 (Rev. 3/24): line 4 total exemptions (a claimed spouse counts as
 *   4), line 5 additional withholding, A head of household, B blind,
 *   C spouse blind, D full-time student (no withholding). No M-4 → no
 *   exemptions.
 * - 830 CMR 62B.2.1, https://www.mass.gov/regulations/830-CMR-62b21-withholding-of-taxes-on-wages-and-other-payments:
 *   withholding wages are IRC § 3401(a) wages; letter rulings 83-37 (401(k))
 *   and 83-82 (cafeteria plans) follow federal treatment.
 * - DFML, "Effective Rates: 2026" notices for employers with 25 or more and
 *   with fewer than 25 covered individuals: 0.88% (medical 0.70%, family
 *   0.18%); employees pay at most 40% of medical (0.28%) and all of family
 *   (0.18%); small employers owe no employer share.
 * - DUA, "2026 UI & COVID-19 Recovery Assessment Rate Schedule" (schedule E)
 *   and "The Employer's Guide to Unemployment Insurance": wage base $15,000;
 *   new (non-construction) employers pay the rate for a positive reserve of
 *   10.5–11.0% (2026: 2.42%, confirmed by
 *   https://www.mass.gov/info-details/employer-contributions-to-unemployment);
 *   WTFP 0.056%. The COVID-19 recovery assessment follows the UI rate on the
 *   schedule; new employers paying new-employer rates are exempt
 *   (https://www.mass.gov/info-details/covid-19-recovery-assessment-rates).
 *   EMAC (https://www.mass.gov/info-details/employer-medical-assistance-contribution-emac):
 *   exempt for years 1–3, then 0.12% / 0.24% / 0.34%, none in a quarter with
 *   fewer than six employees.
 * - DFML, https://www.mass.gov/info-details/wage-contributions-reporting-for-paid-family-and-medical-leave:
 *   PFML wages follow M.G.L. c. 151A § 1 and include pre-tax cafeteria plan
 *   payments; contributions stop at the Social Security wage base (84,500).
 *
 * UI wages are taken to follow FUTA wages (Section 125 out); DUA publishes no
 * item-by-item list.
 */

import { percentOf, type Cents } from '../../money';
import type { PayrollIssue } from '../../types';
import {
  FEDERAL_INCOME_TAX_LIKE,
  FICA_LIKE,
  YtdWriter,
  certAllowances,
  certBoolean,
  certExtraCents,
  computeSharedProgram,
  computeSui,
  d,
  periodTypeOf,
  readYtd,
  recordIncomeTax,
  residenceIssue,
  roundCents,
  taxableWages,
  unsupportedFrequencyResult,
  unsupportedYearResult,
  type PeriodType,
  NO_EXCLUSIONS,
  rateCode,
} from './common';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'MA';
const RULE_SET = 'us-ma-2026.1';

const RATE_PERCENT = 5;
const SURTAX_RATE_PERCENT = 9;
const SURTAX_THRESHOLD = d(1107750);
const FICA_DEDUCTION_ANNUAL_MAX = d(2000);
/** Estimate when the federal engine does not pass the FICA withheld. */
const FICA_ESTIMATE_PERCENT = 7.65;

/** Exemption factor: `perExemption × n + base` (n ≥ 1); quarterly and semiannual from section G. */
const EXEMPTION_FACTOR: Record<PeriodType, { perExemption: number; base: number }> = {
  weekly: { perExemption: 19, base: 66 },
  biweekly: { perExemption: 38, base: 131 },
  semimonthly: { perExemption: 42, base: 141 },
  monthly: { perExemption: 83, base: 284 },
  quarterly: { perExemption: 250, base: 850 },
  semiannual: { perExemption: 500, base: 1700 },
  annual: { perExemption: 1000, base: 3400 },
};
/** Head-of-household and blindness tax values; quarterly and semiannual as annual ÷ periods. */
const HOH_TAX_VALUE: Record<PeriodType, number> = { weekly: 2.31, biweekly: 4.62, semimonthly: 5, monthly: 10, quarterly: 30, semiannual: 60, annual: 120 };
const BLIND_TAX_VALUE: Record<PeriodType, number> = { weekly: 2.12, biweekly: 4.23, semimonthly: 4.58, monthly: 9.17, quarterly: 27.5, semiannual: 55, annual: 110 };
/** No withholding below these wages when one or more exemptions are claimed; quarterly and semiannual derived from $8,000. */
const LOW_WAGE: Record<PeriodType, number> = { weekly: 154, biweekly: 308, semimonthly: 333, monthly: 667, quarterly: 2000, semiannual: 4000, annual: 8000 };

/** PFML 2026. */
const PFML_TOTAL_RATE_PERCENT = 0.88; // medical 0.70% + family 0.18%
const PFML_EMPLOYEE_MAX_RATE_PERCENT = 0.46; // 40% of medical (0.28%) + all of family (0.18%)
const PFML_SMALL_EMPLOYER_LIMIT = 25;
const PFML_WAGE_BASE = d(184500);

/** DUA 2026. */
const UI_WAGE_BASE = d(15000);
const UI_NEW_EMPLOYER_RATE_PERCENT = 2.42;
const WTF_RATE_PERCENT = 0.056;
const EMAC_SMALL_EMPLOYER_LIMIT = 6;
const EMAC_DEFAULT_ESTABLISHED_PERCENT = 0.34;

/** 2026 schedule E: UI rate → COVID-19 recovery assessment rate. */
const COVID_RECOVERY_BY_UI_RATE: Record<string, number> = {
  '0.94': 0.178, '1.08': 0.204, '1.21': 0.229, '1.34': 0.253, '1.61': 0.304, '1.75': 0.331, '1.89': 0.357, '2.01': 0.38,
  '2.15': 0.406, '2.29': 0.433, '2.42': 0.457, '2.56': 0.484, '2.69': 0.508, '2.82': 0.533, '2.96': 0.559, '3.09': 0.584,
  '3.23': 0.61, '3.37': 0.637, '3.5': 0.662, '3.63': 0.686, '3.76': 0.711, '3.9': 0.737, '4.04': 0.764, '4.17': 0.788,
  '4.3': 0.813, '4.44': 0.839, '4.57': 0.864, '4.71': 0.89, '4.84': 0.915, '4.98': 0.941, '5.11': 0.966, '5.24': 0.99,
  '7.03': 1.329, '7.64': 1.444, '8.26': 1.561, '8.86': 1.675, '9.48': 1.792, '10.09': 1.907, '10.7': 2.022, '11.31': 2.138,
  '11.93': 2.255, '12.53': 2.368, '13.15': 2.485, '13.76': 2.601, '14.37': 2.716,
};

function exemptionFactor(period: PeriodType, exemptions: number): Cents {
  if (exemptions <= 0) return 0;
  const f = EXEMPTION_FACTOR[period];
  return d(f.perExemption * exemptions + f.base);
}

function annualTax(annualCents: number): number {
  if (annualCents <= 0) return 0;
  const surtaxed = Math.max(0, annualCents - SURTAX_THRESHOLD);
  return ((annualCents - surtaxed) * RATE_PERCENT + surtaxed * SURTAX_RATE_PERCENT) / 100;
}

export interface MaRegularInput {
  period: PeriodType;
  periodsPerYear: number;
  wagesCents: Cents;
  /** FICA/Medicare/retirement amount subtracted this period (already capped at the yearly $2,000). */
  ficaDeductionCents: Cents;
  exemptions: number;
  headOfHousehold: boolean;
  blindCount: number;
}

/** Percentage method for regular wages (unrounded cents). Exported for tests. */
export function maRegularWithholding(input: MaRegularInput): number {
  const { period, periodsPerYear } = input;
  if (input.exemptions > 0 && input.wagesCents < d(LOW_WAGE[period])) return 0;
  const net = input.wagesCents - input.ficaDeductionCents - exemptionFactor(period, input.exemptions);
  let tax = annualTax(net * periodsPerYear) / periodsPerYear;
  if (input.headOfHousehold) tax -= d(HOH_TAX_VALUE[period]);
  tax -= input.blindCount * d(BLIND_TAX_VALUE[period]);
  return Math.max(0, tax);
}

/**
 * Section G for a supplemental wage payment: 5%, or the surtax share when the
 * payment plus annualized regular wages (less FICA and exemptions) plus earlier
 * supplemental payments exceed the threshold (unrounded cents).
 */
export function maSupplementalWithholding(supplementalCents: Cents, annualizedNetRegularCents: Cents, priorSupplementalCents: Cents): number {
  if (supplementalCents <= 0) return 0;
  const total = supplementalCents + Math.max(0, annualizedNetRegularCents) + priorSupplementalCents;
  if (total <= SURTAX_THRESHOLD) return (supplementalCents * RATE_PERCENT) / 100;
  const excess = Math.min(supplementalCents, total - SURTAX_THRESHOLD);
  return Math.min((supplementalCents * SURTAX_RATE_PERCENT) / 100, (excess * SURTAX_RATE_PERCENT + (supplementalCents - excess) * RATE_PERCENT) / 100);
}

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const period = periodTypeOf(input.periodsPerYear);
  if (!period) return unsupportedFrequencyResult(input, STATE, RULE_SET);

  const ytd = new YtdWriter(input, STATE);
  const issues: PayrollIssue[] = [...residenceIssue(input, STATE)];
  const wages = taxableWages(input, FEDERAL_INCOME_TAX_LIKE);
  const cert = input.certificate;

  // Circular M step 1: FICA, Medicare and retirement contributions, at most $2,000 a year.
  const ficaThisPeriod = input.ficaEmployeeCents ?? percentOf(taxableWages(input, FICA_LIKE).total, FICA_ESTIMATE_PERCENT);
  const ficaDeduction = Math.max(0, Math.min(ficaThisPeriod, FICA_DEDUCTION_ANNUAL_MAX - readYtd(input, STATE, 'fica_deduction')));
  ytd.add('fica_deduction', ficaDeduction);

  let incomeTax = 0;
  const noWithholding = cert?.exempt === true || certBoolean(input, 'full_time_student') || certBoolean(input, 'military_spouse_exempt');
  if (!noWithholding) {
    // No M-4: no exemptions.
    const exemptions = cert ? certAllowances(input) : 0;
    const regular =
      wages.regular > 0
        ? roundCents(
            maRegularWithholding({
              period,
              periodsPerYear: input.periodsPerYear,
              wagesCents: wages.regular,
              ficaDeductionCents: ficaDeduction,
              exemptions,
              headOfHousehold: certBoolean(input, 'head_of_household'),
              blindCount: (certBoolean(input, 'blind') ? 1 : 0) + (certBoolean(input, 'spouse_blind') ? 1 : 0),
            }),
          )
        : 0;
    const annualizedNetRegular = wages.regular * input.periodsPerYear - FICA_DEDUCTION_ANNUAL_MAX - exemptionFactor('annual', exemptions);
    const supplemental = roundCents(maSupplementalWithholding(wages.supplemental, wages.regular > 0 ? annualizedNetRegular : 0, readYtd(input, STATE, 'supplemental_wages')));
    incomeTax = regular + supplemental;
    if (wages.total > 0) incomeTax += certExtraCents(input);
  }
  ytd.add('supplemental_wages', wages.supplemental);
  recordIncomeTax(ytd, wages.total, incomeTax);

  // UI: the entered rate is the UI rate of the notice; the COVID-19 recovery assessment follows it on schedule E.
  // New employers at the new-employer rate (no rate entered) do not pay it.
  const covidRate =
    input.extraRates.ma_covid_recovery ?? (input.suiRatePercent === null ? 0 : COVID_RECOVERY_BY_UI_RATE[String(input.suiRatePercent)]);
  if (covidRate === undefined) {
    issues.push({ severity: 'warning', code: 'employer_incomplete', params: { state: STATE, field: 'ma_covid_recovery' } });
  }
  const headcount = input.employeeCountEstimate;
  let emacRate = input.extraRates.ma_emac;
  if (emacRate === undefined) {
    if (input.suiRatePercent === null) emacRate = 0; // new employers: exempt for the first three years
    else {
      emacRate = EMAC_DEFAULT_ESTABLISHED_PERCENT;
      issues.push({ severity: 'warning', code: 'employer_incomplete', params: { state: STATE, field: 'ma_emac', fallbackRatePercent: emacRate } });
    }
  }
  if (headcount !== null && headcount < EMAC_SMALL_EMPLOYER_LIMIT) emacRate = 0;

  const sui = computeSui(
    input,
    STATE,
    {
      wageBaseCents: UI_WAGE_BASE,
      newEmployerRatePercent: UI_NEW_EMPLOYER_RATE_PERCENT,
      exclusions: FICA_LIKE,
      surcharges: [
        { code: 'ma_covid_recovery', labelKey: 'us.state_program.ma_covid_recovery', rateKey: 'ma_covid_recovery', defaultRatePercent: covidRate ?? 0 },
        { code: 'ma_wtf', labelKey: 'us.state_program.ma_wtf', rateKey: 'ma_wtf', defaultRatePercent: WTF_RATE_PERCENT },
        { code: 'ma_emac', labelKey: 'us.state_program.ma_emac', rateKey: 'ma_emac_effective', defaultRatePercent: emacRate },
      ],
    },
    ytd,
  );
  issues.push(...sui.issues);

  if (headcount === null) {
    issues.push({ severity: 'warning', code: 'employer_incomplete', params: { state: STATE, field: 'employeeCountEstimate' } });
  }
  // Employers with 25+ covered individuals remit 0.88% and may deduct up to 0.46%; smaller employers remit
  // only the 0.46%. The employer may carry (part of) the employee share: `extraRates.ma_pfml_employee` (percent).
  const pfml = computeSharedProgram(
    input,
    STATE,
    {
      code: 'ma_pfml',
      labelKey: 'us.state_program.ma_pfml',
      wagesCents: input.exemptFromSui ? 0 : taxableWages(input, NO_EXCLUSIONS).total,
      wageBaseCents: PFML_WAGE_BASE,
      totalRatePercent: PFML_TOTAL_RATE_PERCENT,
      employeeMaxRatePercent: PFML_EMPLOYEE_MAX_RATE_PERCENT,
      employeeRatePercent: input.extraRates.ma_pfml_employee,
      employerOwesShare: headcount === null || headcount >= PFML_SMALL_EMPLOYER_LIMIT,
    },
    ytd,
  );

  return {
    stateWagesCents: wages.total,
    incomeTaxCents: incomeTax,
    sui: sui.sui,
    programs: [pfml, ...sui.programs],
    ytdUpdates: ytd.updates,
    issues,
    ruleSet: RULE_SET,
  };
}

export const MA_MODULE: StateModule = {
  code: STATE,
  name: 'Massachusetts',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'M-4',
    usesAllowances: true,
    fields: [
      { key: 'allowances', type: 'number', required: true, labelKey: 'MA.allowances' },
      { key: 'extraWithholding', type: 'money', labelKey: 'MA.extraWithholding' },
      { key: 'head_of_household', type: 'boolean', labelKey: 'MA.head_of_household' },
      { key: 'blind', type: 'boolean', labelKey: 'MA.blind' },
      { key: 'spouse_blind', type: 'boolean', labelKey: 'MA.spouse_blind' },
      { key: 'full_time_student', type: 'boolean', labelKey: 'MA.full_time_student' },
      { key: 'military_spouse_exempt', type: 'boolean', labelKey: 'MA.military_spouse_exempt' },
    ],
  },
  employerRateCodes: [rateCode('ma_covid_recovery'), rateCode('ma_wtf', 0.056), rateCode('ma_emac'), rateCode('ma_pfml_employee', 0.46)],
  calculate,
};
