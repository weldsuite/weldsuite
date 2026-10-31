/**
 * Business-time arithmetic for WeldDesk SLA clocks.
 *
 * A calendar is the `BusinessHours` shape SLA policies and helpdesk settings
 * store: a timezone, open/close times per weekday and holidays. `null` means
 * 24x7, where business time is wall-clock time. Everything here is pure and
 * timezone-aware through `Intl`, so it runs the same in every worker.
 */

import type { BusinessHours } from '../schema/helpdesk-slas';

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_MINUTES = 24 * 60;
/** Ten years of days: a calendar that never opens again stops the search here. */
const MAX_DAYS = 3660;

interface OpenWindow {
  /** Minutes after local midnight. */
  open: number;
  close: number;
}

export interface DeskSlaCalendar {
  timezone: string;
  /** Indexed by `Date.getUTCDay()` of the local date: 0 = Sunday. */
  days: (OpenWindow | null)[];
  holidays: Set<string>;
  recurringHolidays: Set<string>;
}

function parseClock(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes >= 0 && minutes <= DAY_MINUTES ? minutes : null;
}

function validTimezone(timezone: string | undefined): string {
  if (!timezone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

/**
 * Normalise stored business hours. Returns null (24x7) when there are none
 * or when no weekday is ever open, so a misconfigured calendar can never
 * stop a clock for good.
 */
export function toDeskSlaCalendar(hours: BusinessHours | null | undefined): DeskSlaCalendar | null {
  if (!hours) return null;
  const days = DAY_KEYS.map((key): OpenWindow | null => {
    const day = hours[key];
    if (!day?.isOpen) return null;
    const open = parseClock(day.openTime) ?? 0;
    const closeRaw = parseClock(day.closeTime) ?? DAY_MINUTES;
    // An overnight window (close before open) runs to midnight.
    const close = closeRaw > open ? closeRaw : DAY_MINUTES;
    return close > open ? { open, close } : null;
  });
  if (days.every((day) => day === null)) return null;

  const holidays = new Set<string>();
  const recurringHolidays = new Set<string>();
  for (const holiday of hours.holidays ?? []) {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(holiday.date ?? '')?.[0];
    if (!date) continue;
    if (holiday.isRecurring) recurringHolidays.add(date.slice(5));
    else holidays.add(date);
  }
  return { timezone: validTimezone(hours.timezone), days, holidays, recurringHolidays };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** The local wall-clock time at `ms`, as if it were UTC. */
function localAsUtc(ms: number, timezone: string): number {
  const parts = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(timezone).formatToParts(new Date(ms))) {
    if (part.type in parts) parts[part.type as keyof typeof parts] = Number(part.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
}

/** The instant at which local midnight of `localDay` (a UTC-midnight timestamp) plus `minutes` happens. */
function zonedToUtc(localDay: number, minutes: number, timezone: string): number {
  const wall = localDay + minutes * 60_000;
  const offset = localAsUtc(wall, timezone) - wall;
  let instant = wall - offset;
  // Across a DST change the offset at the result can differ from the guess.
  const corrected = localAsUtc(instant, timezone) - instant;
  if (corrected !== offset) instant = wall - corrected;
  return instant;
}

function dateKey(localDay: number): string {
  return new Date(localDay).toISOString().slice(0, 10);
}

/** Open interval of a local day in UTC ms, or null when it is closed. */
function openInterval(calendar: DeskSlaCalendar, localDay: number): [number, number] | null {
  const window = calendar.days[new Date(localDay).getUTCDay()];
  if (!window) return null;
  const key = dateKey(localDay);
  if (calendar.holidays.has(key) || calendar.recurringHolidays.has(key.slice(5))) return null;
  return [zonedToUtc(localDay, window.open, calendar.timezone), zonedToUtc(localDay, window.close, calendar.timezone)];
}

/** UTC-midnight timestamp of the local date `ms` falls on. */
function localDayOf(ms: number, timezone: string): number {
  const local = localAsUtc(ms, timezone);
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
}

/** Business milliseconds between two instants (0 when `to` is not after `from`). */
export function businessMsBetween(calendar: DeskSlaCalendar | null, from: Date, to: Date): number {
  const start = from.getTime();
  const end = to.getTime();
  if (end <= start) return 0;
  if (!calendar) return end - start;

  let total = 0;
  // Start a day early: a window of the previous local day can't reach past
  // midnight, but DST shifts make "which local day" fuzzy at the edges.
  let day = localDayOf(start, calendar.timezone) - DAY_MS;
  for (let i = 0; i < MAX_DAYS; i++, day += DAY_MS) {
    const interval = openInterval(calendar, day);
    if (interval) {
      const [open, close] = interval;
      if (open >= end) break;
      const overlap = Math.min(close, end) - Math.max(open, start);
      if (overlap > 0) total += overlap;
    } else if (day - DAY_MS > end) {
      break;
    }
  }
  return total;
}

/**
 * The instant `ms` of business time after `from`. With a calendar, a clock
 * that reaches 0 exactly at closing time is due at closing time.
 */
export function addBusinessMs(calendar: DeskSlaCalendar | null, from: Date, ms: number): Date {
  const start = from.getTime();
  if (ms <= 0) return new Date(start);
  if (!calendar) return new Date(start + ms);

  let remaining = ms;
  let day = localDayOf(start, calendar.timezone) - DAY_MS;
  for (let i = 0; i < MAX_DAYS; i++, day += DAY_MS) {
    const interval = openInterval(calendar, day);
    if (!interval) continue;
    const open = Math.max(interval[0], start);
    const close = interval[1];
    if (close <= open) continue;
    if (close - open >= remaining) return new Date(open + remaining);
    remaining -= close - open;
  }
  // Holidays closed every remaining day: fall back to wall-clock time.
  return new Date(start + ms);
}
