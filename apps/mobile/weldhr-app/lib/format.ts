/**
 * Display formatting. Everything takes the Intl locale from `useI18n()` so a
 * Dutch phone reads "3 mrt" and "€ 12,50".
 */

import { parseIsoDate } from './dates';

/** Between the two ends of a range: a hyphen, narrower than an en dash. */
export const RANGE = ' - ';

/** "Mon 3 Mar"; the year only when it is not this year. */
export function formatDay(iso: string | null | undefined, locale: string, now: Date = new Date()): string {
  const date = parseIsoDate(iso ?? null);
  if (!date) return iso ?? '';
  return date.toLocaleDateString(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** "3 Mar 2026". */
export function formatDate(iso: string | null | undefined, locale: string): string {
  const date = parseIsoDate(iso ?? null) ?? (iso ? new Date(iso) : null);
  if (!date || Number.isNaN(date.getTime())) return iso ?? '';
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "3 - 7 Mar", "28 Feb - 3 Mar", or a single day when both ends match. */
export function formatDateRange(start: string, end: string, locale: string, now: Date = new Date()): string {
  if (start === end) return formatDay(start, locale, now);
  const from = parseIsoDate(start);
  const to = parseIsoDate(end);
  if (!from || !to) return `${start}${RANGE}${end}`;
  const withYear = to.getFullYear() !== now.getFullYear() || from.getFullYear() !== to.getFullYear();
  const sameMonth = from.getMonth() === to.getMonth() && from.getFullYear() === to.getFullYear();
  const right = to.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  const left = sameMonth
    ? String(from.getDate())
    : from.toLocaleDateString(locale, {
        day: 'numeric',
        month: 'short',
        ...(from.getFullYear() !== to.getFullYear() ? { year: 'numeric' } : {}),
      });
  return `${left}${RANGE}${right}`;
}

/** "09:05" from an ISO timestamp, in the phone's time zone. */
export function formatTime(timestamp: string | null | undefined, locale: string): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** Money in major units (the API's `12.5` or `"12.50"`). */
export function formatMoney(amount: number | string, currency: string, locale: string): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return `${amount} ${currency}`;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/** Leave days: whole numbers bare, halves with one decimal ("2", "1.5" / "1,5"). */
export function formatDays(days: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(days);
}

/** "7:45" for worked minutes. */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes)) return '';
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Parse what someone typed as an amount: "12,50", "12.5", "1.234,56" → 12.5 / 1234.56. */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  const decimalSeparator = lastComma > lastDot ? ',' : '.';
  const thousands = decimalSeparator === ',' ? '.' : ',';
  const normalized = cleaned.split(thousands).join('').replace(decimalSeparator, '.');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}

/** "Time off (2)" for a segment with work waiting; the bare label when there is none. */
export function withCount(label: string, count: number): string {
  return count > 0 ? `${label} (${count})` : label;
}

/** First name for a greeting, falling back to the display name's first word. */
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? '';
}

/** "7h 5m" for minutes, with the unit letters from the app's language ("7u 5m"). */
export function formatHoursMinutes(minutes: number | null | undefined, pattern: string): string {
  const total = Math.max(0, Math.round(minutes ?? 0));
  return pattern.replace('{h}', String(Math.floor(total / 60))).replace('{m}', String(total % 60));
}

/** A running clock, "01:02:08", for someone who is clocked in. */
export function formatTimer(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

/** "Sunday 25 October", the year only when it is not this year. */
export function formatLongDay(iso: string, locale: string, now: Date = new Date()): string {
  const date = parseIsoDate(iso);
  if (!date) return iso;
  return date
    .toLocaleDateString(locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    })
    .replace(',', '');
}

/** "25 Oct". */
export function formatShortDate(iso: string, locale: string): string {
  const date = parseIsoDate(iso);
  if (!date) return iso;
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short' }).replace('.', '');
}

/** "19 Oct - 25 Oct", both ends spelled out the way the week navigator shows them. */
export function formatSpan(start: string, end: string, locale: string): string {
  return start === end ? formatShortDate(start, locale) : `${formatShortDate(start, locale)}${RANGE}${formatShortDate(end, locale)}`;
}
