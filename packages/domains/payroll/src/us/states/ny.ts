/**
 * New York: state income tax withholding (IT-2104, NYS-50-T-NYS exact
 * calculation method), Paid Family Leave, Disability Benefits Law (DBL)
 * employee contribution, UI and the Re-employment Service Fund.
 *
 * New York City and Yonkers taxes are out of scope in v1: an employee who
 * says on the IT-2104 that they live in New York City or Yonkers gets a
 * `local_tax_not_supported` warning. Yonkers nonresident tax depends on the
 * work location, which the engine does not know, so it is not flagged.
 *
 * Sources (fetched 9 October 2026):
 * - NYS-50-T-NYS (1/26), "New York State Withholding Tax Tables and Methods",
 *   effective 1 January 2026, https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_nys.pdf:
 *   supplemental rate 11.70% (p. 3); Tables B and C, deduction and exemption
 *   allowances (p. 14); Method II exact calculation tables and examples
 *   (p. 16–19); Method III top income tax rates (p. 22); conversion of
 *   tables for other payroll periods (p. 23).
 * - NYS-50 (12/25), "Employer's Guide to Unemployment Insurance, Wage
 *   Reporting, and Withholding Tax", https://www.tax.ny.gov/pubs_and_bulls/publications/nys50/:
 *   no IT-2104 with a 2020+ W-4 → zero allowances; 2026 UI wage base $17,600;
 *   Re-employment Service Fund 0.075%; UI remuneration includes 401(k)
 *   deferrals, Section 125 cafeteria contributions and dependent care, while
 *   withholding wages follow federal wages ("UI, wage reporting, and
 *   withholding tax requirements for certain items of income").
 * - NYS DOL, "Unemployment Insurance Rate Information",
 *   https://dol.ny.gov/unemployment-insurance-rate-information: 2026 new
 *   employer rate 4.025% UI + 0.075% RSF = 4.1%.
 * - NY Paid Family Leave, "Employee Notice of Paid Family Leave Payroll
 *   Deduction for 2026" and https://paidfamilyleave.ny.gov/2026: 0.432% of
 *   gross wages, annual maximum $411.91, NYSAWW $1,833.63.
 * - NYS Workers' Compensation Board, disability benefits for employers,
 *   https://www.wcb.ny.gov/content/main/DisabilityBenefits/employer-disability-benefits.jsp: employee
 *   DBL contribution one-half of one percent of wages, at most 60 cents a week;
 *   collecting it (and the PFL contribution) is allowed, not required.
 */

import { percentOf, type Cents } from '../../money';
import {
  FEDERAL_INCOME_TAX_LIKE,
  YtdWriter,
  certAllowances,
  certBoolean,
  certExtraCents,
  computeProgram,
  computeSui,
  d,
  grossWages,
  nominalPeriods,
  periodTypeOf,
  recordIncomeTax,
  residenceIssue,
  roundCents,
  scheduleTax,
  taxableWages,
  unsupportedFrequencyResult,
  unsupportedYearResult,
  type PretaxExclusions,
  type ScheduleRow,
  NO_EXCLUSIONS,
  rateCode,
} from './common';
import type { PayrollIssue } from '../../types';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'NY';
const RULE_SET = 'us-ny-2026.1';

type NyTableStatus = 'single' | 'married';
type NyPeriod = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'annual';


/** NYS-50-T-NYS p. 3. */
const SUPPLEMENTAL_RATE_PERCENT = 11.7;

/** NYS-50 (12/25) and dol.ny.gov. */
const UI_WAGE_BASE = d(17600);
const UI_NEW_EMPLOYER_RATE_PERCENT = 4.025;
const RSF_RATE_PERCENT = 0.075;

/** PFL 2026: 0.432% of gross wages up to $411.91 a year (NYSAWW $1,833.63 × 52 = $95,348.76 of wages). */
const PFL_RATE_PERCENT = 0.432;
const PFL_ANNUAL_MAX = d(411.91);
const PFL_WAGE_BASE = d(95348.76);

/** DBL: 0.5% of wages, at most $0.60 a week. */
const DBL_RATE_PERCENT = 0.5;
const DBL_WEEKLY_MAX = d(0.6);

/** Table B: deduction allowance; Table C: value of one exemption ($1,000 a year). */
const DEDUCTION: Record<NyPeriod, Record<NyTableStatus, number>> = {
  weekly: { single: 142.3, married: 152.9 },
  biweekly: { single: 284.6, married: 305.8 },
  semimonthly: { single: 308.35, married: 331.25 },
  monthly: { single: 616.7, married: 662.5 },
  annual: { single: 7400, married: 7950 },
};
const EXEMPTION: Record<NyPeriod, number> = { weekly: 19.25, biweekly: 38.5, semimonthly: 41.65, monthly: 83.3, annual: 1000 };

function rows(lines: [atLeast: number, rate: number, add: number][]): ScheduleRow[] {
  // In every line of the exact calculation tables, column 3 (subtract) equals column 1 (at least).
  return lines.map(([atLeast, rate, add]) => ({ over: d(atLeast), baseCents: d(add), ratePercent: rate * 100 }));
}

/** Method II tables (p. 17 single, p. 19 married): [at least, column 4, column 5]. */
const EXACT: Record<NyPeriod, Record<NyTableStatus, { rows: ScheduleRow[]; methodIIIFrom: Cents }>> = {
  weekly: {
    single: {
      rows: rows([[0, 0.039, 0], [163, 0.044, 6.38], [225, 0.0515, 9.08], [267, 0.054, 11.27], [1551, 0.059, 80.58], [1862, 0.0703, 98.9], [2070, 0.0753, 113.58], [3032, 0.064, 186.02], [4142, 0.1144, 257.1], [5104, 0.0735, 367.13]]),
      methodIIIFrom: d(20722),
    },
    married: {
      rows: rows([[0, 0.039, 0], [163, 0.044, 6.38], [225, 0.0515, 9.08], [267, 0.054, 11.27], [1551, 0.059, 80.58], [1862, 0.0657, 98.9], [2070, 0.0707, 112.6], [3032, 0.0801, 180.54], [4068, 0.064, 263.62], [6215, 0.1349, 401.04], [7177, 0.0735, 530.77], [20722, 0.0765, 1526.33]]),
      methodIIIFrom: d(41449),
    },
  },
  biweekly: {
    single: {
      rows: rows([[0, 0.039, 0], [327, 0.044, 12.77], [450, 0.0515, 18.15], [535, 0.054, 22.54], [3102, 0.059, 161.15], [3723, 0.0703, 197.81], [4140, 0.0753, 227.15], [6063, 0.064, 372.04], [8285, 0.1144, 514.19], [10208, 0.0735, 734.27]]),
      methodIIIFrom: d(41444),
    },
    married: {
      rows: rows([[0, 0.039, 0], [327, 0.044, 12.77], [450, 0.0515, 18.15], [535, 0.054, 22.54], [3102, 0.059, 161.15], [3723, 0.0657, 197.81], [4140, 0.0707, 225.19], [6063, 0.0801, 361.08], [8137, 0.064, 527.23], [12431, 0.1349, 802.08], [14354, 0.0735, 1061.54], [41444, 0.0765, 3052.65]]),
      methodIIIFrom: d(82898),
    },
  },
  semimonthly: {
    single: {
      rows: rows([[0, 0.039, 0], [354, 0.044, 13.83], [488, 0.0515, 19.67], [579, 0.054, 24.42], [3360, 0.059, 174.58], [4033, 0.0703, 214.29], [4485, 0.0753, 246.08], [6569, 0.064, 403.04], [8975, 0.1144, 557.04], [11058, 0.0735, 795.46]]),
      methodIIIFrom: d(44898),
    },
    married: {
      rows: rows([[0, 0.039, 0], [354, 0.044, 13.83], [488, 0.0515, 19.67], [579, 0.054, 24.42], [3360, 0.059, 174.58], [4033, 0.0657, 214.29], [4485, 0.0707, 243.96], [6569, 0.0801, 391.17], [8815, 0.064, 571.17], [13467, 0.1349, 868.92], [15550, 0.0735, 1150.0], [44898, 0.0765, 3307.04]]),
      methodIIIFrom: d(89806),
    },
  },
  monthly: {
    single: {
      rows: rows([[0, 0.039, 0], [708, 0.044, 27.67], [975, 0.0515, 39.33], [1158, 0.054, 48.83], [6721, 0.059, 349.17], [8067, 0.0703, 428.58], [8971, 0.0753, 492.17], [13138, 0.064, 806.08], [17950, 0.1144, 1114.08], [22117, 0.0735, 1590.92]]),
      methodIIIFrom: d(89796),
    },
    married: {
      rows: rows([[0, 0.039, 0], [708, 0.044, 27.67], [975, 0.0515, 39.33], [1158, 0.054, 48.83], [6721, 0.059, 349.17], [8067, 0.0657, 428.58], [8971, 0.0707, 487.92], [13138, 0.0801, 782.33], [17629, 0.064, 1142.33], [26933, 0.1349, 1737.83], [31100, 0.0735, 2300.0], [89796, 0.0765, 6614.08]]),
      methodIIIFrom: d(179613),
    },
  },
  annual: {
    single: {
      rows: rows([[0, 0.039, 0], [8500, 0.044, 332], [11700, 0.0515, 472], [13900, 0.054, 586], [80650, 0.059, 4190], [96800, 0.0703, 5143], [107650, 0.0753, 5906], [157650, 0.064, 9673], [215400, 0.1144, 13369], [265400, 0.0735, 19091]]),
      methodIIIFrom: d(1077550),
    },
    married: {
      rows: rows([[0, 0.039, 0], [8500, 0.044, 332], [11700, 0.0515, 472], [13900, 0.054, 586], [80650, 0.059, 4190], [96800, 0.0657, 5143], [107650, 0.0707, 5855], [157650, 0.0801, 9388], [211550, 0.064, 13708], [323200, 0.1349, 20854], [373200, 0.0735, 27600], [1077550, 0.0765, 79369]]),
      methodIIIFrom: d(2155350),
    },
  },
};

/** Method III (p. 22): a flat rate on the whole annualized net wage, by annualized net wage. */
function methodIIIRate(annualizedNetCents: Cents): number {
  if (annualizedNetCents < d(5_000_000)) return 10.45;
  if (annualizedNetCents < d(25_000_000)) return 11.1;
  return 11.7;
}

export interface NyExactInput {
  period: NyPeriod;
  status: NyTableStatus;
  /** IT-2104 line 1. */
  allowances: number;
  wagesCents: Cents;
  /** For Method III's annualizing. */
  periodsPerYear: number;
}

/** Method II (or III above the top line) for one payroll period, unrounded cents. Exported for the publication examples. */
export function nyExactWithholding(input: NyExactInput): number {
  const { period, status } = input;
  // Step 1: subtract the deduction allowance plus one exemption amount per allowance (Table A = B + n × C).
  const net = input.wagesCents - d(DEDUCTION[period][status]) - input.allowances * d(EXEMPTION[period]);
  if (net <= 0) return 0;
  const table = EXACT[period][status];
  if (net >= table.methodIIIFrom) return (net * methodIIIRate(net * input.periodsPerYear)) / 100;
  // Steps 2–5: (net − column 3) × column 4 + column 5, on the "at least … but less than" line.
  return scheduleTax(net, table.rows, 'atLeast');
}

/** The table period, or a monthly conversion factor (NYS-50-T-NYS p. 23, general rule) for quarterly and semiannual payrolls. */
function nyPeriod(periodsPerYear: number): { period: NyPeriod; factor: number } | null {
  const type = periodTypeOf(periodsPerYear);
  switch (type) {
    case 'weekly':
    case 'biweekly':
    case 'semimonthly':
    case 'monthly':
    case 'annual':
      return { period: type, factor: 1 };
    case 'quarterly':
      return { period: 'monthly', factor: 3 };
    case 'semiannual':
      return { period: 'monthly', factor: 6 };
    default:
      return null;
  }
}

function tableStatus(raw: string | null | undefined): NyTableStatus {
  // "Married, but withhold at higher single rate" and "Single or Head of household" use the single tables.
  return raw === 'married' ? 'married' : 'single';
}

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const conversion = nyPeriod(input.periodsPerYear);
  if (!conversion) return unsupportedFrequencyResult(input, STATE, RULE_SET);
  const { period, factor } = conversion;

  const ytd = new YtdWriter(input, STATE);
  const issues: PayrollIssue[] = [...residenceIssue(input, STATE)];
  for (const [key, locality] of [['nyc_resident', 'NYC'], ['yonkers_resident', 'Yonkers']] as const) {
    if (certBoolean(input, key)) issues.push({ severity: 'warning', code: 'local_tax_not_supported', params: { state: STATE, locality } });
  }

  const wages = taxableWages(input, FEDERAL_INCOME_TAX_LIKE);
  const cert = input.certificate;
  let incomeTax = 0;
  if (!cert?.exempt) {
    // No IT-2104 (and a 2020+ federal W-4): zero allowances; status single (NYS-50).
    const status = tableStatus(cert?.filingStatus);
    const allowances = cert ? certAllowances(input) : 0;
    const withhold = (wagesCents: Cents) =>
      roundCents(factor * nyExactWithholding({ period, status, allowances, wagesCents: wagesCents / factor, periodsPerYear: input.periodsPerYear * factor }));
    const regularTax = wages.regular > 0 ? withhold(wages.regular) : 0;
    let supplementalTax = 0;
    if (wages.supplemental > 0) {
      // Specified supplemental pay: 11.70% when tax is withheld from regular wages (method a); otherwise
      // aggregate with the regular wages and withhold the difference (method b).
      supplementalTax =
        wages.regular > 0 && regularTax === 0
          ? withhold(wages.regular + wages.supplemental) - regularTax
          : percentOf(wages.supplemental, SUPPLEMENTAL_RATE_PERCENT);
    }
    incomeTax = regularTax + supplementalTax;
    if (wages.total > 0) incomeTax += certExtraCents(input);
  }
  recordIncomeTax(ytd, wages.total, incomeTax);

  const sui = computeSui(
    input,
    STATE,
    {
      wageBaseCents: UI_WAGE_BASE,
      newEmployerRatePercent: UI_NEW_EMPLOYER_RATE_PERCENT,
      exclusions: NO_EXCLUSIONS,
      surcharges: [{ code: 'ny_rsf', labelKey: 'us.state_program.ny_rsf', rateKey: 'ny_rsf', defaultRatePercent: RSF_RATE_PERCENT }],
    },
    ytd,
  );
  issues.push(...sui.issues);

  const gross = grossWages(input);
  // The employer may pay the employee shares itself: `extraRates.ny_pfl_employee` / `ny_dbl_employee` = 0.
  const pfl = computeProgram(
    input,
    STATE,
    {
      code: 'ny_pfl',
      labelKey: 'us.state_program.ny_pfl',
      wagesCents: gross,
      wageBaseCents: PFL_WAGE_BASE,
      employeeRatePercent: input.extraRates.ny_pfl_employee ?? PFL_RATE_PERCENT,
      employerRatePercent: 0,
      employeeAnnualMaxCents: PFL_ANNUAL_MAX,
    },
    ytd,
  );
  const dbl = computeProgram(
    input,
    STATE,
    {
      code: 'ny_dbl',
      labelKey: 'us.state_program.ny_dbl',
      wagesCents: gross,
      wageBaseCents: null,
      employeeRatePercent: input.extraRates.ny_dbl_employee ?? DBL_RATE_PERCENT,
      employerRatePercent: 0,
      employeePeriodMaxCents: roundCents((DBL_WEEKLY_MAX * 52) / nominalPeriods(input.periodsPerYear)),
    },
    ytd,
  );

  return {
    stateWagesCents: wages.total,
    incomeTaxCents: incomeTax,
    sui: sui.sui,
    programs: [pfl, dbl, ...sui.programs],
    ytdUpdates: ytd.updates,
    issues,
    ruleSet: RULE_SET,
  };
}

export const NY_MODULE: StateModule = {
  code: STATE,
  name: 'New York',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'IT-2104',
    filingStatuses: ['single', 'married', 'married_higher_single'],
    usesAllowances: true,
    fields: [
      { key: 'filingStatus', type: 'select', options: ['single', 'married', 'married_higher_single'], required: true, labelKey: 'NY.filingStatus' },
      { key: 'allowances', type: 'number', labelKey: 'NY.allowances' },
      { key: 'extraWithholding', type: 'money', labelKey: 'NY.extraWithholding' },
      { key: 'nyc_resident', type: 'boolean', labelKey: 'NY.nyc_resident' },
      { key: 'yonkers_resident', type: 'boolean', labelKey: 'NY.yonkers_resident' },
      { key: 'exempt', type: 'boolean', labelKey: 'NY.exempt' },
    ],
  },
  employerRateCodes: [rateCode('ny_rsf', 0.075), rateCode('ny_pfl_employee', 0.432), rateCode('ny_dbl_employee', 0.5)],
  calculate,
};
