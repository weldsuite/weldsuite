/**
 * Number helpers for the WeldStash screens. The API sends numeric columns as
 * text (`"12.5000"`), the way Drizzle returns them; every display and every
 * sum goes through `toNumber` first.
 */

/** A numeric column as the API sends it: text (`"12.5000"`), a number, or nothing. */
export type NumericValue = string | number | null | undefined;

/** A numeric column value as a number: null, undefined and unparsable text read as 0. */
export function toNumber(value: NumericValue): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Like `toNumber`, but null stays null (a missing value is not zero). */
export function toNumberOrNull(value: NumericValue): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** An amount in a currency, e.g. `EUR 1,234.50` formatted for the locale. Falls back to a plain number for an unknown currency code. */
export function formatMoney(
  value: NumericValue,
  currency: string | null | undefined,
  locale?: string,
): string {
  const n = toNumber(value);
  if (currency) {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n);
    } catch {
      // An unknown currency code: show the code next to a plain number.
      return `${currency} ${n.toFixed(2)}`;
    }
  }
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

/** A quantity or count with at most `digits` decimals and no trailing zeros. */
export function formatNumber(value: NumericValue, digits = 1, locale?: string): string {
  const n = toNumberOrNull(value);
  if (n === null) return '';
  return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
}

/** The date part of an ISO timestamp (`2026-11-18T10:00:00Z` -> `2026-11-18`), or null. */
export function isoDatePart(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

/** A date or timestamp for display in the locale; empty for a missing or invalid value. */
export function formatDate(value: string | null | undefined, locale?: string): string {
  if (!value) return '';
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}
