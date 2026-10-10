/**
 * The shape of a US federal rule set, one per tax year (`federal-2026.ts`,
 * …), and the lookup the engine and the forms use.
 *
 * A tax year without an officially published rule set has no entry: the
 * engine then reports `unsupported_tax_year` instead of guessing. A rule set
 * built partly from announced-but-not-final figures sets `provisional` and
 * lists them in `provisionalItems`; the engine passes that on as a
 * `provisional_rules` warning.
 */

import type { Cents } from '../money';
import { FEDERAL_2026 } from './federal-2026';

export type W4FilingStatus = 'single' | 'married_jointly' | 'head_of_household';

/**
 * One row of a Pub 15-T Annual Percentage Method table: on an Adjusted Annual
 * Wage Amount of at least `atLeastCents` (column A), withhold `baseCents`
 * (column C) plus `ratePercent` (column D) of the excess over column A.
 */
export interface WithholdingRow {
  atLeastCents: Cents;
  baseCents: Cents;
  ratePercent: number;
}

export type WithholdingSchedule = Record<W4FilingStatus, readonly WithholdingRow[]>;

/** Nonresident alien add-on per payroll period, keyed by periods per year (52, 26, 24, 12, 4, 2, 1). */
export type NraAdditionTable = Record<number, Cents>;

export interface FederalRules {
  taxYear: number;
  /** Version of this rule set, e.g. `us-2026.1`. */
  ruleSet: string;
  provisional: boolean;
  provisionalItems: readonly string[];
  withholding: {
    /** Use for 2019-and-earlier Forms W-4, and 2020+ forms with the Step 2 box NOT checked. */
    standard: WithholdingSchedule;
    /** Use for 2020+ Forms W-4 with the Step 2 box checked. */
    step2Checked: WithholdingSchedule;
    /** Worksheet 1A line 1g (Step 2 box not checked): MFJ, or any other status. */
    line1gMarriedJointlyCents: Cents;
    line1gOtherCents: Cents;
    /** Worksheet 1A line 1k: value of one allowance on a 2019-or-earlier Form W-4. */
    allowanceCents: Cents;
    /** Nonresident alien add-on: Table 1 (first paid before 2020, no 2020+ W-4) and Table 2 (2020+ W-4). */
    nraAdditionPre2020: NraAdditionTable;
    nraAddition2020: NraAdditionTable;
  };
  supplemental: {
    /** Optional flat rate for supplemental wages up to the threshold. */
    flatRatePercent: number;
    /** Mandatory rate on supplemental wages above the threshold in the calendar year. */
    mandatoryRatePercent: number;
    mandatoryThresholdCents: Cents;
  };
  socialSecurity: { ratePercent: number; wageBaseCents: Cents };
  medicare: { ratePercent: number; additionalRatePercent: number; additionalThresholdCents: Cents };
  futa: {
    grossRatePercent: number;
    /** Maximum credit for state unemployment contributions (paid on time). */
    maxCreditPercent: number;
    wageBaseCents: Cents;
    /** States the DOL may still name for this year (not final): the engine warns `provisional_rules`. */
    creditReductionPending: readonly string[];
  };
  retirement: {
    /** §402(g) elective deferral limit (pre-tax and Roth combined). */
    electiveDeferralCents: Cents;
    /** Catch-up for participants who reach age 50 by the end of the year. */
    catchUp50Cents: Cents;
    /** Higher catch-up for participants who reach age 60, 61, 62 or 63 by the end of the year (instead of the 50+ amount). */
    catchUp60To63Cents: Cents;
  };
  hsa: { selfOnlyCents: Cents; familyCents: Cents; catchUp55Cents: Cents };
  /** §129 dependent care assistance exclusion per employee per year. */
  dependentCareExclusionCents: Cents;
}

const RULES: Record<number, FederalRules> = {
  2026: FEDERAL_2026,
};

/** The federal rule set for a tax year, or undefined when none is published. */
export function federalRules(taxYear: number): FederalRules | undefined {
  return RULES[taxYear];
}

/** Tax years the federal engine supports. */
export const SUPPORTED_FEDERAL_YEARS: readonly number[] = Object.keys(RULES).map(Number);

/**
 * FUTA credit reduction rate (percent) for a state and year. Final rates are
 * set by the DOL after 10 November of the year; until then a year has no
 * entry and this returns 0.
 */
export function futaCreditReductionPercent(taxYear: number, state: string | null | undefined): number {
  if (!state) return 0;
  return FUTA_CREDIT_REDUCTION[taxYear]?.[state.toUpperCase()] ?? 0;
}

/**
 * FUTA credit reduction rates by year and state (percent).
 *
 * 2025: Schedule A (Form 940) for 2025, "Credit reduction states for 2025":
 * California 0.012 (1.2%), U.S. Virgin Islands 0.045 (4.5%).
 * https://www.irs.gov/pub/irs-pdf/f940sa.pdf
 *
 * 2026: not final. The draft Schedule A (Form 940) for 2026 says California
 * and the U.S. Virgin Islands were subject to credit reduction as of
 * 1 January 2026, with rates "0.0XX" until the DOL announces the final list
 * in November 2026. https://www.irs.gov/pub/irs-dft/f940sa--dft.pdf
 * Left unset on purpose; fill in once the final 2026 Schedule A is out.
 */
export const FUTA_CREDIT_REDUCTION: Record<number, Record<string, number>> = {
  2025: { CA: 1.2, VI: 4.5 },
  2026: {},
};
