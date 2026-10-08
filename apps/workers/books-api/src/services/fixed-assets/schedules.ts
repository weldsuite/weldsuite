/**
 * Depreciation schedules of stored assets and books.
 *
 * The domain functions work on plain numbers and fiscal periods; this file
 * feeds them from rows and the entity's fiscal year:
 *
 * - `annualSchedule`: one row per fiscal year (calendar, any 12 months or
 *   52-53 weeks), for every book. Tax books (federal, state) live only here,
 *   computed on demand; nothing about them is stored except the book's setup.
 * - `ledgerRows`: the same depreciation by month for the book that posts to
 *   the ledger, which is what `fixed_asset_depreciation` stores. A 52-53-week
 *   entity has no calendar months, so each fiscal year's amount is spread over
 *   its twelve 4-4-5 periods by the days the asset is in service in each.
 * - `macrsConventionMap`: the mid-quarter test over all of an entity's federal
 *   MACRS assets, giving each its convention (half-year, mid-quarter, mid-month).
 */

import {
  depreciationBasis,
  depreciationSchedule,
  midQuarterTestBasis,
  macrsConventions,
  monthlySchedule,
  type DepreciationBasis,
  type DepreciationConvention,
  type DepreciationIssue,
  type DepreciationRow,
  type DepreciationSchedule,
  type FiscalPeriod as DepreciationPeriod,
} from '@weldsuite/books-domain/us-compliance/depreciation';
import { addDays, addMonths, diffDays } from '@weldsuite/books-domain/us-compliance/dates';
import {
  fiscalPeriods,
  fiscalYearRange,
  type FiscalYearConfig,
} from '@weldsuite/books-domain/us-compliance/fiscal-year';
import {
  asNumber,
  effectiveConvention,
  fiscalYearLabel,
  fiscalYearPeriods,
  fiscalYearPeriodsFrom,
  fromCents,
  isMacrsBook,
  isRealPropertyBook,
  toCents,
  toDepreciationAsset,
  toDepreciationBook,
  yearsNeeded,
  type AssetRow,
  type BookRow,
  type MacrsConvention,
} from './shared';

/** One stored depreciation amount, before it has an id. */
export interface LedgerRowInput {
  label: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  accumulated: number;
  remaining: number;
}

export interface LedgerSchedule {
  rows: LedgerRowInput[];
  basis: DepreciationBasis;
  issues: DepreciationIssue[];
}

export interface AssetWithBook {
  asset: AssetRow;
  book: BookRow;
}

/** The fiscal years a book's schedule runs over. */
export function schedulePeriods(config: FiscalYearConfig, asset: Pick<AssetRow, 'placedInServiceDate'>, book: Pick<BookRow, 'recoveryYears'>): DepreciationPeriod[] {
  return fiscalYearPeriodsFrom(config, asset.placedInServiceDate, yearsNeeded(asNumber(book.recoveryYears)));
}

// ---------------------------------------------------------------------------
// Mid-quarter test

/** The basis the mid-quarter test counts for an asset's federal book: cost times business use, less section 179 (bonus does not reduce it). */
export function midQuarterBasisOf(asset: AssetRow, book: BookRow): number {
  const domainAsset = toDepreciationAsset(asset, {}, book);
  const basis = depreciationBasis(domainAsset, toDepreciationBook(book));
  return midQuarterTestBasis(domainAsset.cost, domainAsset.businessUsePercent ?? 100, basis.section179);
}

/**
 * The convention of every federal MACRS asset, from the mid-quarter test run
 * for each tax year the assets were placed in service in. Real property is
 * mid-month and never counted. State MACRS books use the same verdict.
 */
export function macrsConventionMap(config: FiscalYearConfig, rows: readonly AssetWithBook[]): Record<string, MacrsConvention> {
  const federal = rows.filter(({ book }) => book.book === 'federal' && isMacrsBook(book));
  if (federal.length === 0) return {};
  const years = federal.map(({ asset }) => fiscalYearRange(config, asset.placedInServiceDate).year);
  const first = Math.min(...years);
  const last = Math.max(...years);
  const periods = fiscalYearPeriods(config, first, last - first + 1);
  return macrsConventions(
    federal.map(({ asset, book }) => ({
      id: asset.id,
      placedInServiceDate: asset.placedInServiceDate,
      basis: midQuarterBasisOf(asset, book),
      realProperty: isRealPropertyBook(book),
      disposalDate: asset.disposalDate,
    })),
    periods,
  );
}

// ---------------------------------------------------------------------------
// Annual schedule (every book)

export interface ScheduleContext {
  config: FiscalYearConfig;
  conventions: Readonly<Record<string, MacrsConvention>>;
}

/** The yearly depreciation of one book, under the convention the mid-quarter test gives its asset. */
export function annualSchedule(
  asset: AssetRow,
  book: BookRow,
  context: ScheduleContext,
  overrides: { disposalDate?: string | null } = {},
): DepreciationSchedule {
  const convention = effectiveConvention(book, asset.id, context.conventions);
  return depreciationSchedule(
    toDepreciationAsset(asset, overrides, book),
    toDepreciationBook(book, convention),
    schedulePeriods(context.config, asset, book),
  );
}

// ---------------------------------------------------------------------------
// Ledger (monthly) schedule

function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  return start > end ? 0 : diffDays(start, end) + 1;
}

/** Split whole cents over weights; the remainder goes to the last period that has weight. */
function splitCents(totalCents: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const result = weights.map(() => 0);
  if (sum <= 0) return result;
  let assigned = 0;
  let lastWeighted = 0;
  weights.forEach((weight, index) => {
    if (weight <= 0) return;
    result[index] = Math.floor((totalCents * weight) / sum);
    assigned += result[index] as number;
    lastWeighted = index;
  });
  result[lastWeighted] = (result[lastWeighted] as number) + (totalCents - assigned);
  return result;
}

/**
 * Yearly amounts spread over the fiscal year's twelve periods, for 52-53-week
 * years. The domain's monthly schedule needs whole calendar months, which a
 * 4-4-5 period is not.
 */
function periodLedgerRows(
  asset: AssetRow,
  book: BookRow,
  config: FiscalYearConfig,
  yearly: DepreciationSchedule,
  disposalDate: string | null,
): LedgerRowInput[] {
  const serviceStart = asset.placedInServiceDate;
  const lifeEnd = addDays(addMonths(serviceStart, Math.round(asNumber(book.recoveryYears) * 12)), -1);
  const serviceEnd = disposalDate && disposalDate < lifeEnd ? disposalDate : lifeEnd;
  const totalDepreciable = yearly.basis.totalDepreciable;
  const rows: LedgerRowInput[] = [];
  let accumulated = 0;
  for (const year of yearly.rows) {
    const fiscalYear = fiscalYearRange(config, year.periodStart);
    const periods = fiscalPeriods(config, fiscalYear.year);
    let weights = periods.map((period) => overlapDays(period.start, period.end, serviceStart, serviceEnd));
    if (book.method === 'expensed' || weights.every((weight) => weight === 0)) {
      // Written off in the period it is placed in service.
      weights = periods.map((period) => (serviceStart >= period.start && serviceStart <= period.end ? 1 : 0));
    }
    const shares = splitCents(toCents(year.amount), weights);
    periods.forEach((period, index) => {
      const cents = shares[index] as number;
      if (cents === 0) return;
      accumulated += cents;
      rows.push({
        label: `${fiscalYearLabel(config, fiscalYear.year)} P${period.number}`,
        periodStart: period.start,
        periodEnd: period.end,
        amount: fromCents(cents),
        accumulated: fromCents(accumulated),
        remaining: fromCents(toCents(totalDepreciable) - accumulated),
      });
    });
  }
  return rows;
}

/**
 * The depreciation of the ledger book by month (or by 4-4-5 period for a
 * 52-53-week entity): what `fixed_asset_depreciation` holds and the monthly run
 * posts.
 */
export function ledgerRows(
  asset: AssetRow,
  book: BookRow,
  config: FiscalYearConfig,
  overrides: { disposalDate?: string | null } = {},
): LedgerSchedule {
  const domainAsset = toDepreciationAsset(asset, overrides, book);
  const domainBook = toDepreciationBook(book, book.convention as DepreciationConvention);
  const periods = schedulePeriods(config, asset, book);

  if (config.type === 'month') {
    const monthly = monthlySchedule(domainAsset, domainBook, periods);
    return {
      basis: monthly.basis,
      issues: monthly.issues,
      rows: monthly.rows.map((row) => ({
        label: row.label,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        amount: row.amount,
        accumulated: row.accumulated,
        remaining: row.remaining,
      })),
    };
  }

  const yearly = depreciationSchedule(domainAsset, domainBook, periods);
  return {
    basis: yearly.basis,
    issues: yearly.issues,
    rows: periodLedgerRows(asset, book, config, yearly, domainAsset.disposalDate ?? null),
  };
}

/** The yearly rows of a schedule that fall in one fiscal year (by label), if any. */
export function rowForYear(rows: readonly DepreciationRow[], label: string): DepreciationRow | undefined {
  return rows.find((row) => row.label === label);
}
