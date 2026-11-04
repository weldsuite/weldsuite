/**
 * Date and time formatting for email copy. Workers run in UTC, so every
 * function takes the IANA zone the recipient should see the time in.
 */

import { emailStrings, fill, intlLocale, type EmailLocale } from './i18n';

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone || timeZone.length > 50) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The first valid zone of the candidates, else UTC. */
export function zoneOr(...candidates: Array<string | null | undefined>): string {
  return candidates.find(isValidTimeZone) ?? 'UTC';
}

function fmt(iso: string, locale: EmailLocale, timeZone: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(intlLocale(locale), { ...options, timeZone }).format(new Date(iso));
}

/** "Monday, October 5, 2026" / "maandag 5 oktober 2026". */
export function formatDate(iso: string, locale: EmailLocale, timeZone: string): string {
  return fmt(iso, locale, timeZone, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/** "3:00 PM" / "15:00", optionally with the zone abbreviation. */
export function formatTime(iso: string, locale: EmailLocale, timeZone: string, withZone = false): string {
  return fmt(iso, locale, timeZone, {
    hour: 'numeric',
    minute: '2-digit',
    ...(withZone ? { timeZoneName: 'short' as const } : {}),
  });
}

function formatDateTime(iso: string, locale: EmailLocale, timeZone: string, withZone = true): string {
  return fmt(iso, locale, timeZone, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(withZone ? { timeZoneName: 'short' as const } : {}),
  });
}

function sameDay(a: string, b: string, timeZone: string): boolean {
  const day = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(iso));
  return day(a) === day(b);
}

/** "3:00 PM – 4:00 PM CEST": the zone is only written once, at the end. */
export function formatTimeRange(
  startIso: string,
  endIso: string,
  locale: EmailLocale,
  timeZone: string,
): string {
  return `${formatTime(startIso, locale, timeZone)} – ${formatTime(endIso, locale, timeZone, true)}`;
}

/**
 * One line describing when something happens:
 * - timed, same day: "Monday, October 5, 2026 at 3:00 PM – 4:00 PM GMT+2" (zone once, at the end)
 * - timed, across days: both ends in full
 * - all day: "Monday, October 5, 2026 (all day)", or a date range
 */
export function formatWhen(opts: {
  start: string;
  end?: string | null;
  allDay?: boolean | null;
  locale: EmailLocale;
  timeZone: string;
}): string {
  const { start, end, allDay, locale, timeZone } = opts;
  if (allDay) {
    const days =
      end && !sameDay(start, end, timeZone)
        ? `${formatDate(start, locale, timeZone)} – ${formatDate(end, locale, timeZone)}`
        : formatDate(start, locale, timeZone);
    return fill(emailStrings(locale).dates.allDay, { date: days });
  }
  if (!end) return formatDateTime(start, locale, timeZone);
  if (sameDay(start, end, timeZone)) {
    return `${formatDateTime(start, locale, timeZone, false)} – ${formatTime(end, locale, timeZone, true)}`;
  }
  return `${formatDateTime(start, locale, timeZone)} – ${formatDateTime(end, locale, timeZone)}`;
}

/** Month names of `periodLabel`, fixed tables so every backend writes the same text. */
const MONTH_NAMES: Record<EmailLocale, readonly string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  nl: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'],
};

/**
 * A report period as a person reads it: the ISO week `2026-W45` is "Week 45,
 * 2026", the month `2026-11` is "November 2026" / "november 2026". Any other
 * text is returned as it is. The Rust backend mirrors it (`period_label` in
 * `weldsuite-emails`); month names come from fixed tables, not `Intl`, so the
 * two cannot differ.
 */
export function periodLabel(locale: EmailLocale, period: string): string {
  const week = /^(\d{4})-W(0[1-9]|[1-4][0-9]|5[0-3])$/.exec(period);
  if (week) return `Week ${Number(week[2])}, ${week[1]}`;
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (month) return `${MONTH_NAMES[locale][Number(month[2]) - 1]} ${month[1]}`;
  return period;
}
