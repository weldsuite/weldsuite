/**
 * California: PIT withholding (DE 4, EDD Method B), SDI, UI and ETT.
 *
 * Sources (fetched 9 October 2026):
 * - EDD, "California Withholding Schedules for 2026", Method B — Exact
 *   Calculation Method, https://edd.ca.gov/siteassets/files/pdf_pub_ctr/26methb.pdf
 *   (Tables 1–4 p. 5–6, Tables 5–28 p. 7–10, Examples A–F p. 2–4).
 * - EDD, California Employer's Guide DE 44 Rev. 52 (4-26),
 *   https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de44.pdf: 2026 rates (p. 1:
 *   UI $7,000 base, new employer 3.4%, ETT 0.1%, SDI 1.3% with no wage limit),
 *   supplemental wages (p. 18: aggregate when paid with regular wages, else
 *   10.23% bonuses and stock options / 6.6% other), no DE 4 = Single with zero
 *   allowances (p. 16).
 * - EDD, DE 4 Rev. 56 (1-26), https://edd.ca.gov/siteassets/files/pdf_pub_ctr/de4.pdf.
 * - EDD Information Sheets DE 231EB (Taxability of Employee Benefits) and
 *   DE 231TP (Types of Payments): 401(k) deferrals are UI/SDI wages but not PIT
 *   wages; Section 125 health and dependent care salary reductions are not
 *   UI/SDI/PIT wages; HSA contributions (also through a cafeteria plan) are
 *   UI, SDI and PIT wages (California does not conform).
 */

import { percentOf, type Cents } from '../../money';
import {
  YtdWriter,
  certAllowances,
  certBoolean,
  certExtraCents,
  certNumber,
  computeProgram,
  computeSui,
  d,
  periodTypeOf,
  provisionalIssue,
  recordIncomeTax,
  residenceIssue,
  roundCents,
  scheduleTax,
  taxableWages,
  unsupportedFrequencyResult,
  unsupportedYearResult,
  type PeriodType,
  type PretaxExclusions,
  type ScheduleRow,
  rateCode,
} from './common';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'CA';
const RULE_SET = 'us-ca-2026.1';

type CaStatus = 'single' | 'married' | 'head_of_household';
type CaPeriod = PeriodType;

/** DE 231EB / DE 231TP. */
const PIT_EXCLUSIONS: PretaxExclusions = { retirement401k: true, section125: true, hsa: false, dependentCare: true };
const UI_SDI_EXCLUSIONS: PretaxExclusions = { retirement401k: false, section125: true, hsa: false, dependentCare: true };

/** DE 44 p. 1. */
const SDI_RATE_PERCENT = 1.3;
const UI_WAGE_BASE = d(7000);
const UI_NEW_EMPLOYER_RATE_PERCENT = 3.4;
const ETT_RATE_PERCENT = 0.1;

/** DE 44 p. 18. */
const SUPPLEMENTAL_BONUS_RATE_PERCENT = 10.23;

// ---------------------------------------------------------------------------
// Method B tables (26methb.pdf)
// ---------------------------------------------------------------------------

/**
 * Table 1 (low-income exemption) and Table 3 (standard deduction):
 * [Single, dual-income married, married with multiple employers, or married
 * with 0–1 allowances; married with 2+ allowances or unmarried head of household].
 */
const LOW_INCOME: Record<CaPeriod, [number, number]> = {
  weekly: [363, 727],
  biweekly: [727, 1454],
  semimonthly: [787, 1575],
  monthly: [1575, 3149],
  quarterly: [4724, 9448],
  semiannual: [9448, 18896],
  annual: [18896, 37791],
};

const STANDARD_DEDUCTION: Record<CaPeriod, [number, number]> = {
  weekly: [110, 219],
  biweekly: [219, 439],
  semimonthly: [238, 476],
  monthly: [476, 951],
  quarterly: [1427, 2853],
  semiannual: [2853, 5706],
  annual: [5706, 11412],
};

/** Table 2: estimated deduction for 1–10 additional allowances (more than 10: n × the amount for one). */
const ESTIMATED_DEDUCTION: Record<CaPeriod, number[]> = {
  weekly: [19, 38, 58, 77, 96, 115, 135, 154, 173, 192],
  biweekly: [38, 77, 115, 154, 192, 231, 269, 308, 346, 385],
  semimonthly: [42, 83, 125, 167, 208, 250, 292, 333, 375, 417],
  monthly: [83, 167, 250, 333, 417, 500, 583, 667, 750, 833],
  quarterly: [250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500],
  semiannual: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000],
  annual: [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000],
};

/** Table 4: exemption allowance credit for 1–10 regular allowances (more than 10: n × the amount for one). */
const EXEMPTION_CREDIT: Record<CaPeriod, number[]> = {
  weekly: [3.24, 6.47, 9.71, 12.95, 16.18, 19.42, 22.66, 25.89, 29.13, 32.37],
  biweekly: [6.47, 12.95, 19.42, 25.89, 32.37, 38.84, 45.31, 51.78, 58.26, 64.73],
  semimonthly: [7.01, 14.03, 21.04, 28.05, 35.06, 42.08, 49.09, 56.1, 63.11, 70.13],
  monthly: [14.03, 28.05, 42.08, 56.1, 70.13, 84.15, 98.18, 112.2, 126.23, 140.25],
  quarterly: [42.08, 84.15, 126.23, 168.3, 210.38, 252.45, 294.53, 336.6, 378.68, 420.75],
  semiannual: [84.15, 168.3, 252.45, 336.6, 420.75, 504.9, 589.05, 673.2, 757.35, 841.5],
  annual: [168.3, 336.6, 504.9, 673.2, 841.5, 1009.8, 1178.1, 1346.4, 1514.7, 1683.0],
};

/** Marginal rates of every 2026 tax rate table (Tables 5–28). */
const RATES = [1.1, 2.2, 4.4, 6.6, 8.8, 10.23, 11.33, 12.43, 13.53, 14.63];

function table(rows: [over: number, base: number][]): ScheduleRow[] {
  return rows.map(([over, base], i) => ({ over: d(over), baseCents: d(base), ratePercent: RATES[i] }));
}

/** Tables 5–28: taxable income over, tax on the lower brackets. */
const TAX_TABLES: Record<CaPeriod, Record<CaStatus, ScheduleRow[]>> = {
  annual: {
    single: table([[0, 0], [11079, 121.87], [26264, 455.94], [41452, 1124.21], [57542, 2186.15], [72724, 3522.17], [371479, 34084.81], [445771, 42502.09], [742953, 79441.81], [1000000, 114220.27]]),
    married: table([[0, 0], [22158, 243.74], [52528, 911.88], [82904, 2248.42], [115084, 4372.3], [145448, 7044.33], [742958, 68169.6], [891542, 85004.17], [1000000, 98485.5], [1485906, 164228.58]]),
    head_of_household: table([[0, 0], [22173, 243.9], [52530, 911.75], [67716, 1579.93], [83805, 2641.8], [98990, 3978.08], [505208, 45534.18], [606251, 56982.35], [1000000, 105925.35], [1010417, 107334.77]]),
  },
  quarterly: {
    single: table([[0, 0], [2770, 30.47], [6566, 113.98], [10363, 281.05], [14386, 546.57], [18181, 880.53], [92870, 8521.21], [111443, 10625.53], [185738, 19860.4], [250000, 28555.05]]),
    married: table([[0, 0], [5540, 60.94], [13132, 227.96], [20726, 562.1], [28772, 1093.14], [36362, 1761.06], [185740, 17042.43], [222886, 21251.07], [250000, 24621.34], [371477, 41057.18]]),
    head_of_household: table([[0, 0], [5543, 60.97], [13133, 227.95], [16929, 394.97], [20951, 660.42], [24748, 994.56], [126302, 11383.53], [151563, 14245.6], [250000, 26481.32], [252604, 26833.64]]),
  },
  semiannual: {
    single: table([[0, 0], [5540, 60.94], [13132, 227.96], [20726, 562.1], [28772, 1093.14], [36362, 1761.06], [185740, 17042.43], [222886, 21251.07], [371476, 39720.81], [500000, 57110.11]]),
    married: table([[0, 0], [11080, 121.88], [26264, 455.93], [41452, 1124.2], [57544, 2186.27], [72724, 3522.11], [371480, 34084.85], [445772, 42502.13], [500000, 49242.67], [742954, 82114.35]]),
    head_of_household: table([[0, 0], [11086, 121.95], [26266, 455.91], [33858, 789.96], [41902, 1320.86], [49496, 1989.13], [252604, 22767.08], [303126, 28491.22], [500000, 52962.66], [505208, 53667.3]]),
  },
  semimonthly: {
    single: table([[0, 0], [462, 5.08], [1094, 18.98], [1727, 46.83], [2398, 91.12], [3030, 146.74], [15478, 1420.17], [18574, 1770.95], [30956, 3310.03], [41667, 4759.23]]),
    married: table([[0, 0], [924, 10.16], [2188, 37.97], [3454, 93.67], [4796, 182.24], [6060, 293.47], [30956, 2840.33], [37148, 3541.88], [41667, 4103.59], [61913, 6842.87]]),
    head_of_household: table([[0, 0], [924, 10.16], [2189, 37.99], [2822, 65.84], [3492, 110.06], [4125, 165.76], [21050, 1897.19], [25260, 2374.18], [41667, 4413.57], [42101, 4472.29]]),
  },
  monthly: {
    single: table([[0, 0], [924, 10.16], [2188, 37.97], [3454, 93.67], [4796, 182.24], [6060, 293.47], [30956, 2840.33], [37148, 3541.88], [61912, 6620.05], [83334, 9518.45]]),
    married: table([[0, 0], [1848, 20.33], [4376, 75.95], [6908, 187.36], [9592, 364.5], [12120, 586.96], [61912, 5680.68], [74296, 7083.79], [83334, 8207.21], [123826, 13685.78]]),
    head_of_household: table([[0, 0], [1848, 20.33], [4378, 75.99], [5644, 131.69], [6984, 220.13], [8250, 331.54], [42100, 3794.4], [50520, 4748.39], [83334, 8827.17], [84202, 8944.61]]),
  },
  weekly: {
    single: table([[0, 0], [213, 2.34], [505, 8.76], [797, 21.61], [1107, 42.07], [1399, 67.77], [7144, 655.48], [8573, 817.39], [14288, 1527.76], [19231, 2196.55]]),
    married: table([[0, 0], [426, 4.69], [1010, 17.54], [1594, 43.24], [2214, 84.16], [2798, 135.55], [14288, 1310.98], [17146, 1634.79], [19231, 1893.96], [28575, 3158.2]]),
    head_of_household: table([[0, 0], [426, 4.69], [1010, 17.54], [1302, 30.39], [1612, 50.85], [1904, 76.55], [9716, 875.72], [11659, 1095.86], [19231, 2037.06], [19431, 2064.12]]),
  },
  biweekly: {
    single: table([[0, 0], [426, 4.69], [1010, 17.54], [1594, 43.24], [2214, 84.16], [2798, 135.55], [14288, 1310.98], [17146, 1634.79], [28576, 3055.54], [38462, 4393.12]]),
    married: table([[0, 0], [852, 9.37], [2020, 35.07], [3188, 86.46], [4428, 168.3], [5596, 271.08], [28576, 2621.93], [34292, 3269.55], [38462, 3787.88], [57150, 6316.37]]),
    head_of_household: table([[0, 0], [852, 9.37], [2020, 35.07], [2604, 60.77], [3224, 101.69], [3808, 153.08], [19432, 1751.42], [23318, 2191.7], [38462, 4074.1], [38862, 4128.22]]),
  },
};

function perAllowance(values: number[], count: number): Cents {
  if (count <= 0) return 0;
  return count <= values.length ? d(values[count - 1]) : count * d(values[0]);
}

function caStatus(raw: string | null | undefined): CaStatus {
  return raw === 'married' || raw === 'head_of_household' ? raw : 'single';
}

export interface CaMethodBInput {
  period: CaPeriod;
  status: CaStatus;
  /** DE 4 line 1a. */
  regularAllowances: number;
  /** DE 4 line 1b. */
  estimatedDeductionAllowances: number;
  wagesCents: Cents;
}

/** Method B for one payroll period, unrounded cents (exported for the publication examples). */
export function caMethodB(input: CaMethodBInput): number {
  const { period, status, wagesCents } = input;
  const totalAllowances = input.regularAllowances + input.estimatedDeductionAllowances;
  // Married with 2+ allowances and head of household share the higher column of Tables 1 and 3.
  const column = status === 'head_of_household' || (status === 'married' && totalAllowances >= 2) ? 1 : 0;
  // Step 1: low-income exemption.
  if (wagesCents <= d(LOW_INCOME[period][column])) return 0;
  // Step 2: estimated deduction allowances; step 3: standard deduction.
  const taxable = wagesCents - perAllowance(ESTIMATED_DEDUCTION[period], input.estimatedDeductionAllowances) - d(STANDARD_DEDUCTION[period][column]);
  // Step 4: tax rate table; step 5: exemption allowance credit (regular allowances only).
  const tax = scheduleTax(taxable, TAX_TABLES[period][status]) - perAllowance(EXEMPTION_CREDIT[period], input.regularAllowances);
  return Math.max(0, tax);
}

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const period = periodTypeOf(input.periodsPerYear);
  if (!period) return unsupportedFrequencyResult(input, STATE, RULE_SET);

  const ytd = new YtdWriter(input, STATE);
  const issues = [...residenceIssue(input, STATE), ...provisionalIssue(STATE, [])];

  const wages = taxableWages(input, PIT_EXCLUSIONS);
  const cert = input.certificate;
  let incomeTax = 0;
  const exempt = cert?.exempt === true || certBoolean(input, 'military_spouse_exempt');
  if (!exempt) {
    // No DE 4: Single with zero allowances (DE 44 p. 16).
    const status = caStatus(cert?.filingStatus);
    const regularAllowances = cert ? certAllowances(input) : 0;
    const estimatedDeductionAllowances = cert ? Math.max(0, Math.trunc(certNumber(input, 'estimated_deduction_allowances'))) : 0;
    const methodB = (wagesCents: Cents) =>
      caMethodB({ period, status, regularAllowances, estimatedDeductionAllowances, wagesCents });
    if (wages.regular > 0) {
      // Supplemental wages paid with regular wages are treated as regular wages (DE 44 p. 18).
      incomeTax = roundCents(methodB(wages.regular + wages.supplemental));
    } else if (wages.supplemental > 0) {
      // Paid on their own: the flat rate, without allowances. The engine does not tell bonuses from other
      // supplemental pay, so the bonus rate (10.23%) applies; 6.6% would under-withhold a bonus.
      incomeTax = percentOf(wages.supplemental, SUPPLEMENTAL_BONUS_RATE_PERCENT);
    }
    if (wages.total > 0) incomeTax += certExtraCents(input);
  }
  recordIncomeTax(ytd, wages.total, incomeTax);

  const sui = computeSui(
    input,
    STATE,
    {
      wageBaseCents: UI_WAGE_BASE,
      newEmployerRatePercent: UI_NEW_EMPLOYER_RATE_PERCENT,
      exclusions: UI_SDI_EXCLUSIONS,
      surcharges: [{ code: 'ca_ett', labelKey: 'us.state_program.ca_ett', rateKey: 'ca_ett', defaultRatePercent: ETT_RATE_PERCENT }],
    },
    ytd,
  );
  issues.push(...sui.issues);

  const sdi = computeProgram(
    input,
    STATE,
    {
      code: 'ca_sdi',
      labelKey: 'us.state_program.ca_sdi',
      wagesCents: taxableWages(input, UI_SDI_EXCLUSIONS).total,
      wageBaseCents: null,
      employeeRatePercent: SDI_RATE_PERCENT,
      employerRatePercent: 0,
    },
    ytd,
  );

  return {
    stateWagesCents: wages.total,
    incomeTaxCents: incomeTax,
    sui: sui.sui,
    programs: [sdi, ...sui.programs],
    ytdUpdates: ytd.updates,
    issues,
    ruleSet: RULE_SET,
  };
}

export const CA_MODULE: StateModule = {
  code: STATE,
  name: 'California',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'DE 4',
    filingStatuses: ['single', 'married', 'head_of_household'],
    usesAllowances: true,
    fields: [
      { key: 'filingStatus', type: 'select', options: ['single', 'married', 'head_of_household'], required: true, labelKey: 'CA.filingStatus' },
      { key: 'allowances', type: 'number', labelKey: 'CA.allowances' },
      { key: 'estimated_deduction_allowances', type: 'number', labelKey: 'CA.estimated_deduction_allowances' },
      { key: 'extraWithholding', type: 'money', labelKey: 'CA.extraWithholding' },
      { key: 'exempt', type: 'boolean', labelKey: 'CA.exempt' },
      { key: 'military_spouse_exempt', type: 'boolean', labelKey: 'CA.military_spouse_exempt' },
    ],
  },
  employerRateCodes: [rateCode('ca_ett', 0.1)],
  calculate,
};
