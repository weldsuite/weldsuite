/**
 * Depreciation tables and yearly parameters.
 *
 * MACRS percentages are IRS Publication 946 Appendix A: A-1 (half-year), A-2 to
 * A-5 (mid-quarter, property placed in service in the 1st to 4th quarter),
 * A-6 (27.5-year residential rental) and A-7a (39-year nonresidential real
 * property, placed in service after 12 May 1993), both mid-month. Tables A-1
 * to A-5 were read from a published copy and every row sums to 100; A-6 and
 * A-7a are written out from the rule the tables follow (see below) and are
 * checked to sum to 100 per month.
 *
 * The section 179, bonus depreciation and de minimis figures are data keyed by
 * date. Rows marked "research" come from
 * docs/plans/weldbooks-us-research/federal.md; the others are from the statute
 * and revenue procedures as remembered and have not been re-verified here.
 * Review them every December with the other yearly figures.
 */

/** Recovery periods that have percentage tables for personal property. */
export type MacrsTableClass = 3 | 5 | 7 | 10 | 15 | 20;

export const MACRS_TABLE_CLASSES: readonly MacrsTableClass[] = [3, 5, 7, 10, 15, 20];

/** Table A-1: half-year convention. Index 0 is the first recovery year. */
export const MACRS_HALF_YEAR: Readonly<Record<MacrsTableClass, readonly number[]>> = {
  3: [33.33, 44.45, 14.81, 7.41],
  5: [20.0, 32.0, 19.2, 11.52, 11.52, 5.76],
  7: [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  10: [10.0, 18.0, 14.4, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28],
  15: [5.0, 9.5, 8.55, 7.7, 6.93, 6.23, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.95],
  20: [
    3.75, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461,
    4.462, 4.461, 4.462, 4.461, 2.231,
  ],
};

/** Tables A-2 to A-5: mid-quarter convention by the quarter (1 to 4) the property was placed in service. */
export const MACRS_MID_QUARTER: Readonly<Record<1 | 2 | 3 | 4, Readonly<Record<MacrsTableClass, readonly number[]>>>> = {
  1: {
    3: [58.33, 27.78, 12.35, 1.54],
    5: [35.0, 26.0, 15.6, 11.01, 11.01, 1.38],
    7: [25.0, 21.43, 15.31, 10.93, 8.75, 8.74, 8.75, 1.09],
    10: [17.5, 16.5, 13.2, 10.56, 8.45, 6.76, 6.55, 6.55, 6.56, 6.55, 0.82],
    15: [8.75, 9.13, 8.21, 7.39, 6.65, 5.99, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 0.74],
    20: [
      6.563, 7.0, 6.482, 5.996, 5.546, 5.13, 4.746, 4.459, 4.459, 4.459, 4.459, 4.46, 4.459, 4.46, 4.459, 4.46, 4.459,
      4.46, 4.459, 4.46, 0.565,
    ],
  },
  2: {
    3: [41.67, 38.89, 14.14, 5.3],
    5: [25.0, 30.0, 18.0, 11.37, 11.37, 4.26],
    7: [17.85, 23.47, 16.76, 11.97, 8.87, 8.87, 8.87, 3.34],
    10: [12.5, 17.5, 14.0, 11.2, 8.96, 7.17, 6.55, 6.55, 6.56, 6.55, 2.46],
    15: [6.25, 9.38, 8.44, 7.59, 6.83, 6.15, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.21],
    20: [
      4.688, 7.148, 6.612, 6.116, 5.658, 5.233, 4.841, 4.478, 4.463, 4.463, 4.463, 4.463, 4.463, 4.463, 4.462, 4.463,
      4.462, 4.463, 4.462, 4.463, 1.673,
    ],
  },
  3: {
    3: [25.0, 50.0, 16.67, 8.33],
    5: [15.0, 34.0, 20.4, 12.24, 11.3, 7.06],
    7: [10.71, 25.51, 18.22, 13.02, 9.3, 8.85, 8.86, 5.53],
    10: [7.5, 18.5, 14.8, 11.84, 9.47, 7.58, 6.55, 6.55, 6.56, 6.55, 4.1],
    15: [3.75, 9.63, 8.66, 7.8, 7.02, 6.31, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 3.69],
    20: [
      2.813, 7.289, 6.742, 6.237, 5.769, 5.336, 4.936, 4.566, 4.46, 4.46, 4.46, 4.46, 4.461, 4.46, 4.461, 4.46, 4.461,
      4.46, 4.461, 4.46, 2.788,
    ],
  },
  4: {
    3: [8.33, 61.11, 20.37, 10.19],
    5: [5.0, 38.0, 22.8, 13.68, 10.94, 9.58],
    7: [3.57, 27.55, 19.68, 14.06, 10.04, 8.73, 8.73, 7.64],
    10: [2.5, 19.5, 15.6, 12.48, 9.98, 7.99, 6.55, 6.55, 6.56, 6.55, 5.74],
    15: [1.25, 9.88, 8.89, 8.0, 7.2, 6.48, 5.9, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.17],
    20: [
      0.938, 7.43, 6.872, 6.357, 5.88, 5.439, 5.031, 4.654, 4.458, 4.458, 4.458, 4.458, 4.458, 4.458, 4.458, 4.458,
      4.458, 4.459, 4.458, 4.459, 3.901,
    ],
  },
};

/** First-year percentage of 27.5-year property by month placed in service (January first). */
const RESIDENTIAL_FIRST_YEAR = [3.485, 3.182, 2.879, 2.576, 2.273, 1.97, 1.667, 1.364, 1.061, 0.758, 0.455, 0.152];

/**
 * Table A-6: 27.5-year residential rental property, mid-month. The table's
 * pattern: years 2 to 9 are 3.636; years 10 to 27 alternate 3.637 and 3.636
 * (the even years are 3.637 for property placed in service January to June,
 * the odd years for July to December); year 28 and, from July on, year 29
 * hold what is left of the 27.5 years.
 */
function residentialRentalPercentages(month: number): number[] {
  const first = RESIDENTIAL_FIRST_YEAR[month - 1] as number;
  const early = month <= 6;
  const rows: number[] = [first];
  for (let year = 2; year <= 27; year++) {
    if (year <= 9) rows.push(3.636);
    else if (year % 2 === 0) rows.push(early ? 3.637 : 3.636);
    else rows.push(early ? 3.636 : 3.637);
  }
  const used = rows.reduce((sum, value) => sum + value, 0);
  if (early) {
    rows.push(Math.round((100 - used) * 1000) / 1000, 0);
  } else {
    rows.push(3.636, Math.round((100 - used - 3.636) * 1000) / 1000);
  }
  return rows;
}

/** First and last year percentages of 39-year property by month placed in service (January first): table A-7a. */
const NONRESIDENTIAL_FIRST_YEAR = [2.461, 2.247, 2.033, 1.819, 1.605, 1.391, 1.177, 0.963, 0.749, 0.535, 0.321, 0.107];
const NONRESIDENTIAL_LAST_YEAR = [0.107, 0.321, 0.535, 0.749, 0.963, 1.177, 1.391, 1.605, 1.819, 2.033, 2.247, 2.461];

function nonresidentialPercentages(month: number): number[] {
  return [
    NONRESIDENTIAL_FIRST_YEAR[month - 1] as number,
    ...Array<number>(38).fill(2.564),
    NONRESIDENTIAL_LAST_YEAR[month - 1] as number,
  ];
}

/**
 * Mid-month percentages of real property by recovery year (index 0 is year 1)
 * for the month (1 to 12) the property was placed in service: 29 years for
 * 27.5-year property, 40 for 39-year.
 */
export function macrsRealPropertyPercentages(recoveryYears: 27.5 | 39, month: number): readonly number[] {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError('The month is 1 to 12');
  return recoveryYears === 27.5 ? residentialRentalPercentages(month) : nonresidentialPercentages(month);
}

// ---------------------------------------------------------------------------
// Section 179

export interface Section179Parameters {
  taxYear: number;
  /** The most that can be expensed. */
  limit: number;
  /** The limit falls dollar for dollar once the cost of section 179 property placed in service exceeds this. */
  phaseOutThreshold: number;
  /** Cap on a sport utility vehicle over 6,000 pounds. */
  suvCap: number;
  source: 'research' | 'statute';
  note?: string;
}

/**
 * 2025 and 2026 are from the research (federal.md section 4: $2,500,000 and
 * $4,000,000 for 2025 under the One Big Beautiful Bill Act; $2,560,000 and
 * $4,090,000 for 2026, Rev. Proc. 2025-32). The 2025 SUV cap is the earlier
 * Rev. Proc. 2024-40 figure; the research lists it as needing confirmation.
 */
export const SECTION_179_PARAMETERS: readonly Section179Parameters[] = [
  { taxYear: 2018, limit: 1_000_000, phaseOutThreshold: 2_500_000, suvCap: 25_000, source: 'statute' },
  { taxYear: 2019, limit: 1_020_000, phaseOutThreshold: 2_550_000, suvCap: 25_500, source: 'statute' },
  { taxYear: 2020, limit: 1_040_000, phaseOutThreshold: 2_590_000, suvCap: 25_900, source: 'statute' },
  { taxYear: 2021, limit: 1_050_000, phaseOutThreshold: 2_620_000, suvCap: 26_200, source: 'statute' },
  { taxYear: 2022, limit: 1_080_000, phaseOutThreshold: 2_700_000, suvCap: 27_000, source: 'statute' },
  { taxYear: 2023, limit: 1_160_000, phaseOutThreshold: 2_890_000, suvCap: 28_900, source: 'statute' },
  { taxYear: 2024, limit: 1_220_000, phaseOutThreshold: 3_050_000, suvCap: 30_500, source: 'statute' },
  {
    taxYear: 2025,
    limit: 2_500_000,
    phaseOutThreshold: 4_000_000,
    suvCap: 31_300,
    source: 'research',
    note: 'OBBBA amounts; the SUV cap is the pre-OBBBA revenue procedure figure.',
  },
  { taxYear: 2026, limit: 2_560_000, phaseOutThreshold: 4_090_000, suvCap: 32_000, source: 'research' },
];

/** The parameters of a tax year; years after the last known one use the latest figures (check them). */
export function section179Parameters(taxYear: number): Section179Parameters | undefined {
  const first = SECTION_179_PARAMETERS[0] as Section179Parameters;
  if (taxYear < first.taxYear) return undefined;
  let found = first;
  for (const row of SECTION_179_PARAMETERS) {
    if (row.taxYear <= taxYear) found = row;
  }
  return found;
}

export interface Section179Allowance {
  parameters: Section179Parameters;
  /** The dollar limit reduced by the phase-out. */
  dollarLimit: number;
  phaseOutReduction: number;
  /** The most that can be expensed: the dollar limit, and no more than the business income limit when one is given. */
  allowable: number;
}

/**
 * What can be expensed under section 179 in a tax year.
 * `totalPlacedInService` is the cost of all section 179 property placed in
 * service that year; `businessIncomeLimit` is the taxable income from the
 * business before the deduction (the excess carries forward).
 */
export function section179Allowance(taxYear: number, totalPlacedInService: number, businessIncomeLimit?: number): Section179Allowance | undefined {
  const parameters = section179Parameters(taxYear);
  if (!parameters) return undefined;
  const phaseOutReduction = Math.max(0, totalPlacedInService - parameters.phaseOutThreshold);
  const dollarLimit = Math.max(0, parameters.limit - phaseOutReduction);
  const allowable = businessIncomeLimit === undefined ? dollarLimit : Math.max(0, Math.min(dollarLimit, businessIncomeLimit));
  return { parameters, dollarLimit, phaseOutReduction, allowable };
}

// ---------------------------------------------------------------------------
// Bonus depreciation

/** One Big Beautiful Bill Act: 100% bonus for property acquired after this date (federal.md section 4). */
export const OBBBA_BONUS_CUTOFF = '2025-01-19';

/** The TCJA's 100% bonus started with property acquired after this date. */
export const TCJA_BONUS_START = '2017-09-27';

export type BonusRuleId =
  | 'obbba_100'
  | 'obbba_reduced_election'
  | 'tcja_100'
  | 'tcja_80'
  | 'tcja_60'
  | 'tcja_40'
  | 'tcja_20'
  | 'tcja_0'
  | 'not_modeled';

export interface BonusDepreciation {
  percent: number;
  rule: BonusRuleId;
}

/**
 * The bonus depreciation percentage (section 168(k)) for property.
 *
 * - Acquired after 19 January 2025 and placed in service after it: 100%, with
 *   no sunset (OBBBA section 70301). A taxpayer may instead elect 40% for the
 *   first tax year ending after that date (`reducedElection`; the caller says
 *   it applies, this does not know the tax year).
 * - Acquired on or before 19 January 2025: the TCJA phase-down by the year it
 *   is placed in service: 100% to 2022, 80% in 2023, 60% in 2024, 40% in 2025
 *   (the research), 20% in 2026 (the research), 0% after.
 * - Acquired on or before 27 September 2017 is outside this table; enter the
 *   percentage by hand.
 *
 * Whether the property qualifies at all (a recovery period of 20 years or
 * less, not required to use ADS) is `bonusEligible`.
 */
export function bonusDepreciationPercent(input: {
  acquisitionDate: string;
  placedInServiceDate: string;
  reducedElection?: boolean;
}): BonusDepreciation {
  const { acquisitionDate, placedInServiceDate } = input;
  if (acquisitionDate > OBBBA_BONUS_CUTOFF && placedInServiceDate > OBBBA_BONUS_CUTOFF) {
    return input.reducedElection ? { percent: 40, rule: 'obbba_reduced_election' } : { percent: 100, rule: 'obbba_100' };
  }
  if (acquisitionDate <= TCJA_BONUS_START) return { percent: 0, rule: 'not_modeled' };
  const year = Number(placedInServiceDate.slice(0, 4));
  if (placedInServiceDate <= TCJA_BONUS_START) return { percent: 0, rule: 'not_modeled' };
  if (year <= 2022) return { percent: 100, rule: 'tcja_100' };
  if (year === 2023) return { percent: 80, rule: 'tcja_80' };
  if (year === 2024) return { percent: 60, rule: 'tcja_60' };
  if (year === 2025) return { percent: 40, rule: 'tcja_40' };
  if (year === 2026) return { percent: 20, rule: 'tcja_20' };
  return { percent: 0, rule: 'tcja_0' };
}

/** Property with a GDS recovery period of 20 years or less, or 25-year water utility property, qualifies for bonus depreciation. */
export function bonusEligible(recoveryYears: number): boolean {
  return recoveryYears <= 20 || recoveryYears === 25;
}

// ---------------------------------------------------------------------------
// De minimis safe harbor

export interface DeMinimisSafeHarbor {
  effectiveFrom: string;
  /** Per invoice or item, without an applicable financial statement. */
  withoutAfs: number;
  /** Per invoice or item, with an applicable financial statement. */
  withAfs: number;
}

/** Treas. Reg. 1.263(a)-1(f): $2,500 without an AFS, $5,000 with one; no change found for 2025 or 2026 (federal.md). */
export const DE_MINIMIS_SAFE_HARBOR: readonly DeMinimisSafeHarbor[] = [
  { effectiveFrom: '2016-01-01', withoutAfs: 2_500, withAfs: 5_000 },
];

export function deMinimisThreshold(date: string, hasAfs: boolean): number | undefined {
  let current: DeMinimisSafeHarbor | undefined;
  for (const row of DE_MINIMIS_SAFE_HARBOR) {
    if (row.effectiveFrom <= date) current = row;
  }
  if (!current) return undefined;
  return hasAfs ? current.withAfs : current.withoutAfs;
}

/** An item or invoice line that does not exceed the threshold can be expensed instead of capitalized. */
export function deMinimisApplies(amount: number, date: string, hasAfs: boolean): boolean {
  const threshold = deMinimisThreshold(date, hasAfs);
  return threshold !== undefined && amount <= threshold;
}
