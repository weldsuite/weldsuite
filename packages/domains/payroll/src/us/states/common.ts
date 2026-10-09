/**
 * Building blocks the state modules share: wage bases with year-to-date caps,
 * state taxable wages after the pre-tax items a state excludes, SUI with the
 * new-employer fallback, capped payroll programs, and the standard issues.
 *
 * Amounts are integer cents. A module computes in (possibly fractional) cents
 * and rounds once, with the rule its publication prescribes.
 */

import { percentOf, roundHalfAwayFromZero, toCents, type Cents } from '../../money';
import type { PayrollIssue } from '../../types';
import type { StateCalcInput, StateCalcResult, StateProgramResult } from './types';

// ---------------------------------------------------------------------------
// Year-to-date keys
// ---------------------------------------------------------------------------

/** `us.state.<ST>.<name>`: the accumulator keys a state module owns. */
export function ytdKey(state: string, name: string): string {
  return `us.state.${state}.${name}`;
}

export function readYtd(input: StateCalcInput, state: string, name: string): Cents {
  return input.ytd[ytdKey(state, name)] ?? 0;
}

/** Collects new accumulator totals (previous YTD + this period) for the result. */
export class YtdWriter {
  readonly updates: Record<string, Cents> = {};

  constructor(
    private readonly input: StateCalcInput,
    private readonly state: string,
  ) {}

  add(name: string, cents: Cents): void {
    const key = ytdKey(this.state, name);
    const base = key in this.updates ? this.updates[key]! : (this.input.ytd[key] ?? 0);
    this.updates[key] = base + cents;
  }
}

// ---------------------------------------------------------------------------
// Wages
// ---------------------------------------------------------------------------

/** Which pre-tax deductions a state takes out of a wage base. */
export interface PretaxExclusions {
  retirement401k: boolean;
  section125: boolean;
  hsa: boolean;
  dependentCare: boolean;
}

/**
 * Wage base that follows FICA/FUTA: Section 125 premiums, HSA salary
 * reductions through a cafeteria plan and dependent care are excluded;
 * 401(k) elective deferrals are not. Most states define UI wages this way.
 */
export const FICA_LIKE: PretaxExclusions = { retirement401k: false, section125: true, hsa: true, dependentCare: true };

/** Gross wages: no pre-tax item comes off (NY UI, NJ UI/TDI/FLI, MA PFML). */
export const NO_EXCLUSIONS: PretaxExclusions = { retirement401k: false, section125: false, hsa: false, dependentCare: false };

/** Wage base that follows federal income tax wages (W-2 box 1). */
export const FEDERAL_INCOME_TAX_LIKE: PretaxExclusions = { retirement401k: true, section125: true, hsa: true, dependentCare: true };

export function grossWages(input: StateCalcInput): Cents {
  return input.regularWagesCents + input.supplementalWagesCents;
}

export function excludedPretax(input: StateCalcInput, exclusions: PretaxExclusions): Cents {
  const p = input.pretax;
  return (
    (exclusions.retirement401k ? p.retirement401kCents : 0) +
    (exclusions.section125 ? p.section125Cents : 0) +
    (exclusions.hsa ? p.hsaCents : 0) +
    (exclusions.dependentCare ? p.dependentCareCents : 0)
  );
}

/**
 * Taxable regular and supplemental wages after the excluded pre-tax items.
 * Pre-tax deductions come out of regular pay first; whatever regular pay
 * cannot absorb reduces supplemental pay.
 */
export function taxableWages(input: StateCalcInput, exclusions: PretaxExclusions): { regular: Cents; supplemental: Cents; total: Cents } {
  const excluded = excludedPretax(input, exclusions);
  const regular = Math.max(0, input.regularWagesCents - excluded);
  const overflow = Math.max(0, excluded - input.regularWagesCents);
  const supplemental = Math.max(0, input.supplementalWagesCents - overflow);
  return { regular, supplemental, total: regular + supplemental };
}

/** The part of `wages` that still fits under an annual `base`, given what was taxed before. */
export function underBase(wages: Cents, ytdTaxed: Cents, base: Cents | null): Cents {
  if (wages <= 0) return 0;
  if (base === null) return wages;
  return Math.max(0, Math.min(wages, base - ytdTaxed));
}

// ---------------------------------------------------------------------------
// Pay periods
// ---------------------------------------------------------------------------

export type PeriodType = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'semiannual' | 'annual';

/** The payroll period a state table is keyed by; null when the publication has none for it. */
export function periodTypeOf(periodsPerYear: number): PeriodType | null {
  switch (periodsPerYear) {
    case 52:
    case 53:
      return 'weekly';
    case 26:
    case 27:
      return 'biweekly';
    case 24:
      return 'semimonthly';
    case 12:
      return 'monthly';
    case 4:
      return 'quarterly';
    case 2:
      return 'semiannual';
    case 1:
      return 'annual';
    default:
      return null;
  }
}

/**
 * Nominal periods per year for annualizing: a 53rd weekly (27th biweekly)
 * payday in a year is still annualized as 52 (26), as the state formulas
 * are written per payroll period, not per payday count.
 */
export function nominalPeriods(periodsPerYear: number): number {
  if (periodsPerYear === 53) return 52;
  if (periodsPerYear === 27) return 26;
  return periodsPerYear;
}

// ---------------------------------------------------------------------------
// Tax schedules
// ---------------------------------------------------------------------------

/** A tax-rate row: on amounts over `over`, `baseCents` plus `ratePercent` of the excess. */
export interface ScheduleRow {
  over: Cents;
  baseCents: number;
  ratePercent: number;
}

/**
 * Tax from a schedule (unrounded cents); rows sorted by `over`, the first row
 * usually `over: 0`. `boundary` says whether a row applies to amounts
 * strictly over its threshold (`over`, most states) or from it (`atLeast`,
 * New York's "at least … but less than" tables, which are not continuous).
 */
export function scheduleTax(amount: Cents, rows: readonly ScheduleRow[], boundary: 'over' | 'atLeast' = 'over'): number {
  if (amount <= 0) return 0;
  let row: ScheduleRow | undefined;
  for (const r of rows) {
    if (boundary === 'over' ? amount > r.over : amount >= r.over) row = r;
    else break;
  }
  if (!row) return 0;
  return row.baseCents + ((amount - row.over) * row.ratePercent) / 100;
}

/** Progressive brackets without published base amounts: `ratePercent` on the slice above `over`. */
export function progressiveTax(amount: Cents, brackets: readonly { over: Cents; ratePercent: number }[]): number {
  if (amount <= 0) return 0;
  let tax = 0;
  for (let i = 0; i < brackets.length; i += 1) {
    const lower = brackets[i]!.over;
    const upper = i + 1 < brackets.length ? brackets[i + 1]!.over : Number.POSITIVE_INFINITY;
    if (amount <= lower) break;
    tax += ((Math.min(amount, upper) - lower) * brackets[i]!.ratePercent) / 100;
  }
  return tax;
}

/** Dollars → cents for table literals (`d(1234.56)`). */
export function d(dollars: number): Cents {
  return toCents(dollars);
}

/** Round fractional cents to whole cents. */
export function roundCents(n: number): Cents {
  return roundHalfAwayFromZero(n);
}

/** Round to whole dollars (half up), in cents. Several states allow or prescribe whole-dollar withholding. */
export function roundToDollar(cents: number): Cents {
  return roundHalfAwayFromZero(cents / 100) * 100;
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

export function certNumber(input: StateCalcInput, key: string): number {
  const v = input.certificate?.values?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

export function certBoolean(input: StateCalcInput, key: string): boolean {
  const v = input.certificate?.values?.[key];
  return v === true || v === 'true' || v === 1;
}

export function certString(input: StateCalcInput, key: string): string | null {
  const v = input.certificate?.values?.[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Whole allowances from the certificate (`allowances`), never negative. */
export function certAllowances(input: StateCalcInput): number {
  const a = input.certificate?.allowances ?? 0;
  return Number.isFinite(a) ? Math.max(0, Math.trunc(a)) : 0;
}

/** Extra withholding per pay period from the certificate, in cents. */
export function certExtraCents(input: StateCalcInput): Cents {
  const extra = input.certificate?.extraWithholding ?? 0;
  return extra > 0 ? toCents(extra) : 0;
}

// ---------------------------------------------------------------------------
// SUI
// ---------------------------------------------------------------------------

/** An employer-paid charge levied on the SUI taxable wages next to the UI rate (CA ETT, NY RSF, MA WTF…). */
export interface SuiSurcharge {
  code: string;
  labelKey: string;
  /** Key in `extraRates` that overrides the default, e.g. `ca_ett`. */
  rateKey: string;
  defaultRatePercent: number;
}

export interface SuiRules {
  /** Taxable wage base for the year (cents). */
  wageBaseCents: Cents;
  /**
   * Rate used when the employer has not entered its own (percent). Null when
   * the state has no single new-employer rate (Washington assigns one per
   * industry): a missing rate is then an error and no employer SUI is computed.
   */
  newEmployerRatePercent: number | null;
  /** Pre-tax items excluded from UI wages. */
  exclusions: PretaxExclusions;
  /** Employee contribution (AK, NJ, PA). `wageBaseCents` null = all wages. */
  employee?: { ratePercent: number; wageBaseCents: Cents | null };
  surcharges?: SuiSurcharge[];
}

export interface SuiOutcome {
  sui: StateCalcResult['sui'];
  /** Surcharges, as employer-only programs. */
  programs: StateProgramResult[];
  issues: PayrollIssue[];
}

/**
 * SUI for one period. YTD: `sui_wages` (taxable, for the base),
 * `sui_gross_wages`, `sui_employee_wages` (when the employee base differs).
 */
export function computeSui(input: StateCalcInput, state: string, rules: SuiRules, ytd: YtdWriter): SuiOutcome {
  const issues: PayrollIssue[] = [];
  if (input.exemptFromSui) {
    return { sui: { taxableWagesCents: 0, grossWagesCents: 0, employerCents: 0, employeeCents: 0 }, programs: [], issues };
  }
  const gross = taxableWages(input, rules.exclusions).total;
  const taxable = underBase(gross, readYtd(input, state, 'sui_wages'), rules.wageBaseCents);

  let rate = input.suiRatePercent;
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    if (rules.newEmployerRatePercent === null) {
      rate = 0;
      issues.push({ severity: 'error', code: 'employer_incomplete', params: { state, field: 'suiRate' } });
    } else {
      rate = rules.newEmployerRatePercent;
      issues.push({ severity: 'warning', code: 'employer_incomplete', params: { state, field: 'suiRate', fallbackRatePercent: rate } });
    }
  }
  const employerCents = percentOf(taxable, rate);

  let employeeCents = 0;
  if (rules.employee) {
    const base = rules.employee.wageBaseCents;
    const sameBase = base === rules.wageBaseCents;
    const employeeTaxable = sameBase ? taxable : underBase(gross, readYtd(input, state, 'sui_employee_wages'), base);
    employeeCents = percentOf(employeeTaxable, rules.employee.ratePercent);
    if (!sameBase) ytd.add('sui_employee_wages', employeeTaxable);
  }

  const programs: StateProgramResult[] = [];
  for (const s of rules.surcharges ?? []) {
    const r = input.extraRates[s.rateKey] ?? s.defaultRatePercent;
    programs.push({ code: s.code, labelKey: s.labelKey, wagesCents: taxable, employeeCents: 0, employerCents: percentOf(taxable, r) });
  }

  ytd.add('sui_wages', taxable);
  ytd.add('sui_gross_wages', gross);
  return { sui: { taxableWagesCents: taxable, grossWagesCents: gross, employerCents, employeeCents }, programs, issues };
}

// ---------------------------------------------------------------------------
// Payroll programs (SDI, PFML, FLI, …)
// ---------------------------------------------------------------------------

export interface ProgramSpec {
  code: string;
  labelKey: string;
  /** Wages subject to the program this period, before the cap. */
  wagesCents: Cents;
  /** Annual wage cap; null = no cap. YTD key `<code>_wages` tracks it. */
  wageBaseCents: Cents | null;
  employeeRatePercent: number;
  employerRatePercent: number;
  /** Annual cap on the employee contribution (NY PFL); YTD key `<code>_employee`. */
  employeeAnnualMaxCents?: Cents;
  /** Cap on the employee contribution for this period (NY DBL $0.60 a week). */
  employeePeriodMaxCents?: Cents;
}

export function computeProgram(input: StateCalcInput, state: string, spec: ProgramSpec, ytd: YtdWriter): StateProgramResult {
  const wages = underBase(spec.wagesCents, readYtd(input, state, `${spec.code}_wages`), spec.wageBaseCents);
  let employee = percentOf(wages, spec.employeeRatePercent);
  if (spec.employeePeriodMaxCents !== undefined) employee = Math.min(employee, spec.employeePeriodMaxCents);
  if (spec.employeeAnnualMaxCents !== undefined) {
    const before = readYtd(input, state, `${spec.code}_employee`);
    employee = Math.max(0, Math.min(employee, spec.employeeAnnualMaxCents - before));
    ytd.add(`${spec.code}_employee`, employee);
  }
  const employer = percentOf(wages, spec.employerRatePercent);
  ytd.add(`${spec.code}_wages`, wages);
  return { code: spec.code, labelKey: spec.labelKey, wagesCents: wages, employeeCents: employee, employerCents: employer };
}

export interface SharedProgramSpec {
  code: string;
  labelKey: string;
  wagesCents: Cents;
  wageBaseCents: Cents | null;
  /** Total premium rate (percent). */
  totalRatePercent: number;
  /** The most the employer may deduct from the employee (percent). */
  employeeMaxRatePercent: number;
  /** What the employer actually deducts (percent); defaults to the maximum. */
  employeeRatePercent?: number;
  /** False for small employers that owe only the employee share. */
  employerOwesShare: boolean;
}

/**
 * A premium split between employee and employer where the employer remits the
 * total and its own cost is whatever it did not deduct (WA PFML, MA PFML, CO
 * FAMLI): total due = total rate (or only the employee share for small
 * employers); employer = total due − employee deduction.
 */
export function computeSharedProgram(input: StateCalcInput, state: string, spec: SharedProgramSpec, ytd: YtdWriter): StateProgramResult {
  const wages = underBase(spec.wagesCents, readYtd(input, state, `${spec.code}_wages`), spec.wageBaseCents);
  const employeeMax = percentOf(wages, spec.employeeMaxRatePercent);
  const due = spec.employerOwesShare ? percentOf(wages, spec.totalRatePercent) : employeeMax;
  const rate = Math.max(0, Math.min(spec.employeeRatePercent ?? spec.employeeMaxRatePercent, spec.employeeMaxRatePercent));
  const employee = Math.min(percentOf(wages, rate), employeeMax);
  ytd.add(`${spec.code}_wages`, wages);
  return { code: spec.code, labelKey: spec.labelKey, wagesCents: wages, employeeCents: employee, employerCents: Math.max(0, due - employee) };
}

/** An `employerRateCodes` entry; its label is STATE_EMPLOYER_RATE_LABELS[`employer_rate.<code>`]. */
export function rateCode(code: string, defaultPercent?: number): { code: string; labelKey: string; defaultPercent?: number } {
  return defaultPercent === undefined ? { code, labelKey: `employer_rate.${code}` } : { code, labelKey: `employer_rate.${code}`, defaultPercent };
}

// ---------------------------------------------------------------------------
// Issues and results
// ---------------------------------------------------------------------------

/** v1 withholds for the work state only; say so when the employee lives elsewhere. */
export function residenceIssue(input: StateCalcInput, state: string): PayrollIssue[] {
  const residence = input.residenceState?.toUpperCase() ?? null;
  if (!residence || residence === state) return [];
  return [{ severity: 'warning', code: 'residence_state_differs', params: { state, residenceState: residence } }];
}

export function provisionalIssue(state: string, items: readonly string[]): PayrollIssue[] {
  if (items.length === 0) return [];
  return [{ severity: 'warning', code: 'provisional_rules', params: { state, items: items.join(', ') } }];
}

/** Result for a tax year the module has no rules for: an error, never a guess. */
export function unsupportedYearResult(input: StateCalcInput, state: string): StateCalcResult {
  return {
    stateWagesCents: 0,
    incomeTaxCents: 0,
    sui: { taxableWagesCents: 0, grossWagesCents: 0, employerCents: 0, employeeCents: 0 },
    programs: [],
    ytdUpdates: {},
    issues: [{ severity: 'error', code: 'unsupported_tax_year', params: { year: input.taxYear, state } }],
    ruleSet: `us-${state.toLowerCase()}-none`,
  };
}

/** Result for a pay frequency the state's tables do not cover. */
export function unsupportedFrequencyResult(input: StateCalcInput, state: string, ruleSet: string): StateCalcResult {
  return {
    stateWagesCents: 0,
    incomeTaxCents: 0,
    sui: { taxableWagesCents: 0, grossWagesCents: 0, employerCents: 0, employeeCents: 0 },
    programs: [],
    ytdUpdates: {},
    issues: [{ severity: 'error', code: 'unsupported_frequency', params: { periodsPerYear: input.periodsPerYear, state } }],
    ruleSet,
  };
}

/** Records state income tax wages and tax in the accumulators. */
export function recordIncomeTax(ytd: YtdWriter, stateWagesCents: Cents, incomeTaxCents: Cents): void {
  ytd.add('wages', stateWagesCents);
  ytd.add('tax', incomeTaxCents);
}
