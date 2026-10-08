/**
 * Shared types and helpers of the Sales Tax Center (per-agency returns,
 * docs/plans/weldbooks-us.md §5).
 */

import type { TaxReturnAdjustment } from '@weldsuite/db/schema';
import type { TaxReturnLine } from '@weldsuite/books-domain/jurisdictions/types';
import type { SalesTaxWorksheetLine } from '@weldsuite/books-domain/jurisdictions/us/sales-tax-return';
import { fromCents, toCents } from '@weldsuite/books-domain/sales-tax/rounding';
import { schema } from '@weldsuite/worker-kit/db';

export type TaxLineRow = typeof schema.taxLines.$inferSelect;
export type AgencyRow = typeof schema.salesTaxAgencies.$inferSelect;
export type ReturnRow = typeof schema.taxReturns.$inferSelect;
export type EntityRow = typeof schema.entities.$inferSelect;

/** A return adjustment as stored: `accountId` overrides the account an `other` adjustment posts to, `auto` marks a proposal the calculation may refresh. */
export interface ReturnAdjustment extends TaxReturnAdjustment {
  accountId?: string;
  auto?: boolean;
}

export type ReturnStatus = 'open' | 'calculated' | 'reviewed' | 'filed' | 'paid';

export const EDITABLE_STATUSES: readonly string[] = ['open', 'calculated', 'reviewed'];
export const FILED_STATUSES: readonly string[] = ['filed', 'paid'];

/** The user can fix the cause: answered 400 (or 409), not 500. */
export class TaxReturnError extends Error {
  constructor(
    message: string,
    readonly kind: 'bad_request' | 'not_found' | 'conflict' = 'bad_request',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TaxReturnError';
  }
}

export function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Round to whole cents (half away from zero). */
export function round2(value: number): number {
  return fromCents(toCents(value));
}

export function sumMoney(values: Iterable<number>): number {
  let cents = 0;
  for (const value of values) cents += toCents(value);
  return fromCents(cents);
}

export function isoDate(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/** Today's date in a time zone (`YYYY-MM-DD`); an unknown zone falls back to UTC. */
export function todayIn(timeZone: string | null | undefined, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : isoDate(now);
  } catch {
    return isoDate(now);
  }
}

/** Adds calendar months to an ISO day (the day is clamped to the end of a shorter month). */
export function addMonthsIso(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Day after an ISO day (end-exclusive upper bounds for timestamp columns). */
export function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function startOfDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

/** Maps a tax-ledger row onto the worksheet's input; `scale` shares a row (cash basis). */
export function toWorksheetLine(
  row: TaxLineRow,
  options: { scale?: number; taxDate?: string } = {},
): SalesTaxWorksheetLine {
  const scale = options.scale ?? 1;
  const scaled = (value: string | null): number => (scale === 1 ? num(value) : round2(num(value) * scale));
  const optional = (value: string | null): number | undefined => (value === null ? undefined : scaled(value));
  const isUse = row.direction === 'use';
  const line: TaxReturnLine & SalesTaxWorksheetLine = {
    taxRateId: row.taxRateId ?? '',
    taxCategoryCode: row.taxCategoryCode ?? '',
    taxableAmount: scaled(row.taxableAmount),
    taxAmount: scaled(row.taxAmount),
    direction: row.direction === 'sales' ? 'sales' : 'purchase',
    selfAssessed: row.selfAssessed,
    kind: isUse ? 'use' : 'sales',
    agencyId: row.agencyId,
    stateCode: row.stateCode,
    jurisdictionCode: row.jurisdictionCode,
    jurisdictionName: row.jurisdictionName,
    jurisdictionLevel: row.jurisdictionLevel,
    reportingCode: row.reportingCode,
    rate: num(row.rate),
    grossAmount: optional(row.grossAmount),
    exemptAmount: optional(row.exemptAmount),
    nonTaxableAmount: optional(row.nonTaxableAmount),
    exemptReason: row.exemptReason,
    taxCode: row.taxCode,
    shipToState: row.shipToState,
    marketplaceFacilitated: row.marketplaceFacilitated,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    sourceLineId: row.sourceLineId,
    certificateId: row.certificateId,
    taxDate: options.taxDate ?? row.taxDate,
  };
  return line;
}

/** Tax charged or accrued by a ledger row, in dollars (signed). */
export function rowTax(row: Pick<TaxLineRow, 'taxAmount'>): number {
  return num(row.taxAmount);
}

/** Splits a list into chunks (large `IN (...)` lists). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The ship-to state of a stored address (`state` is a USPS code), upper-cased; empty when missing. */
export function stateOfAddress(address: unknown): string {
  if (!address || typeof address !== 'object') return '';
  const state = (address as { state?: unknown }).state;
  return typeof state === 'string' ? state.trim().toUpperCase() : '';
}

/** The business holds a registration in the state on that date (status registered, or closed and still within its dates). */
export function registeredOn(agencies: AgencyRow[], stateCode: string | null, date: string): boolean {
  if (!stateCode) return false;
  return agencies.some(
    (a) =>
      a.stateCode.toUpperCase() === stateCode.toUpperCase() &&
      (a.status === 'registered' || a.status === 'closed') &&
      (!a.registeredFrom || a.registeredFrom <= date) &&
      (!a.registeredUntil || date <= a.registeredUntil),
  );
}

/** Total payable by a return: tax due (net of what an earlier return of the period already reported) plus adjustments. */
export function computeTotalDue(
  summary: { salesTaxPayable?: number; useTaxPayable?: number } | null | undefined,
  adjustments: readonly ReturnAdjustment[] | null | undefined,
): number {
  return sumMoney([
    summary?.salesTaxPayable ?? 0,
    summary?.useTaxPayable ?? 0,
    ...(adjustments ?? []).map((a) => a.amount),
  ]);
}

export const ADJUSTMENT_TYPES = ['vendor_discount', 'prepayment', 'penalty', 'interest', 'rounding', 'other'] as const;
