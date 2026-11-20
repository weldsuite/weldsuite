/** Number, percentage, duration and bucket formatting shared by the analytics pages. */

import type { PanelInterval } from '@weldsuite/app-api-client/schemas/weldpanel-query';

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** 12 345 becomes "12.3K": for axes and tiles where room is tight. */
export function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** `ratio` is 0-1. */
export function formatPercent(ratio: number, locale: string, digits = 1): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: digits }).format(ratio);
}

/** Seconds as "1m 23s", "2h 05m" or "45s". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.round(hours / 24)}d`;
}

/** Relative change of `current` against `previous` (0.1 is +10 %), or null when there is nothing to compare. */
export function relativeChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

/** "+12%" / "-3.4%" with an explicit sign. */
export function formatSignedPercent(ratio: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(ratio);
}

/** An axis label for a bucket: `2026-11-03` or `2026-11-03T14:00` in the spec's timezone. */
export function formatBucket(bucket: string, interval: PanelInterval, locale: string): string {
  const [datePart = '', timePart] = bucket.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return bucket;
  const date = new Date(Date.UTC(y, m - 1, d, timePart ? Number(timePart.slice(0, 2)) : 0));
  let options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (interval === 'hour') options = { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' };
  else if (interval === 'month') options = { month: 'short', year: 'numeric', timeZone: 'UTC' };
  return new Intl.DateTimeFormat(locale, options).format(date);
}

/** "NL" becomes "Netherlands" in the UI language; unknown codes come back as they are. */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

/** A `YYYY-MM-DD` day as a short date, without a timezone shift. */
export function formatDay(ymd: string, locale: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}
