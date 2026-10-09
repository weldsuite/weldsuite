/**
 * New Jersey: Gross Income Tax withholding (NJ-W4, percentage-method rate
 * tables A–E), worker contributions (UI + WF/SWF, TDI, FLI), employer UI,
 * WF/SWF and TDI.
 *
 * Sources (fetched 9 October 2026):
 * - NJ Division of Taxation, "Tables for Percentage Method of Withholding",
 *   applicable to wages paid on and after 1 October 2020 (still the current
 *   tables), https://www.nj.gov/treasury/taxation/pdf/NJWithholdingRateTablesPercentageMethod.pdf.
 * - NJ-WT, "New Jersey Income Tax Withholding Instructions" (September 2025),
 *   https://www.nj.gov/treasury/taxation/pdf/current/njwt.pdf: allowance
 *   values and which rate table to use (p. 24); supplemental wages (p. 11:
 *   combined with regular wages when paid together, otherwise without
 *   allowances); compensation subject to withholding (p. 6–7: 401(k)
 *   deferrals excluded; cafeteria plan amounts taxable; only Archer MSAs
 *   excluded); NJ–PA reciprocal agreement (p. 8, form NJ-165); percentage
 *   method examples (p. 25).
 * - Technical Bulletin TB-39(R), https://www.nj.gov/treasury/taxation/pdf/pubs/tb/tb39r.pdf:
 *   Section 125 salary reductions (premium conversion, FSAs) stay taxable.
 * - Form NJ-W4 (1-21), https://www.nj.gov/treasury/taxation/pdf/current/njw4.pdf.
 * - NJDOL, "Rate information, contributions, and due dates",
 *   https://www.nj.gov/labor/ea/employer-services/rate-info/ (2026): worker UI
 *   0.3825%, WF/SWF 0.0425%, TDI 0.19%, FLI 0.23%; UI/WF/SWF base (workers
 *   and employers) and employer TDI base $44,800; worker TDI/FLI base
 *   $171,100; new employer UI 2.6825% + WF/SWF 0.1175% (= 2.8%), TDI 0.5%.
 *   Confirmed by M-6025 (8-2026) maxima: UI/WF/SWF $190.40, DI $325.09, FLI $393.53.
 * - NJDOL Table C, July 2026 – June 2027,
 *   https://www.nj.gov/labor/ea/assets/PDFs/FY20262027%20TABLE%20C.pdf: every
 *   employer's table rate includes WF/SWF 0.1175%.
 * - NJDOL Employer Accounts Guide, https://nj.gov/labor/ea/assets/PDFs/EmployerAcctsGuide.pdf
 *   (p. 13–14): 401(k), Section 125 and dependent-care salary reductions are
 *   UI/TDI remuneration.
 *
 * Not verified: what to withhold when no NJ-W4 was given (neither NJ-WT nor
 * the NJ-W4 says). The module then uses Rate A with no allowances and flags
 * the payslip `provisional_rules`.
 *
 * Reciprocity: a Pennsylvania resident with form NJ-165 on file is exempt
 * from NJ withholding (the employer withholds PA tax instead, which v1 does
 * not compute). The NJ-165 is captured as `values.nj165_pa_resident`; it
 * stops NJ withholding and raises `residence_state_differs`.
 */

import type { Cents } from '../../money';
import {
  YtdWriter,
  certAllowances,
  certBoolean,
  certExtraCents,
  certString,
  computeProgram,
  computeSui,
  d,
  grossWages,
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
  NO_EXCLUSIONS,
  rateCode,
} from './common';
import type { PayrollIssue } from '../../types';
import type { StateCalcInput, StateCalcResult, StateModule } from './types';

const STATE = 'NJ';
const RULE_SET = 'us-nj-2026.1';

type NjRate = 'A' | 'B' | 'C' | 'D' | 'E';

/** NJ-WT p. 6–7 and TB-39(R): only 401(k) deferrals come off NJ wages. */
const GIT_EXCLUSIONS: PretaxExclusions = { retirement401k: true, section125: false, hsa: false, dependentCare: false };

/** NJ-WT p. 24. */
const ALLOWANCE: Record<PeriodType, number> = {
  weekly: 19.2,
  biweekly: 38.4,
  semimonthly: 41.6,
  monthly: 83.3,
  quarterly: 250,
  semiannual: 500,
  annual: 1000,
};

/** NJDOL 2026. */
const UI_WAGE_BASE = d(44800);
const WORKER_UI_WF_SWF_RATE_PERCENT = 0.425; // UI 0.3825% + WF/SWF 0.0425%, reported as one amount
const EMPLOYER_WF_SWF_RATE_PERCENT = 0.1175;
const NEW_EMPLOYER_UI_TOTAL_RATE_PERCENT = 2.8; // Table C "current rate", WF/SWF included
const TDI_FLI_WORKER_WAGE_BASE = d(171100);
const TDI_WORKER_RATE_PERCENT = 0.19;
const FLI_WORKER_RATE_PERCENT = 0.23;
const TDI_EMPLOYER_NEW_RATE_PERCENT = 0.5;

const RATES: Record<NjRate, number[]> = {
  A: [1.5, 2.0, 3.9, 6.1, 7.0, 9.9, 11.8],
  B: [1.5, 2.0, 2.7, 3.9, 6.1, 7.0, 9.9, 11.8],
  C: [1.5, 2.3, 2.8, 3.5, 5.6, 6.6, 9.9, 11.8],
  D: [1.5, 2.7, 3.4, 4.3, 5.6, 6.5, 9.9, 11.8],
  E: [1.5, 2.0, 5.8, 6.5, 9.9, 11.8],
};

type RawTable = [over: number, base: number][];

/** The published tables: [over, tax on the lower brackets]; the bracket rates are `RATES[table]`. */
const RAW: Record<NjRate, Record<PeriodType, RawTable>> = {
  A: {
    weekly: [[0, 0], [385, 5.77], [673, 11.54], [769, 15.29], [1442, 56.35], [9615, 628.46], [19231, 1580.38]],
    biweekly: [[0, 0], [769, 12], [1346, 23], [1538, 31], [2885, 113], [19231, 1257], [38462, 3161]],
    semimonthly: [[0, 0], [833, 13], [1458, 25], [1667, 33], [3125, 122], [20833, 1362], [41667, 3424]],
    monthly: [[0, 0], [1667, 25], [2917, 50], [3333, 66], [6250, 244], [41667, 2723], [83333, 6848]],
    quarterly: [[0, 0], [5000, 75], [8750, 150], [10000, 198.75], [18750, 732.5], [125000, 8170], [250000, 20545]],
    semiannual: [[0, 0], [10000, 150], [17500, 300], [20000, 397.5], [37500, 1465], [250000, 16340], [500000, 41090]],
    annual: [[0, 0], [20000, 300], [35000, 600], [40000, 795], [75000, 2930], [500000, 32680], [1000000, 82180]],
  },
  B: {
    weekly: [[0, 0], [385, 5.77], [962, 17.31], [1346, 27.69], [1538, 35.19], [2885, 117.31], [9615, 588.46], [19231, 1540.38]],
    biweekly: [[0, 0], [769, 12], [1923, 35], [2692, 55], [3077, 70], [5769, 235], [19231, 1177], [38462, 3081]],
    semimonthly: [[0, 0], [833, 12.5], [2083, 37.5], [2917, 59.99], [3333, 76.25], [6250, 254.19], [20833, 1275], [41667, 3338]],
    monthly: [[0, 0], [1667, 25], [4167, 75], [5833, 120], [6667, 153], [12500, 508], [41667, 2550], [83333, 6675]],
    quarterly: [[0, 0], [5000, 75], [12500, 225], [17500, 360], [20000, 457.5], [37500, 1525], [125000, 7650], [250000, 20025]],
    semiannual: [[0, 0], [10000, 150], [25000, 450], [35000, 720], [40000, 915], [75000, 3050], [250000, 15300], [500000, 40050]],
    annual: [[0, 0], [20000, 300], [50000, 900], [70000, 1440], [80000, 1830], [150000, 6100], [500000, 30600], [1000000, 80100]],
  },
  C: {
    weekly: [[0, 0], [385, 5.77], [769, 14.62], [962, 20], [1154, 26.73], [2885, 123.65], [9615, 567.88], [19231, 1519.81]],
    biweekly: [[0, 0], [769, 11.54], [1538, 29.23], [1923, 40], [2308, 53.46], [5769, 247.31], [19231, 1135.77], [38462, 3039.62]],
    semimonthly: [[0, 0], [833, 12.5], [1667, 31.67], [2083, 43.33], [2500, 57.92], [6250, 267.92], [20833, 1230.42], [41667, 3292.92]],
    monthly: [[0, 0], [1667, 25], [3333, 63.33], [4167, 86.67], [5000, 115.83], [12500, 535.85], [41667, 2460.83], [83333, 6585.83]],
    quarterly: [[0, 0], [5000, 75], [10000, 190], [12500, 260], [15000, 347.5], [37500, 1607.5], [125000, 7382.5], [250000, 19757.5]],
    semiannual: [[0, 0], [10000, 150], [20000, 380], [25000, 520], [30000, 695], [75000, 3215], [250000, 14765], [500000, 39515]],
    annual: [[0, 0], [20000, 300], [40000, 760], [50000, 1040], [60000, 1390], [150000, 6430], [500000, 29530], [1000000, 79030]],
  },
  D: {
    weekly: [[0, 0], [385, 5.77], [769, 16.15], [962, 22.69], [1154, 30.96], [2885, 127.88], [9615, 565.38], [19231, 1517.31]],
    biweekly: [[0, 0], [769, 11.54], [1538, 32.31], [1923, 45.38], [2308, 61.92], [5769, 255.77], [19231, 1130.77], [38462, 3034.62]],
    semimonthly: [[0, 0], [833, 12.5], [1667, 35], [2083, 49.17], [2500, 67.08], [6250, 277.08], [20833, 1225], [41667, 3287.5]],
    monthly: [[0, 0], [1667, 25], [3333, 70], [4167, 98.33], [5000, 134.17], [12500, 554.17], [41667, 2450], [83333, 6575]],
    quarterly: [[0, 0], [5000, 75], [10000, 210], [12500, 295], [15000, 402.5], [37500, 1662.5], [125000, 7350], [250000, 19725]],
    semiannual: [[0, 0], [10000, 150], [20000, 420], [25000, 590], [30000, 805], [75000, 3325], [250000, 14700], [500000, 39450]],
    annual: [[0, 0], [20000, 300], [40000, 840], [50000, 1180], [60000, 1610], [150000, 6650], [500000, 29400], [1000000, 78900]],
  },
  E: {
    weekly: [[0, 0], [385, 5.77], [673, 11.54], [1923, 84.04], [9615, 584.04], [19231, 1535.96]],
    biweekly: [[0, 0], [769, 12], [1346, 23], [3846, 168], [19231, 1168], [38462, 3072]],
    semimonthly: [[0, 0], [833, 13], [1458, 25], [4167, 182], [20833, 1265], [41667, 3328]],
    monthly: [[0, 0], [1667, 25], [2917, 50], [8333, 364], [41667, 2531], [83333, 6656]],
    quarterly: [[0, 0], [5000, 75], [8750, 150], [25000, 1092.5], [125000, 7592.5], [250000, 19967.5]],
    semiannual: [[0, 0], [10000, 150], [17500, 300], [50000, 2185], [250000, 15185], [500000, 39935]],
    annual: [[0, 0], [20000, 300], [35000, 600], [100000, 4370], [500000, 30370], [1000000, 79870]],
  },
};

function table(rate: NjRate, period: PeriodType): ScheduleRow[] {
  return RAW[rate][period].map(([over, base], i) => ({ over: d(over), baseCents: d(base), ratePercent: RATES[rate][i] }));
}

const RATE_TABLES = ['A', 'B', 'C', 'D', 'E'] as const;

/** NJ-WT p. 24: Rate A for single / married filing separately; B for the other statuses; the NJ-W4 line 3 letter wins. */
function rateTable(input: StateCalcInput): NjRate {
  const chosen = certString(input, 'rate_table');
  if (chosen && (RATE_TABLES as readonly string[]).includes(chosen)) return chosen as NjRate;
  const status = input.certificate?.filingStatus;
  return status === 'married_joint' || status === 'head_of_household' || status === 'qualifying_widow' ? 'B' : 'A';
}

/** Percentage method for one period (unrounded cents). Exported for the NJ-WT examples. */
export function njWithholding(wagesCents: Cents, rate: NjRate, period: PeriodType, allowances: number): number {
  const subject = wagesCents - allowances * d(ALLOWANCE[period]);
  return scheduleTax(subject, table(rate, period));
}

function calculate(input: StateCalcInput): StateCalcResult {
  if (input.taxYear !== 2026) return unsupportedYearResult(input, STATE);
  const period = periodTypeOf(input.periodsPerYear);
  if (!period) return unsupportedFrequencyResult(input, STATE, RULE_SET);

  const ytd = new YtdWriter(input, STATE);
  const cert = input.certificate;
  const issues: PayrollIssue[] = [...residenceIssue(input, STATE), ...provisionalIssue(STATE, cert ? [] : ['no NJ-W4: Rate A, no allowances'])];

  const wages = taxableWages(input, GIT_EXCLUSIONS);
  let incomeTax = 0;
  const exempt = cert?.exempt === true || certBoolean(input, 'nj165_pa_resident');
  if (!exempt) {
    const rate = rateTable(input);
    const allowances = cert ? certAllowances(input) : 0;
    if (wages.regular > 0) {
      // Paid with regular wages: withhold on the combined payment (NJ-WT p. 11).
      incomeTax = roundCents(njWithholding(wages.regular + wages.supplemental, rate, period, allowances));
    } else if (wages.supplemental > 0) {
      // Paid at a different time: no exemption allowances.
      incomeTax = roundCents(njWithholding(wages.supplemental, rate, period, 0));
    }
    if (wages.total > 0) incomeTax += certExtraCents(input);
  }
  recordIncomeTax(ytd, wages.total, incomeTax);

  // The employer's rate (Table C "current rate") includes WF/SWF 0.1175%, split out as its own line.
  const totalUiRate = input.suiRatePercent ?? null;
  const sui = computeSui(
    { ...input, suiRatePercent: totalUiRate === null ? null : Math.max(0, totalUiRate - EMPLOYER_WF_SWF_RATE_PERCENT) },
    STATE,
    {
      wageBaseCents: UI_WAGE_BASE,
      newEmployerRatePercent: NEW_EMPLOYER_UI_TOTAL_RATE_PERCENT - EMPLOYER_WF_SWF_RATE_PERCENT,
      exclusions: NO_EXCLUSIONS,
      employee: { ratePercent: WORKER_UI_WF_SWF_RATE_PERCENT, wageBaseCents: UI_WAGE_BASE },
      surcharges: [{ code: 'nj_wf_swf', labelKey: 'us.state_program.nj_wf_swf', rateKey: 'nj_wf_swf', defaultRatePercent: EMPLOYER_WF_SWF_RATE_PERCENT }],
    },
    ytd,
  );
  issues.push(...sui.issues);

  const gross = input.exemptFromSui ? 0 : grossWages(input);
  // A private TDI or FLI plan replaces the state plan: `extraRates.nj_tdi_employee` / `nj_fli_employee` = 0.
  const tdi = computeProgram(
    input,
    STATE,
    {
      code: 'nj_tdi',
      labelKey: 'us.state_program.nj_tdi',
      wagesCents: gross,
      wageBaseCents: TDI_FLI_WORKER_WAGE_BASE,
      employeeRatePercent: input.extraRates.nj_tdi_employee ?? TDI_WORKER_RATE_PERCENT,
      employerRatePercent: 0,
    },
    ytd,
  );
  const tdiEmployer = computeProgram(
    input,
    STATE,
    {
      code: 'nj_tdi_employer',
      labelKey: 'us.state_program.nj_tdi_employer',
      wagesCents: gross,
      wageBaseCents: UI_WAGE_BASE,
      employeeRatePercent: 0,
      employerRatePercent: input.extraRates.nj_employer_tdi ?? TDI_EMPLOYER_NEW_RATE_PERCENT,
    },
    ytd,
  );
  const fli = computeProgram(
    input,
    STATE,
    {
      code: 'nj_fli',
      labelKey: 'us.state_program.nj_fli',
      wagesCents: gross,
      wageBaseCents: TDI_FLI_WORKER_WAGE_BASE,
      employeeRatePercent: input.extraRates.nj_fli_employee ?? FLI_WORKER_RATE_PERCENT,
      employerRatePercent: 0,
    },
    ytd,
  );
  if (input.extraRates.nj_employer_tdi === undefined) {
    issues.push({ severity: 'warning', code: 'employer_incomplete', params: { state: STATE, field: 'nj_employer_tdi', fallbackRatePercent: TDI_EMPLOYER_NEW_RATE_PERCENT } });
  }

  return {
    stateWagesCents: wages.total,
    incomeTaxCents: incomeTax,
    sui: sui.sui,
    programs: [tdi, fli, tdiEmployer, ...sui.programs],
    ytdUpdates: ytd.updates,
    issues,
    ruleSet: RULE_SET,
  };
}

export const NJ_MODULE: StateModule = {
  code: STATE,
  name: 'New Jersey',
  hasIncomeTax: true,
  supportedYears: [2026],
  certificate: {
    formName: 'NJ-W4',
    filingStatuses: ['single', 'married_joint', 'married_separate', 'head_of_household', 'qualifying_widow'],
    usesAllowances: true,
    fields: [
      { key: 'filingStatus', type: 'select', options: ['single', 'married_joint', 'married_separate', 'head_of_household', 'qualifying_widow'], required: true, labelKey: 'NJ.filingStatus' },
      { key: 'rate_table', type: 'select', options: ['A', 'B', 'C', 'D', 'E'], labelKey: 'NJ.rate_table' },
      { key: 'allowances', type: 'number', labelKey: 'NJ.allowances' },
      { key: 'extraWithholding', type: 'money', labelKey: 'NJ.extraWithholding' },
      { key: 'exempt', type: 'boolean', labelKey: 'NJ.exempt' },
      { key: 'nj165_pa_resident', type: 'boolean', labelKey: 'NJ.nj165_pa_resident' },
    ],
  },
  employerRateCodes: [rateCode('nj_employer_tdi', 0.5), rateCode('nj_wf_swf', 0.1175), rateCode('nj_tdi_employee', 0.19), rateCode('nj_fli_employee', 0.23)],
  calculate,
};

