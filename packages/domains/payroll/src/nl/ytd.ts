/**
 * Year-to-date accumulators of the Dutch engine.
 *
 * `PayslipResult.ytd` is the input `ytd` plus this payslip. hr-api stores it
 * on each final payslip and passes the latest one back for the next period of
 * the same tax year (and reads the closing values for the jaaropgaaf, the
 * holiday-allowance balance and next year's special-reward table).
 *
 * Amounts are cents. Counts that are not money are scaled to integers so
 * accumulating them never drifts: hours ×100, months ×10 000.
 */

import type { Cents } from '../money';

export const NL_YTD_KEYS = {
  /** Loon voor de loonbelasting/volksverzekeringen (loonstaat column 14), incl. special rewards. Next year's special-reward annual wage. */
  loonLbPh: 'nl.loon_lb',
  /** Part of `loonLbPh` taxed with the special-reward table. */
  loonBb: 'nl.loon_bb',
  /** Loon voor de werknemersverzekeringen (column 8). */
  loonSv: 'nl.loon_sv',
  /** Loon voor de Zvw (column 12). */
  loonZvw: 'nl.loon_zvw',
  /** Loon in geld (column 3) and loon in natura (column 4). */
  cashWage: 'nl.cash_wage',
  inKindWage: 'nl.in_kind_wage',
  /** Gross cash pay (earning lines) and net pay. */
  gross: 'nl.gross',
  net: 'nl.net',
  /** Withheld loonbelasting/premie volksverzekeringen (column 15) and the labour credit applied (column 18). */
  wageTax: 'nl.wage_tax',
  labourCredit: 'nl.labour_credit',
  /** Zvw: withheld contribution (column 16) and employer levy. */
  zvwWithheld: 'nl.zvw_withheld',
  zvwEmployerLevy: 'nl.zvw_employer_levy',
  /** Employer premiums. */
  awfPremium: 'nl.awf_premium',
  aofPremium: 'nl.aof_premium',
  wkoPremium: 'nl.wko_premium',
  whkPremium: 'nl.whk_premium',
  /**
   * Voortschrijdend cumulatief rekenen (Handboek ch. 6), per fund: cumulative
   * wage, cumulative maximum (sum of period maxima) and cumulative premium base
   * (premieloon / bijdrageloon). The aanwas of a period is the change of the base.
   */
  awfCumWage: 'nl.awf_cum_wage',
  awfCumMax: 'nl.awf_cum_max',
  awfCumBase: 'nl.awf_cum_base',
  aofCumWage: 'nl.aof_cum_wage',
  aofCumMax: 'nl.aof_cum_max',
  aofCumBase: 'nl.aof_cum_base',
  whkCumWage: 'nl.whk_cum_wage',
  whkCumMax: 'nl.whk_cum_max',
  whkCumBase: 'nl.whk_cum_base',
  zvwCumWage: 'nl.zvw_cum_wage',
  zvwCumMax: 'nl.zvw_cum_max',
  zvwCumBase: 'nl.zvw_cum_base',
  /** Holiday allowance: opening balance carried into the year, accrued and paid this year. */
  holidayAllowanceOpening: 'nl.holiday_allowance_opening',
  holidayAllowanceAccrued: 'nl.holiday_allowance_accrued',
  holidayAllowancePaid: 'nl.holiday_allowance_paid',
  /** Special rewards paid (gross) and the transitievergoeding. */
  specialRewards: 'nl.special_rewards',
  transitionPayment: 'nl.transition_payment',
  /** Pension premiums, company car, tax-free allowances, 30% allowance. */
  pensionEmployee: 'nl.pension_employee',
  pensionEmployer: 'nl.pension_employer',
  companyCarValue: 'nl.company_car_value',
  companyCarContribution: 'nl.company_car_contribution',
  taxFreeAllowances: 'nl.tax_free_allowances',
  expatAllowance: 'nl.expat_allowance',
  travelAllowanceTaxFree: 'nl.travel_allowance_tax_free',
  overtimeWage: 'nl.overtime_wage',
  /** Verloonde uren ×100 and SV days. */
  hoursPaidX100: 'nl.hours_paid_x100',
  svDays: 'nl.sv_days',
  /** Months on the payroll this year ×10 000 (calendar-day fraction per month), for annualising. */
  monthsEmployedX10000: 'nl.months_employed_x10000',
  /** Employer cost (gross + employer premiums + employer pension + reimbursements). */
  employerCost: 'nl.employer_cost',
} as const;

export type NlYtdKey = (typeof NL_YTD_KEYS)[keyof typeof NL_YTD_KEYS];

/** Read an accumulator (0 when absent). */
export function ytdValue(ytd: Record<string, number>, key: NlYtdKey): number {
  const v = ytd[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Holiday allowance reserved and not yet paid, from a payslip's `ytd`. */
export function nlHolidayAllowanceBalance(ytd: Record<string, number>): Cents {
  return (
    ytdValue(ytd, NL_YTD_KEYS.holidayAllowanceOpening) +
    ytdValue(ytd, NL_YTD_KEYS.holidayAllowanceAccrued) -
    ytdValue(ytd, NL_YTD_KEYS.holidayAllowancePaid)
  );
}

/**
 * The annual wage for next year's special-reward table, from the last final
 * payslip's `ytd` of the previous year (pass it as `previousYearAnnualWageCents`).
 *
 * Handboek §9.3.6: the whole year's column-14 wage when employed the whole
 * year; when employed part of the year, that wage annualised ("is de
 * werknemer op 15 november in dienst getreden en is zijn cumulatieve loon op
 * 31 december 3.000, dan is het tot jaarloon herleide bedrag (3.000 : 1,5) x 12
 * = 24.000"). Months employed come from `monthsEmployedX10000`.
 */
export function nlAnnualWageForSpecialRewards(previousYearYtd: Record<string, number>): Cents | null {
  const wage = ytdValue(previousYearYtd, NL_YTD_KEYS.loonLbPh);
  const months = ytdValue(previousYearYtd, NL_YTD_KEYS.monthsEmployedX10000) / 10_000;
  if (months <= 0) return null;
  if (months >= 12) return wage;
  return Math.round((wage / months) * 12);
}
