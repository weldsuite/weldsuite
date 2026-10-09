/**
 * Federal income tax withholding: Pub 15-T (2026) section 1, Worksheet 1A
 * ("Employer's Withholding Worksheet for Percentage Method Tables for
 * Automated Payroll Systems") with the Annual Percentage Method tables, and
 * the supplemental-wage rules of Pub 15 section 7.
 *
 * Both Form W-4 regimes go through Worksheet 1A as written:
 * - a 2020-or-later form uses lines 1d–1i (Step 4(a), Step 4(b), and line 1g
 *   unless the Step 2 box is checked) and Step 3 credits;
 * - a 2019-or-earlier form uses lines 1j–1l ($4,300 per allowance) and the
 *   STANDARD schedules (Single or Married; never Head of Household).
 * The optional "computational bridge" (treating an old form as a 2020+ form
 * with Step 4(a) = $8,600/$12,900 and Step 4(b) = allowances × $4,300) gives
 * the same result; the tests prove that equivalence.
 *
 * Rounding: Pub 15-T allows, but does not require, rounding to whole dollars.
 * The engine keeps cents: the annual amount is computed exactly and the
 * per-period withholding is rounded once, half away from zero, to the cent.
 */

import { roundHalfAwayFromZero, type Cents } from '../money';
import type { UsW4Input } from '../types';
import type { FederalRules, W4FilingStatus, WithholdingRow } from './federal-rules';

/** Worksheet 1A, Table 3 uses 52 and 26; a 53rd weekly (27th biweekly) payday is still annualized as 52 (26). */
export function nominalPeriodsPerYear(periodsPerYear: number): number {
  if (periodsPerYear === 53) return 52;
  if (periodsPerYear === 27) return 26;
  return periodsPerYear;
}

/** Tax on an annual amount from a schedule (unrounded cents): column C + column D × (amount − column A). */
export function annualScheduleTax(adjustedAnnualCents: number, rows: readonly WithholdingRow[]): number {
  if (adjustedAnnualCents <= 0) return 0;
  let match: WithholdingRow | undefined;
  for (const r of rows) {
    if (adjustedAnnualCents >= r.atLeastCents) match = r;
    else break;
  }
  if (!match) return 0;
  return match.baseCents + ((adjustedAnnualCents - match.atLeastCents) * match.ratePercent) / 100;
}

/** The W-4 in force, with Pub 15-T's default for an employee who furnished none. */
export function effectiveW4(w4: UsW4Input | null): UsW4Input {
  if (w4) return w4;
  // Pub 15-T (2026), "New employee fails to furnish Form W-4": treated as Single or Married
  // filing separately with no entries in Step 2, Step 3 or Step 4.
  return {
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
  };
}

export function isPre2020W4(w4: UsW4Input): boolean {
  return w4.formYear < 2020;
}

function dollarsToCents(n: number | null | undefined): Cents {
  if (n === null || n === undefined || !Number.isFinite(n)) return 0;
  return roundHalfAwayFromZero(n * 100);
}

/** The nonresident alien add-on for this payroll period (Pub 15-T Table 1 or Table 2). */
export function nraAdditionCents(rules: FederalRules, w4: UsW4Input, periodsPerYear: number): Cents {
  if (!w4.nonresidentAlien) return 0;
  const table = isPre2020W4(w4) ? rules.withholding.nraAdditionPre2020 : rules.withholding.nraAddition2020;
  const periods = nominalPeriodsPerYear(periodsPerYear);
  const perPeriod = table[periods];
  if (perPeriod !== undefined) return perPeriod;
  // Not a listed payroll period: spread the annual amount.
  return roundHalfAwayFromZero(table[1] / periods);
}

export interface WithholdingWorksheet {
  /** Line 1c: annualized wages. */
  annualWagesCents: number;
  /** Line 1i or 1l: Adjusted Annual Wage Amount. */
  adjustedAnnualWageCents: number;
  /** Line 2g: tentative annual withholding. */
  tentativeAnnualCents: number;
  /** Line 3b: credits per period. */
  creditsPerPeriodCents: number;
  /** Line 4a: additional withholding per period. */
  extraCents: Cents;
  /** Line 4b, rounded to the cent. */
  withholdingCents: Cents;
}

/**
 * Worksheet 1A for one payroll period. `wagesCents` is line 1a: the period's
 * federal income tax wages (after pre-tax deductions), including the
 * nonresident alien add-on when it applies. Exempt employees are handled by
 * the caller.
 */
export function worksheet1A(rules: FederalRules, w4: UsW4Input, wagesCents: Cents, periodsPerYear: number): WithholdingWorksheet {
  const periods = nominalPeriodsPerYear(periodsPerYear);
  const line1c = Math.max(0, wagesCents) * periods;
  let adjusted: number;
  let schedule: readonly WithholdingRow[];
  let credits = 0;
  if (isPre2020W4(w4)) {
    // Lines 1j–1l; "Don't use the Head of Household table if the Form W-4 is from 2019 or earlier."
    const allowances = Math.max(0, Math.trunc(w4.allowances ?? 0));
    adjusted = Math.max(0, line1c - allowances * rules.withholding.allowanceCents);
    const status: W4FilingStatus = w4.filingStatus === 'married_jointly' ? 'married_jointly' : 'single';
    schedule = rules.withholding.standard[status];
  } else {
    // Lines 1d–1i.
    const line1e = line1c + dollarsToCents(w4.otherIncome);
    const line1g = w4.multipleJobs
      ? 0
      : w4.filingStatus === 'married_jointly'
        ? rules.withholding.line1gMarriedJointlyCents
        : rules.withholding.line1gOtherCents;
    const line1h = dollarsToCents(w4.deductions) + line1g;
    adjusted = Math.max(0, line1e - line1h);
    schedule = (w4.multipleJobs ? rules.withholding.step2Checked : rules.withholding.standard)[w4.filingStatus];
    credits = dollarsToCents(w4.dependentsAmount);
  }
  const line2g = annualScheduleTax(adjusted, schedule);
  const line2h = line2g / periods;
  const line3b = Math.max(0, credits) / periods;
  const line3c = Math.max(0, line2h - line3b);
  const extra = Math.max(0, dollarsToCents(w4.extraWithholding));
  return {
    annualWagesCents: line1c,
    adjustedAnnualWageCents: adjusted,
    tentativeAnnualCents: line2g,
    creditsPerPeriodCents: line3b,
    extraCents: extra,
    withholdingCents: roundHalfAwayFromZero(line3c) + extra,
  };
}

/**
 * Supplemental wages identified separately from regular wages (Pub 15
 * section 7): the part that brings the year's supplemental wages above
 * $1 million is withheld at the mandatory 37% "without regard to the
 * employee's Form W-4"; the rest at the optional flat 22%, which the engine
 * uses whenever income tax was withheld from the employee's regular wages in
 * the current year. Otherwise (and for an employee whose W-4 claims
 * exemption) it uses the aggregate method 1b, which is always allowed.
 */
export interface SupplementalWithholding {
  flatCents: Cents;
  mandatoryCents: Cents;
  /** Extra withholding from the aggregate method (regular + supplemental, less regular). */
  aggregateCents: Cents;
  method: 'flat' | 'aggregate' | 'none';
}

export function supplementalWithholding(args: {
  rules: FederalRules;
  w4: UsW4Input;
  supplementalCents: Cents;
  /** Supplemental wages paid earlier this calendar year. */
  ytdSupplementalCents: Cents;
  /** Regular FIT wages of this period (line 1a for the aggregate method, NRA add-on excluded). */
  regularWagesCents: Cents;
  /** NRA add-on for the period (only for the aggregate method). */
  nraAdditionCents: Cents;
  periodsPerYear: number;
  /** Federal income tax withheld from regular wages this year, this period included. */
  regularWithheldThisYearCents: Cents;
}): SupplementalWithholding {
  const { rules, w4, supplementalCents } = args;
  if (supplementalCents <= 0) return { flatCents: 0, mandatoryCents: 0, aggregateCents: 0, method: 'none' };
  const threshold = rules.supplemental.mandatoryThresholdCents;
  const before = Math.max(0, args.ytdSupplementalCents);
  const overThreshold = Math.max(0, Math.min(supplementalCents, before + supplementalCents - threshold));
  const underThreshold = supplementalCents - overThreshold;
  const mandatoryCents = roundHalfAwayFromZero((overThreshold * rules.supplemental.mandatoryRatePercent) / 100);
  if (underThreshold <= 0) return { flatCents: 0, mandatoryCents, aggregateCents: 0, method: 'flat' };
  if (w4.exempt) return { flatCents: 0, mandatoryCents, aggregateCents: 0, method: 'none' };
  if (args.regularWithheldThisYearCents > 0) {
    return {
      flatCents: roundHalfAwayFromZero((underThreshold * rules.supplemental.flatRatePercent) / 100),
      mandatoryCents,
      aggregateCents: 0,
      method: 'flat',
    };
  }
  // Method 1b: tax on (regular + supplemental) as one payment, less the tax on the regular wages alone.
  const noExtra = { ...w4, extraWithholding: 0 };
  const regularBase = args.regularWagesCents + args.nraAdditionCents;
  const combined = worksheet1A(rules, noExtra, regularBase + underThreshold, args.periodsPerYear).withholdingCents;
  const alone = worksheet1A(rules, noExtra, regularBase, args.periodsPerYear).withholdingCents;
  return { flatCents: 0, mandatoryCents, aggregateCents: Math.max(0, combined - alone), method: 'aggregate' };
}
