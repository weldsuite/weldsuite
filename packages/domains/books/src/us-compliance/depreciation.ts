/**
 * Fixed asset depreciation for the book, federal and state depreciation books.
 *
 * Book methods: straight line (with salvage value) and declining balance
 * (150% or 200%, switching to straight line), with a full-month, mid-month or
 * half-year convention. Tax methods: MACRS GDS (Publication 946 percentage
 * tables, 200% or 150% declining balance, or straight line for 25, 27.5 and
 * 39-year property), MACRS ADS (straight line), section 179 expensing, bonus
 * depreciation and the de minimis safe harbor. The tables and the yearly
 * figures are in depreciation-tables.ts.
 *
 * Time model. A fiscal period is the caller's own year (calendar, 52-53 week,
 * any 12 months) and counts as 12 "months" on an axis. An asset is in service
 * from the point its convention puts it (the middle of the year for half-year,
 * the middle of its quarter for mid-quarter, the middle of its month for
 * mid-month, the start of its month for full-month) for its life, and
 * depreciation is the part of that interval inside each year. That gives the
 * half-year, mid-quarter and mid-month first and last years of the tables, and
 * the same fractions in the year of disposal: half a year for half-year, 12.5%,
 * 37.5%, 62.5% or 87.5% for the quarter of a mid-quarter disposal, and
 * (month - 0.5) / 12 for mid-month. Under full-month there is no depreciation
 * in the month of disposal. Property placed in service and disposed of in the
 * same year gets none, which is the MACRS rule.
 *
 * Not modelled: short tax years, section 280F passenger car caps, section
 * 168(n) qualified production property, 31.5-year real property, and the
 * business income limit on section 179 beyond `section179Allowance`.
 */

import { diffDays, endOfMonth, isIsoDate, parseIso, addMonths, addDays } from './dates';
import {
  MACRS_HALF_YEAR,
  MACRS_MID_QUARTER,
  MACRS_TABLE_CLASSES,
  bonusEligible,
  macrsRealPropertyPercentages,
  section179Parameters,
  type MacrsTableClass,
} from './depreciation-tables';

export type DepreciationMethod = 'straight_line' | 'declining_balance' | 'macrs_gds' | 'macrs_ads' | 'expensed' | 'none';
export type DepreciationConvention = 'half_year' | 'mid_quarter' | 'mid_month' | 'full_month';

export interface FiscalPeriod {
  label: string;
  /** First day, `YYYY-MM-DD`. */
  start: string;
  /** Last day, inclusive. */
  end: string;
}

export interface DepreciationAsset {
  cost: number;
  /** Book value at the end of the life; book methods only. */
  salvageValue?: number;
  /** Share of business use, 0 to 100. Default 100. */
  businessUsePercent?: number;
  /** When it was acquired (a written binding contract); decides the bonus percentage, see `bonusDepreciationPercent`. */
  acquisitionDate: string;
  placedInServiceDate: string;
  disposalDate?: string | null;
  /** Listed property (vehicles and the like) used 50% or less for business must use ADS. */
  listedProperty?: boolean;
}

export interface DepreciationBook {
  method: DepreciationMethod;
  convention: DepreciationConvention;
  /** MACRS class (3, 5, 7, 10, 15, 20, 25, 27.5 or 39), the ADS life, or the useful life for a book method. */
  recoveryYears: number;
  section179Amount?: number;
  /** Percent, 0 to 100. */
  bonusPercent?: number;
  /** `declining_balance`: 2 (200%, default) or 1.5. */
  decliningBalanceFactor?: 1.5 | 2;
  /** `macrs_gds`: straight line instead of declining balance (the election, and qualified improvement property). */
  straightLine?: boolean;
  /** The ADS life to use when listed property forces ADS on a GDS book. */
  adsRecoveryYears?: number;
}

export type DepreciationIssueCode =
  | 'invalid_amount'
  | 'invalid_dates'
  | 'invalid_periods'
  | 'placed_in_service_outside_periods'
  | 'disposal_before_service'
  | 'periods_end_before_fully_depreciated'
  | 'unsupported_recovery_period'
  | 'convention_changed'
  | 'ads_required'
  | 'ads_life_assumed'
  | 'section_179_not_allowed'
  | 'section_179_reduced'
  | 'bonus_not_allowed'
  | 'monthly_requires_month_periods';

export interface DepreciationIssue {
  severity: 'error' | 'warning';
  code: DepreciationIssueCode;
  message: string;
}

export interface DepreciationBasis {
  cost: number;
  businessUsePercent: number;
  /** Cost times business use. */
  baseCost: number;
  /** Book methods only. */
  salvage: number;
  section179: number;
  bonus: number;
  /** What the method spreads over the years: base cost less salvage (book), or less section 179 and bonus (tax). */
  depreciableBasis: number;
  /** Everything deducted over the life: section 179, bonus and the yearly amounts. */
  totalDepreciable: number;
}

export interface DepreciationRow {
  label: string;
  periodStart: string;
  periodEnd: string;
  /** Everything deducted in the period. */
  amount: number;
  /** The yearly (or monthly) amount without section 179 and bonus. */
  regular: number;
  section179: number;
  bonus: number;
  accumulated: number;
  /** What is still to be deducted over the life. */
  remaining: number;
}

export interface DepreciationSchedule {
  /** What was used after the rules (listed property below 50% turns GDS into ADS, etc.). */
  method: DepreciationMethod;
  convention: DepreciationConvention;
  recoveryYears: number;
  basis: DepreciationBasis;
  rows: DepreciationRow[];
  issues: DepreciationIssue[];
}

// ---------------------------------------------------------------------------
// Periods

/** Calendar years `firstYear` to `firstYear + count - 1`. */
export function calendarFiscalYears(firstYear: number, count: number): FiscalPeriod[] {
  return Array.from({ length: count }, (_, i) => ({
    label: String(firstYear + i),
    start: `${firstYear + i}-01-01`,
    end: `${firstYear + i}-12-31`,
  }));
}

/** Consecutive 12-month fiscal years from the first day of a month (a fiscal year of April to March, say). Labelled by the year they end in. */
export function fiscalYearsFrom(firstStart: string, count: number): FiscalPeriod[] {
  const first = parseIso(firstStart);
  if (first.d !== 1) throw new RangeError('A fiscal year starts on the first of a month');
  return Array.from({ length: count }, (_, i) => {
    const start = addMonths(firstStart, 12 * i);
    const end = addDays(addMonths(start, 12), -1);
    return { label: `FY${parseIso(end).y}`, start, end };
  });
}

function monthAligned(period: FiscalPeriod): boolean {
  const start = parseIso(period.start);
  const end = parseIso(period.end);
  if (start.d !== 1 || period.end !== endOfMonth(period.end)) return false;
  return end.y * 12 + end.m - (start.y * 12 + start.m) + 1 === 12;
}

interface Position {
  index: number;
  /** 0 to 11 within the year. */
  month: number;
  /** 1 to 4. */
  quarter: number;
}

class Axis {
  readonly aligned: boolean[];

  constructor(readonly periods: readonly FiscalPeriod[]) {
    this.aligned = periods.map(monthAligned);
  }

  get allAligned(): boolean {
    return this.aligned.every(Boolean);
  }

  valid(): boolean {
    for (let i = 0; i < this.periods.length; i++) {
      const p = this.periods[i] as FiscalPeriod;
      if (!isIsoDate(p.start) || !isIsoDate(p.end) || p.end < p.start) return false;
      const previous = this.periods[i - 1];
      if (previous && p.start <= previous.end) return false;
    }
    return this.periods.length > 0;
  }

  locate(date: string): Position | null {
    const index = this.periods.findIndex((p) => date >= p.start && date <= p.end);
    if (index < 0) return null;
    const period = this.periods[index] as FiscalPeriod;
    let month: number;
    if (this.aligned[index]) {
      const s = parseIso(period.start);
      const d = parseIso(date);
      month = d.y * 12 + d.m - (s.y * 12 + s.m);
    } else {
      const total = diffDays(period.start, period.end) + 1;
      month = Math.min(11, Math.floor(((diffDays(period.start, date)) / total) * 12));
    }
    return { index, month, quarter: Math.floor(month / 3) + 1 };
  }
}

/** The point on the axis (in months) where a convention counts an event in `position` from. */
function anchor(convention: DepreciationConvention, position: Position): number {
  const base = 12 * position.index;
  switch (convention) {
    case 'half_year':
      return base + 6;
    case 'mid_quarter':
      return base + 3 * (position.quarter - 1) + 1.5;
    case 'mid_month':
      return base + position.month + 0.5;
    case 'full_month':
      return base + position.month;
  }
}

function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function round2(value: number): number {
  return Math.round(value * 100 + (value >= 0 ? 1e-9 : -1e-9)) / 100;
}

// ---------------------------------------------------------------------------
// Rules

const REAL_PROPERTY_GDS = new Set([27.5, 39]);
const REAL_PROPERTY_ADS = new Set([27.5, 30, 31.5, 39, 40]);

/** ADS lives of residential rental (30 years) and nonresidential real property (40 years), by GDS class. */
export const ADS_LIFE_OF_REAL_PROPERTY: Readonly<Record<27.5 | 39, number>> = { 27.5: 30, 39: 40 };

/** Listed property used 50% or less for business has to use ADS, and gets no section 179 or bonus. */
export function requiresAds(asset: Pick<DepreciationAsset, 'listedProperty' | 'businessUsePercent'>): boolean {
  return Boolean(asset.listedProperty) && (asset.businessUsePercent ?? 100) <= 50;
}

interface Effective {
  method: DepreciationMethod;
  convention: DepreciationConvention;
  recoveryYears: number;
  section179: number;
  bonusPercent: number;
  factor: 1.5 | 2;
  straightLine: boolean;
}

function resolveBook(asset: DepreciationAsset, book: DepreciationBook, issues: DepreciationIssue[]): Effective {
  const warn = (code: DepreciationIssueCode, message: string): void => {
    issues.push({ severity: 'warning', code, message });
  };
  let method = book.method;
  let recoveryYears = book.recoveryYears;
  let section179 = book.section179Amount ?? 0;
  let bonusPercent = book.bonusPercent ?? 0;
  let convention = book.convention;
  const businessUse = asset.businessUsePercent ?? 100;

  const isMacrs = method === 'macrs_gds' || method === 'macrs_ads';
  if (isMacrs && requiresAds(asset)) {
    if (method === 'macrs_gds') {
      method = 'macrs_ads';
      if (book.adsRecoveryYears !== undefined) recoveryYears = book.adsRecoveryYears;
      else warn('ads_life_assumed', 'Listed property used 50% or less for business must use ADS; no ADS life was given, so the GDS class is used');
      warn('ads_required', 'Listed property used 50% or less for business must use ADS');
    }
    if (section179 > 0) {
      warn('section_179_not_allowed', 'Section 179 is not allowed on property used 50% or less for business');
      section179 = 0;
    }
    if (bonusPercent > 0) {
      warn('bonus_not_allowed', 'Bonus depreciation is not allowed on property that must use ADS');
      bonusPercent = 0;
    }
  } else if (isMacrs && section179 > 0 && businessUse <= 50) {
    warn('section_179_not_allowed', 'Section 179 needs more than 50% business use');
    section179 = 0;
  }
  if (!isMacrs) {
    if (section179 > 0) warn('section_179_not_allowed', 'Section 179 and bonus depreciation only apply to MACRS books');
    if (bonusPercent > 0) warn('bonus_not_allowed', 'Section 179 and bonus depreciation only apply to MACRS books');
    section179 = 0;
    bonusPercent = 0;
  } else if (method === 'macrs_gds' && bonusPercent > 0 && !bonusEligible(recoveryYears)) {
    warn('bonus_not_allowed', `Property with a ${recoveryYears}-year recovery period does not qualify for bonus depreciation`);
    bonusPercent = 0;
  }

  if (method === 'macrs_gds') {
    const real = REAL_PROPERTY_GDS.has(recoveryYears);
    const wanted: DepreciationConvention = real ? 'mid_month' : convention === 'mid_quarter' ? 'mid_quarter' : 'half_year';
    if (convention !== wanted) {
      warn('convention_changed', `${recoveryYears}-year MACRS property uses the ${wanted.replace('_', '-')} convention`);
      convention = wanted;
    }
  } else if (method === 'macrs_ads') {
    const real = REAL_PROPERTY_ADS.has(recoveryYears);
    const wanted: DepreciationConvention = real ? 'mid_month' : convention === 'mid_quarter' ? 'mid_quarter' : 'half_year';
    if (convention !== wanted) {
      warn('convention_changed', `ADS ${recoveryYears}-year property uses the ${wanted.replace('_', '-')} convention`);
      convention = wanted;
    }
  }

  return {
    method,
    convention,
    recoveryYears,
    section179,
    bonusPercent,
    factor: book.decliningBalanceFactor ?? 2,
    straightLine: Boolean(book.straightLine),
  };
}

/**
 * What is spread over the years and what is deducted at once. For a tax
 * (MACRS) book: cost times business use, less section 179 (limited to the base
 * cost) and bonus (a percentage of what is left). For a book method: cost times
 * business use, less salvage.
 */
export function depreciationBasis(asset: DepreciationAsset, book: DepreciationBook): DepreciationBasis {
  return basisOf(asset, resolveBook(asset, book, []), book);
}

function basisOf(asset: DepreciationAsset, effective: Effective, book: DepreciationBook): DepreciationBasis {
  const businessUsePercent = asset.businessUsePercent ?? 100;
  const baseCost = round2((asset.cost * businessUsePercent) / 100);
  const tax = effective.method === 'macrs_gds' || effective.method === 'macrs_ads';
  if (!tax) {
    const salvage = book.method === 'straight_line' || book.method === 'declining_balance' ? Math.min(baseCost, round2(asset.salvageValue ?? 0)) : 0;
    const depreciableBasis = round2(baseCost - salvage);
    return { cost: asset.cost, businessUsePercent, baseCost, salvage, section179: 0, bonus: 0, depreciableBasis, totalDepreciable: depreciableBasis };
  }
  const section179 = round2(Math.min(effective.section179, baseCost));
  const bonus = round2(((baseCost - section179) * effective.bonusPercent) / 100);
  const depreciableBasis = round2(baseCost - section179 - bonus);
  return { cost: asset.cost, businessUsePercent, baseCost, salvage: 0, section179, bonus, depreciableBasis, totalDepreciable: baseCost };
}

// ---------------------------------------------------------------------------
// The engine

interface Plan {
  axis: Axis;
  effective: Effective;
  basis: DepreciationBasis;
  pis: Position;
  /** Start and end of service on the axis, in months. */
  start: number;
  lifeEnd: number;
  /** Where service stops: the earlier of the end of life and the disposal point. */
  end: number;
  disposalIndex: number | null;
  disposalPoint: number | null;
}

function tablePercentages(effective: Effective, pis: Position): readonly number[] | null {
  if (effective.method !== 'macrs_gds' || effective.straightLine) return null;
  const years = effective.recoveryYears;
  if (years === 27.5 || years === 39) return macrsRealPropertyPercentages(years, pis.month + 1);
  if (!(MACRS_TABLE_CLASSES as readonly number[]).includes(years)) return null;
  const cls = years as MacrsTableClass;
  return effective.convention === 'mid_quarter'
    ? (MACRS_MID_QUARTER[pis.quarter as 1 | 2 | 3 | 4] as Record<MacrsTableClass, readonly number[]>)[cls]
    : MACRS_HALF_YEAR[cls];
}

const GDS_SUPPORTED = new Set<number>([3, 5, 7, 10, 15, 20, 25, 27.5, 39]);

function makePlan(
  asset: DepreciationAsset,
  book: DepreciationBook,
  periods: readonly FiscalPeriod[],
  issues: DepreciationIssue[],
): Plan | null {
  const error = (code: DepreciationIssueCode, message: string): null => {
    issues.push({ severity: 'error', code, message });
    return null;
  };
  if (!Number.isFinite(asset.cost) || asset.cost <= 0) return error('invalid_amount', 'The cost must be greater than zero');
  const businessUse = asset.businessUsePercent ?? 100;
  if (!Number.isFinite(businessUse) || businessUse < 0 || businessUse > 100) return error('invalid_amount', 'Business use is 0 to 100 percent');
  if ((asset.salvageValue ?? 0) < 0) return error('invalid_amount', 'Salvage value cannot be negative');
  if (!isIsoDate(asset.placedInServiceDate) || !isIsoDate(asset.acquisitionDate) || (asset.disposalDate != null && !isIsoDate(asset.disposalDate))) {
    return error('invalid_dates', 'Dates must be YYYY-MM-DD');
  }
  const axis = new Axis(periods);
  if (!axis.valid()) return error('invalid_periods', 'Fiscal periods must be valid, in order and not overlap');
  const needsLife = book.method !== 'expensed' && book.method !== 'none';
  if (needsLife && !(book.recoveryYears > 0)) return error('unsupported_recovery_period', 'The recovery period must be greater than zero');

  const effective = resolveBook(asset, book, issues);
  if (effective.method === 'macrs_gds' && !GDS_SUPPORTED.has(effective.recoveryYears)) {
    return error('unsupported_recovery_period', `${effective.recoveryYears}-year property has no GDS table here`);
  }

  const pis = axis.locate(asset.placedInServiceDate);
  if (!pis) return error('placed_in_service_outside_periods', 'The fiscal periods do not include the placed-in-service date');
  if (effective.section179 > 0) {
    const limit = section179Parameters(parseIso((periods[pis.index] as FiscalPeriod).start).y)?.limit;
    if (limit !== undefined && effective.section179 > limit) {
      issues.push({ severity: 'warning', code: 'section_179_reduced', message: `Section 179 is limited to ${limit.toLocaleString('en-US')} for the year` });
      effective.section179 = limit;
    }
  }
  const basis = basisOf(asset, effective, book);
  const start = anchor(effective.convention, pis);
  const lifeEnd = start + 12 * (needsLife ? effective.recoveryYears : 0);

  let disposalIndex: number | null = null;
  let disposalPoint: number | null = null;
  if (asset.disposalDate) {
    if (asset.disposalDate < asset.placedInServiceDate) return error('disposal_before_service', 'The asset was disposed of before it was placed in service');
    // A disposal after the last period leaves nothing to stop within the periods given.
    const at = axis.locate(asset.disposalDate);
    if (at) {
      disposalIndex = at.index;
      disposalPoint = anchor(effective.convention, at);
    }
  }
  const end = disposalPoint === null ? lifeEnd : Math.min(lifeEnd, disposalPoint);
  return { axis, effective, basis, pis, start, lifeEnd, end, disposalIndex, disposalPoint };
}

/** Exact (unrounded) regular depreciation per fiscal period, indexed like the periods. */
function exactAmounts(plan: Plan, salvageForDb: number): number[] {
  const { axis, effective, basis, pis, start, lifeEnd, end } = plan;
  const count = axis.periods.length;
  const amounts = new Array<number>(count).fill(0);
  const life = effective.recoveryYears;

  if (effective.method === 'none') return amounts;
  if (effective.method === 'expensed') {
    amounts[pis.index] = basis.depreciableBasis;
    return amounts;
  }

  const table = tablePercentages(effective, pis);
  if (table) {
    for (let i = pis.index; i < count; i++) {
      const percent = table[i - pis.index] ?? 0;
      let exact = (basis.depreciableBasis * percent) / 100;
      if (plan.disposalIndex !== null && plan.disposalPoint !== null) {
        if (i > plan.disposalIndex) exact = 0;
        // The year of disposal gets the convention's share; a year that is also the year placed in service gets none.
        else if (i === plan.disposalIndex) exact = i === pis.index ? 0 : (exact * (plan.disposalPoint - 12 * i)) / 12;
      }
      amounts[i] = exact;
    }
    return amounts;
  }

  if (effective.method === 'declining_balance') {
    const rate = effective.factor / life;
    let accumulated = 0;
    for (let i = pis.index; i < count; i++) {
      const weight = overlap(12 * i, 12 * i + 12, start, end);
      if (weight === 0) {
        if (12 * i > end) break;
        continue;
      }
      const nbv = basis.baseCost - accumulated;
      const remainingYears = (lifeEnd - Math.max(start, 12 * i)) / 12;
      const db = nbv * rate * (weight / 12);
      const sl = ((nbv - salvageForDb) / remainingYears) * (weight / 12);
      const amount = Math.min(Math.max(db, sl), nbv - salvageForDb);
      amounts[i] = Math.max(0, amount);
      accumulated += amounts[i] as number;
    }
    return amounts;
  }

  // Straight line: book, ADS, and GDS straight line (the election, 25-year water utility property).
  const perMonth = basis.depreciableBasis / (12 * life);
  for (let i = pis.index; i < count; i++) {
    amounts[i] = perMonth * overlap(12 * i, 12 * i + 12, start, end);
  }
  return amounts;
}

interface Core {
  plan: Plan;
  /** Exact regular amounts per period. */
  exact: number[];
  issues: DepreciationIssue[];
}

function core(asset: DepreciationAsset, book: DepreciationBook, periods: readonly FiscalPeriod[]): Core | { issues: DepreciationIssue[] } {
  const issues: DepreciationIssue[] = [];
  const plan = makePlan(asset, book, periods, issues);
  if (!plan) return { issues };
  const exact = exactAmounts(plan, plan.basis.salvage);
  return { plan, exact, issues };
}

function defaultPeriods(asset: DepreciationAsset, book: DepreciationBook): FiscalPeriod[] {
  const year = isIsoDate(asset.placedInServiceDate) ? parseIso(asset.placedInServiceDate).y : new Date().getUTCFullYear();
  return calendarFiscalYears(year, Math.ceil(book.recoveryYears || 1) + 3);
}

/**
 * The deduction per fiscal period over the asset's life. `periods` are the
 * caller's own fiscal years (calendar, 52-53 week or any other), ordered and
 * starting at or before the placed-in-service date; without them calendar years
 * from the placed-in-service year are used. Section 179 and bonus are in the
 * first row. The last row closes the schedule exactly to the cent.
 */
export function depreciationSchedule(
  asset: DepreciationAsset,
  book: DepreciationBook,
  periods: readonly FiscalPeriod[] = defaultPeriods(asset, book),
): DepreciationSchedule {
  const built = core(asset, book, periods);
  const fallbackBasis = (): DepreciationBasis => {
    const baseCost = round2((asset.cost * (asset.businessUsePercent ?? 100)) / 100);
    return { cost: asset.cost, businessUsePercent: asset.businessUsePercent ?? 100, baseCost, salvage: 0, section179: 0, bonus: 0, depreciableBasis: 0, totalDepreciable: 0 };
  };
  if (!('plan' in built)) {
    return { method: book.method, convention: book.convention, recoveryYears: book.recoveryYears, basis: fallbackBasis(), rows: [], issues: built.issues };
  }
  const { plan, exact, issues } = built;
  const { basis, pis, effective } = plan;
  const periodsList = plan.axis.periods;

  let last = pis.index;
  for (let i = 0; i < exact.length; i++) if ((exact[i] as number) > 1e-9) last = Math.max(last, i);

  // The whole life fits in the periods given and nothing cut it short.
  const complete = plan.disposalIndex === null && plan.lifeEnd <= 12 * periodsList.length + 1e-9;
  const rows: DepreciationRow[] = [];
  let cumulativeExact = 0;
  let accumulated = 0;
  for (let i = pis.index; i <= last; i++) {
    const first = i === pis.index;
    const section179 = first ? basis.section179 : 0;
    const bonus = first ? basis.bonus : 0;
    cumulativeExact += (exact[i] as number) + section179 + bonus;
    const reachedEnd = i === last && complete && effective.method !== 'none';
    const cumulative = round2(reachedEnd ? basis.totalDepreciable : cumulativeExact);
    const amount = round2(cumulative - accumulated);
    accumulated = round2(accumulated + amount);
    const period = periodsList[i] as FiscalPeriod;
    rows.push({
      label: period.label,
      periodStart: period.start,
      periodEnd: period.end,
      amount,
      regular: round2(amount - section179 - bonus),
      section179,
      bonus,
      accumulated,
      remaining: round2(basis.totalDepreciable - accumulated),
    });
  }

  if (effective.method === 'none') rows.length = 0;
  if (effective.method !== 'none' && plan.disposalIndex === null && !complete) {
    issues.push({ severity: 'warning', code: 'periods_end_before_fully_depreciated', message: 'The fiscal periods end before the asset is fully depreciated; add more years' });
  }

  return { method: effective.method, convention: effective.convention, recoveryYears: effective.recoveryYears, basis, rows, issues };
}

export interface MonthlyDepreciationRow {
  /** `YYYY-MM`. */
  label: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  accumulated: number;
  remaining: number;
}

export interface MonthlySchedule {
  method: DepreciationMethod;
  convention: DepreciationConvention;
  basis: DepreciationBasis;
  rows: MonthlyDepreciationRow[];
  issues: DepreciationIssue[];
}

/**
 * The same depreciation by calendar month, for the book that posts to the
 * ledger every month. Each year's amount is spread over the months the asset is
 * in service that year (the first and last month count half under mid-month);
 * section 179 and bonus, which a book never has, go to the first month. The
 * fiscal periods must be whole months (calendar years, April-March years, ...);
 * a 52-53 week year has no calendar months and gets an issue instead.
 */
export function monthlySchedule(
  asset: DepreciationAsset,
  book: DepreciationBook,
  periods: readonly FiscalPeriod[] = defaultPeriods(asset, book),
): MonthlySchedule {
  const empty = (issues: DepreciationIssue[]): MonthlySchedule => ({
    method: book.method,
    convention: book.convention,
    basis: depreciationBasis(asset, book),
    rows: [],
    issues,
  });
  const axis = new Axis(periods);
  if (axis.valid() && !axis.allAligned) {
    return empty([{ severity: 'error', code: 'monthly_requires_month_periods', message: 'Monthly depreciation needs fiscal years made of whole calendar months' }]);
  }
  const built = core(asset, book, periods);
  if (!('plan' in built)) return empty(built.issues);
  const { plan, exact, issues } = built;
  const { basis, pis } = plan;

  const months: Array<{ period: FiscalPeriod; month: number; exact: number }> = [];
  for (let i = pis.index; i < exact.length; i++) {
    const period = plan.axis.periods[i] as FiscalPeriod;
    const weights = Array.from({ length: 12 }, (_, j) => overlap(12 * i + j, 12 * i + j + 1, plan.start, plan.end));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const yearAmount = exact[i] as number;
    for (let j = 0; j < 12; j++) {
      let amount = 0;
      if (total > 0) amount = (yearAmount * (weights[j] as number)) / total;
      else if (i === pis.index && j === pis.month) amount = yearAmount;
      if (i === pis.index && j === pis.month) amount += basis.section179 + basis.bonus;
      months.push({ period, month: j, exact: amount });
    }
  }
  let firstNonZero = months.findIndex((m) => m.exact > 1e-9);
  let lastNonZero = -1;
  months.forEach((m, index) => {
    if (m.exact > 1e-9) lastNonZero = index;
  });
  if (firstNonZero < 0) firstNonZero = 0;

  const complete = plan.disposalIndex === null && plan.lifeEnd <= 12 * plan.axis.periods.length + 1e-9;
  const rows: MonthlyDepreciationRow[] = [];
  let cumulativeExact = 0;
  let accumulated = 0;
  for (let index = 0; index <= lastNonZero; index++) {
    const entry = months[index] as { period: FiscalPeriod; month: number; exact: number };
    cumulativeExact += entry.exact;
    if (index < firstNonZero) continue;
    const reachedEnd = index === lastNonZero && complete && plan.effective.method !== 'none';
    const cumulative = round2(reachedEnd ? basis.totalDepreciable : cumulativeExact);
    const amount = round2(cumulative - accumulated);
    accumulated = round2(accumulated + amount);
    const start = addMonths(entry.period.start, entry.month);
    rows.push({
      label: start.slice(0, 7),
      periodStart: start,
      periodEnd: endOfMonth(start),
      amount,
      accumulated,
      remaining: round2(basis.totalDepreciable - accumulated),
    });
  }
  if (plan.effective.method === 'none') rows.length = 0;
  return { method: plan.effective.method, convention: plan.effective.convention, basis, rows, issues };
}

/**
 * The share of a year's depreciation allowed in the year of disposal: 50% for
 * half-year, 12.5/37.5/62.5/87.5% for the quarter of a mid-quarter disposal,
 * (month - 0.5) / 12 for mid-month and the months before the disposal month for
 * full-month. Zero when the asset is placed in service and disposed of in the
 * same year (MACRS).
 */
export function disposalYearFraction(
  convention: DepreciationConvention,
  disposalDate: string,
  period: FiscalPeriod,
  placedInServiceDate?: string,
): number {
  if (placedInServiceDate && placedInServiceDate >= period.start && placedInServiceDate <= period.end) return 0;
  const axis = new Axis([period]);
  const position = axis.locate(disposalDate);
  if (!position) throw new RangeError('The disposal date is not in the fiscal period');
  return anchor(convention, position) / 12;
}

// ---------------------------------------------------------------------------
// Mid-quarter test

export interface MidQuarterTestAsset {
  id: string;
  placedInServiceDate: string;
  /** Depreciable basis for the test: cost times business use, less section 179. Bonus depreciation does not reduce it. */
  basis: number;
  /** Real property (27.5 and 39-year) is left out of the test. */
  realProperty?: boolean;
  /** Placed in service and disposed of in the same year: left out. */
  disposedInSameYear?: boolean;
}

export interface MidQuarterTestResult {
  /** More than 40% of the year's basis was placed in service in the last quarter. */
  applies: boolean;
  totalBasis: number;
  lastQuarterBasis: number;
  /** 0 to 1. */
  lastQuarterShare: number;
  /** Basis placed in service in each quarter of the year. */
  quarterBasis: [number, number, number, number];
}

/** The basis the mid-quarter test counts for an asset: cost times business use, less section 179. */
export function midQuarterTestBasis(cost: number, businessUsePercent: number, section179: number): number {
  return round2(Math.max(0, (cost * businessUsePercent) / 100 - section179));
}

/**
 * The mid-quarter test for one fiscal year: when more than 40% of the
 * depreciable basis of the property (real property and anything placed in
 * service and disposed of in the same year left out) was placed in service in
 * the last three months, the mid-quarter convention applies to all of it.
 */
export function midQuarterTest(assets: readonly MidQuarterTestAsset[], period: FiscalPeriod): MidQuarterTestResult {
  const axis = new Axis([period]);
  const cents: [number, number, number, number] = [0, 0, 0, 0];
  for (const asset of assets) {
    if (asset.realProperty || asset.disposedInSameYear) continue;
    const position = axis.locate(asset.placedInServiceDate);
    if (!position) continue;
    cents[position.quarter - 1] = (cents[position.quarter - 1] as number) + Math.round(asset.basis * 100);
  }
  const total = cents[0] + cents[1] + cents[2] + cents[3];
  const last = cents[3];
  return {
    applies: total > 0 && last * 10 > total * 4,
    totalBasis: total / 100,
    lastQuarterBasis: last / 100,
    lastQuarterShare: total > 0 ? last / total : 0,
    quarterBasis: [cents[0] / 100, cents[1] / 100, cents[2] / 100, cents[3] / 100],
  };
}

export interface ConventionAsset {
  id: string;
  placedInServiceDate: string;
  basis: number;
  realProperty?: boolean;
  disposalDate?: string | null;
}

/**
 * The MACRS convention of each asset: real property mid-month; personal property
 * mid-quarter in a year that fails the mid-quarter test, half-year otherwise.
 * Assets placed in service outside `periods` are left out of the result.
 */
export function macrsConventions(
  assets: readonly ConventionAsset[],
  periods: readonly FiscalPeriod[],
): Record<string, 'half_year' | 'mid_quarter' | 'mid_month'> {
  const result: Record<string, 'half_year' | 'mid_quarter' | 'mid_month'> = {};
  const axis = new Axis(periods);
  const verdict = periods.map((period) =>
    midQuarterTest(
      assets.map((asset) => ({
        id: asset.id,
        placedInServiceDate: asset.placedInServiceDate,
        basis: asset.basis,
        realProperty: asset.realProperty ?? false,
        disposedInSameYear: Boolean(asset.disposalDate && asset.disposalDate >= period.start && asset.disposalDate <= period.end),
      })),
      period,
    ).applies,
  );
  for (const asset of assets) {
    const position = axis.locate(asset.placedInServiceDate);
    if (!position) continue;
    result[asset.id] = asset.realProperty ? 'mid_month' : verdict[position.index] ? 'mid_quarter' : 'half_year';
  }
  return result;
}

// ---------------------------------------------------------------------------
// Disposal

export interface DisposalGain {
  /** Cost less accumulated depreciation. */
  adjustedBasis: number;
  /** Proceeds less adjusted basis; negative for a loss. */
  gainOrLoss: number;
  result: 'gain' | 'loss' | 'none';
  /** Section 1245 property: the gain up to the depreciation taken is ordinary income. */
  ordinaryRecapture: number;
  /** Section 1250 property: the gain up to the depreciation taken is unrecaptured section 1250 gain (taxed up to 25% for individuals). */
  unrecapturedSection1250: number;
  /** The part of a gain left after recapture (section 1231). */
  remainingGain: number;
}

/**
 * Gain or loss on disposal: proceeds less cost plus accumulated depreciation.
 * `propertyType` is `section_1245` (personal property, the default) or
 * `section_1250` (real property). Section 179 and bonus count as depreciation
 * taken.
 */
export function gainOnDisposal(
  cost: number,
  accumulated: number,
  proceeds: number,
  options: { propertyType?: 'section_1245' | 'section_1250' } = {},
): DisposalGain {
  const adjustedBasis = round2(cost - accumulated);
  const gainOrLoss = round2(proceeds - adjustedBasis);
  const gain = Math.max(0, gainOrLoss);
  const recapture = Math.min(gain, Math.max(0, round2(accumulated)));
  const real = options.propertyType === 'section_1250';
  return {
    adjustedBasis,
    gainOrLoss,
    result: gainOrLoss > 0 ? 'gain' : gainOrLoss < 0 ? 'loss' : 'none',
    ordinaryRecapture: real ? 0 : recapture,
    unrecapturedSection1250: real ? recapture : 0,
    remainingGain: round2(gain - recapture),
  };
}

export {
  bonusDepreciationPercent,
  bonusEligible,
  deMinimisApplies,
  deMinimisThreshold,
  section179Allowance,
  section179Parameters,
} from './depreciation-tables';
