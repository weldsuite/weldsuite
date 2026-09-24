import type { Locale } from '@/lib/i18n';

const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB', nl: 'nl-NL' };
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pages render on the server (UTC) and hydrate in the browser, so every
 * formatter takes the time zone explicitly (from `useI18n().timeZone`) —
 * never the runtime's local zone — or the two renders would disagree.
 */

export function formatDate(value: string | null | undefined, locale: Locale, timeZone: string): string {
  if (!value) return '';
  // A calendar date (`2026-09-24`) is the same day everywhere: read and print it in UTC.
  const dateOnly = DATE_ONLY.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: dateOnly ? 'UTC' : timeZone,
  }).format(date);
}

export function formatDateTime(value: string | null | undefined, locale: Locale, timeZone: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

export function formatTime(value: string | null | undefined, locale: Locale, timeZone: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { hour: '2-digit', minute: '2-digit', timeZone }).format(date);
}

/** Hour of day (0–23) in `timeZone` — for greetings that must match between server and browser. */
export function hourIn(timeZone: string, now: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now);
  return Number(hour);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
