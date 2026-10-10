/**
 * US federal payroll rules for tax year 2026 (wages paid in 2026).
 *
 * Every figure below was taken from the official source named next to it,
 * fetched on 9 October 2026:
 *
 * - Pub 15-T (2026), Federal Income Tax Withholding Methods
 *   https://www.irs.gov/publications/p15t (page last reviewed 30 April 2026)
 * - Pub 15 (2026), (Circular E), Employer's Tax Guide
 *   https://www.irs.gov/publications/p15
 * - Pub 15-B (2026), Employer's Tax Guide to Fringe Benefits
 *   https://www.irs.gov/publications/p15b
 * - IR-2025-111 (13 Nov 2025), "401(k) limit increases to $24,500 for 2026"
 *   https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500
 */

import type { Cents } from '../money';
import type { FederalRules, WithholdingRow } from './federal-rules';

/** Dollars → cents for table literals. */
function usd(dollars: number): Cents {
  return Math.round(dollars * 100);
}

function row(atLeast: number, base: number, ratePercent: number): WithholdingRow {
  return { atLeastCents: usd(atLeast), baseCents: usd(base), ratePercent };
}

// ---------------------------------------------------------------------------
// Pub 15-T (2026), section 1: "2026 Percentage Method Tables for Automated
// Payroll Systems and Withholding on Periodic Payments of Pensions and
// Annuities" (Annual Percentage Method tables, columns A, C, D).
// ---------------------------------------------------------------------------

/** STANDARD Withholding Rate Schedules (2019-and-earlier W-4, or 2020+ W-4 with the Step 2 box not checked). */
const STANDARD = {
  married_jointly: [
    row(0, 0, 0),
    row(19_300, 0, 10),
    row(44_100, 2_480, 12),
    row(120_100, 11_600, 22),
    row(230_700, 35_932, 24),
    row(422_850, 82_048, 32),
    row(531_750, 116_896, 35),
    row(788_000, 206_583.5, 37),
  ],
  single: [
    row(0, 0, 0),
    row(7_500, 0, 10),
    row(19_900, 1_240, 12),
    row(57_900, 5_800, 22),
    row(113_200, 17_966, 24),
    row(209_275, 41_024, 32),
    row(263_725, 58_448, 35),
    row(648_100, 192_979.25, 37),
  ],
  head_of_household: [
    row(0, 0, 0),
    row(15_550, 0, 10),
    row(33_250, 1_770, 12),
    row(83_000, 7_740, 22),
    row(121_250, 16_155, 24),
    row(217_300, 39_207, 32),
    row(271_750, 56_631, 35),
    row(656_150, 191_171, 37),
  ],
} as const;

/** Form W-4, Step 2, Checkbox, Withholding Rate Schedules (2020+ W-4 with the Step 2 box checked). */
const STEP2_CHECKED = {
  married_jointly: [
    row(0, 0, 0),
    row(16_100, 0, 10),
    row(28_500, 1_240, 12),
    row(66_500, 5_800, 22),
    row(121_800, 17_966, 24),
    row(217_875, 41_024, 32),
    row(272_325, 58_448, 35),
    row(400_450, 103_291.75, 37),
  ],
  single: [
    row(0, 0, 0),
    row(8_050, 0, 10),
    row(14_250, 620, 12),
    row(33_250, 2_900, 22),
    row(60_900, 8_983, 24),
    row(108_938, 20_512, 32),
    row(136_163, 29_224, 35),
    row(328_350, 96_489.63, 37),
  ],
  head_of_household: [
    row(0, 0, 0),
    row(12_075, 0, 10),
    row(20_925, 885, 12),
    row(45_800, 3_870, 22),
    row(64_925, 8_077.5, 24),
    row(112_950, 19_603.5, 32),
    row(140_175, 28_315.5, 35),
    row(332_375, 95_585.5, 37),
  ],
} as const;

export const FEDERAL_2026: FederalRules = {
  taxYear: 2026,
  ruleSet: 'us-2026.1',
  provisional: false,
  provisionalItems: [],
  withholding: {
    standard: STANDARD,
    step2Checked: STEP2_CHECKED,
    // Pub 15-T (2026) Worksheet 1A, line 1g: "If the box in Step 2 of Form W-4 is checked,
    // enter -0-. If the box is not checked, enter $12,900 if the taxpayer is married filing
    // jointly or $8,600 otherwise".
    line1gMarriedJointlyCents: usd(12_900),
    line1gOtherCents: usd(8_600),
    // Pub 15-T (2026) Worksheet 1A, line 1k: "Multiply line 1j by $4,300".
    allowanceCents: usd(4_300),
    // Pub 15-T (2026), "Withholding Adjustment for Nonresident Alien Employees", Table 1
    // (first paid wages before 2020 and no 2020+ Form W-4) and Table 2 (2020+ Form W-4 or
    // first paid in 2020 or later). Keyed by payroll periods per year.
    nraAdditionPre2020: { 52: usd(226.9), 26: usd(453.8), 24: usd(491.7), 12: usd(983.3), 4: usd(2_950), 2: usd(5_900), 1: usd(11_800) },
    nraAddition2020: { 52: usd(309.6), 26: usd(619.2), 24: usd(670.8), 12: usd(1_341.7), 4: usd(4_025), 2: usd(8_050), 1: usd(16_100) },
  },
  // Pub 15 (2026), What's New, "Withholding on supplemental wages": "The withholding rate on
  // supplemental wages remains 22% (37% if supplemental wages paid to an employee during the
  // calendar year exceed $1 million)"; section 7.
  supplemental: { flatRatePercent: 22, mandatoryRatePercent: 37, mandatoryThresholdCents: usd(1_000_000) },
  // Pub 15 (2026), What's New, "Social security and Medicare taxes for 2026": 6.2% each,
  // wage base limit $184,500; Medicare 1.45% each, no wage base limit.
  socialSecurity: { ratePercent: 6.2, wageBaseCents: usd(184_500) },
  // Pub 15 (2026), section 9, "Additional Medicare Tax withholding": 0.9% on wages paid in
  // excess of $200,000 in a calendar year, from the pay period in which they exceed it.
  medicare: { ratePercent: 1.45, additionalRatePercent: 0.9, additionalThresholdCents: usd(200_000) },
  futa: {
    // Pub 15 (2026), section 14: "For 2026, the FUTA tax rate is 6.0%. The tax applies to the
    // first $7,000 you pay to each employee as wages during the year." The 5.4% maximum
    // credit (0.6% net) is in the Instructions for Form 940 (line 9 uses 0.054).
    grossRatePercent: 6.0,
    maxCreditPercent: 5.4,
    wageBaseCents: usd(7_000),
    // 2026 credit reductions are not final until the DOL announces them (after 10 November
    // 2026). The draft 2026 Schedule A (Form 940) names California and the U.S. Virgin
    // Islands with rates "0.0XX": https://www.irs.gov/pub/irs-dft/f940sa--dft.pdf
    // CA is deliberately left unset; the rates live in FUTA_CREDIT_REDUCTION (federal-rules.ts).
    creditReductionPending: ['CA', 'VI'],
  },
  // IR-2025-111: elective deferral limit $24,500; catch-up (age 50+) $8,000; "For 2026, this
  // higher catch-up contribution limit [ages 60, 61, 62 and 63] remains $11,250 instead of
  // the $8,000 noted above."
  retirement: { electiveDeferralCents: usd(24_500), catchUp50Cents: usd(8_000), catchUp60To63Cents: usd(11_250) },
  // Pub 15-B (2026), "Health Savings Accounts": $4,400 self-only, $8,750 family; "increased
  // by $1,000 for a qualified individual who is age 55 or older at any time during the year".
  hsa: { selfOnlyCents: usd(4_400), familyCents: usd(8_750), catchUp55Cents: usd(1_000) },
  // Pub 15-B (2026), "Dependent care assistance exclusion from wages. For the 2026 tax year,
  // the annual dependent care FSA limit was raised from $5,000 to $7,500 ($2,500 to $3,750
  // for married filing separately)." (P.L. 119-21.) The engine applies the $7,500 plan limit;
  // the $3,750 MFS limit depends on the employee's own return.
  dependentCareExclusionCents: usd(7_500),
};
