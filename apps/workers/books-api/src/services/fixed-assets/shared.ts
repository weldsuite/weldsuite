/**
 * Shared pieces of the fixed-asset services: row types, the error type the
 * routes map to HTTP statuses, the fiscal-year axis depreciation runs on, and
 * the conversions between database rows and the depreciation domain's inputs
 * (`@weldsuite/books-domain/us-compliance/depreciation`).
 *
 * Money in the schedules is a JS number in whole cents; rows hold strings.
 */

import { ClosedPeriodError, LockedPeriodError } from '@weldsuite/books-domain/accounting-guards';
import type {
  DepreciationAsset,
  DepreciationBook,
  DepreciationConvention,
  DepreciationMethod,
  FiscalPeriod as DepreciationPeriod,
} from '@weldsuite/books-domain/us-compliance/depreciation';
import {
  fiscalYearConfigOf,
  fiscalYearFor,
  fiscalYearRange,
  type FiscalYearConfig,
} from '@weldsuite/books-domain/us-compliance/fiscal-year';
import type { schema } from '@weldsuite/worker-kit/db';
import { PostingError } from '../accounting-posting';

export type AssetRow = typeof schema.fixedAssets.$inferSelect;
export type BookRow = typeof schema.fixedAssetBooks.$inferSelect;
export type DepreciationRowRecord = typeof schema.fixedAssetDepreciation.$inferSelect;
export type EntityRow = typeof schema.entities.$inferSelect;

export type BookKind = 'book' | 'federal' | 'state';
export type MacrsConvention = 'half_year' | 'mid_quarter' | 'mid_month';

/** A request the service refuses; `kind` picks the HTTP status in the route. */
export class FixedAssetError extends Error {
  constructor(
    message: string,
    readonly kind: 'bad_request' | 'not_found' | 'conflict' = 'bad_request',
  ) {
    super(message);
    this.name = 'FixedAssetError';
  }
}

/** Errors the posting service and the lock-date guards raise: the caller's data, not a server fault. */
export function isLedgerError(err: unknown): err is PostingError | ClosedPeriodError | LockedPeriodError {
  return err instanceof PostingError || err instanceof ClosedPeriodError || err instanceof LockedPeriodError;
}

// ---------------------------------------------------------------------------
// Money and dates

export const toCents = (value: number): number => Math.round(value * 100 + (value >= 0 ? 1e-9 : -1e-9));
export const fromCents = (cents: number): number => cents / 100;
export const money = (cents: number): string => (cents / 100).toFixed(2);
export const asNumber = (value: string | number | null | undefined, fallback = 0): number => {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** A date at UTC midnight, the way the posting service reads `date`. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function isoDay(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fiscal axis

export function entityFiscalConfig(entity: Pick<EntityRow, 'fiscalYearStart' | 'fiscalYearConfig'>): FiscalYearConfig {
  return fiscalYearConfigOf(entity);
}

/** `2026` for a calendar year, `FY2026` for any other fiscal year. */
export function fiscalYearLabel(config: FiscalYearConfig, year: number): string {
  return config.type === 'month' && config.startMonth === 1 ? String(year) : `FY${year}`;
}

/** `count` consecutive fiscal years, starting with fiscal year `firstYear`, as depreciation periods. */
export function fiscalYearPeriods(config: FiscalYearConfig, firstYear: number, count: number): DepreciationPeriod[] {
  return Array.from({ length: count }, (_, index) => {
    const year = fiscalYearFor(config, firstYear + index);
    return { label: fiscalYearLabel(config, year.year), start: year.start, end: year.end };
  });
}

/** Fiscal years from the one containing `date`. */
export function fiscalYearPeriodsFrom(config: FiscalYearConfig, date: string, count: number): DepreciationPeriod[] {
  return fiscalYearPeriods(config, fiscalYearRange(config, date).year, count);
}

/** How many fiscal years a schedule needs to run past the end of the recovery period. */
export function yearsNeeded(recoveryYears: number): number {
  return Math.ceil(recoveryYears > 0 ? recoveryYears : 1) + 3;
}

// ---------------------------------------------------------------------------
// Domain conversions

export const MACRS_METHODS: readonly string[] = ['macrs_gds', 'macrs_ads'];
const REAL_PROPERTY_YEARS = new Set([27.5, 30, 31.5, 39, 40]);

export const isMacrsBook = (book: { method: string }): boolean => MACRS_METHODS.includes(book.method);

/** Real property (27.5 and 39-year GDS, 30 to 40-year ADS) uses the mid-month convention and is out of the mid-quarter test. */
export const isRealPropertyBook = (book: { method: string; recoveryYears: string | number }): boolean =>
  isMacrsBook(book) && REAL_PROPERTY_YEARS.has(asNumber(book.recoveryYears));

/**
 * The asset as the depreciation domain sees it for one book. The ledger book
 * carries the whole cost (the bill went to the fixed asset account in full), so
 * it ignores business use; the tax books depreciate only the business share.
 */
export function toDepreciationAsset(
  asset: AssetRow,
  overrides: { disposalDate?: string | null } = {},
  book?: { book: string },
): DepreciationAsset {
  const disposalDate = overrides.disposalDate !== undefined ? overrides.disposalDate : asset.disposalDate;
  return {
    cost: asNumber(asset.cost),
    salvageValue: asNumber(asset.salvageValue),
    businessUsePercent: book?.book === 'book' ? 100 : asNumber(asset.businessUsePercent, 100),
    acquisitionDate: asset.acquisitionDate,
    placedInServiceDate: asset.placedInServiceDate,
    disposalDate: disposalDate ?? null,
  };
}

export function defaultConvention(book: { method: string; recoveryYears: string | number }): DepreciationConvention {
  if (isMacrsBook(book)) return isRealPropertyBook(book) ? 'mid_month' : 'half_year';
  return 'full_month';
}

export function toDepreciationBook(
  book: Pick<BookRow, 'method' | 'convention' | 'recoveryYears' | 'section179Amount' | 'bonusPercent'>,
  convention?: DepreciationConvention,
): DepreciationBook {
  return {
    method: book.method as DepreciationMethod,
    convention: convention ?? (book.convention as DepreciationConvention),
    recoveryYears: asNumber(book.recoveryYears),
    section179Amount: asNumber(book.section179Amount),
    bonusPercent: asNumber(book.bonusPercent),
  };
}

/** The convention a MACRS book depreciates under: the mid-quarter test's verdict for its year, else the stored one. */
export function effectiveConvention(
  book: BookRow,
  assetId: string,
  conventions: Readonly<Record<string, MacrsConvention>>,
): DepreciationConvention {
  if (!isMacrsBook(book)) return book.convention as DepreciationConvention;
  return conventions[assetId] ?? defaultConvention(book);
}

/** The US property classes with tables, and the book life used when none is given. */
export const MACRS_CLASSES: readonly string[] = ['3', '5', '7', '10', '15', '20', '25', '27.5', '39'];

export function isMacrsClass(assetClass: string | null | undefined): assetClass is string {
  return Boolean(assetClass && MACRS_CLASSES.includes(assetClass));
}

export function sumCents(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += toCents(value);
  return total;
}
