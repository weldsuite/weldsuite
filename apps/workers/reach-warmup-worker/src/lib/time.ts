/**
 * Time zones and business hours for the planner.
 *
 * A mailbox "works" in its own IANA zone: warmup sends fall between 09:00 and
 * 17:30 local time, Monday to Friday. All conversions go through
 * `Intl.DateTimeFormat`, so DST is handled by the runtime's tz database.
 */

import { MINUTE_MS, randomBetween, type Rng } from './random';

export const DEFAULT_TIMEZONE = 'Europe/Amsterdam';
/** 09:00 local, in minutes after midnight. */
export const BUSINESS_START_MINUTE = 9 * 60;
/** 17:30 local, in minutes after midnight. */
export const BUSINESS_END_MINUTE = 17 * 60 + 30;
export const BUSINESS_MINUTES = BUSINESS_END_MINUTE - BUSINESS_START_MINUTE;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** `timeZone` when it is a valid IANA zone, else the default (a bad value in the pool must not stop planning). */
export function safeTimeZone(timeZone: string): string {
  try {
    formatterFor(timeZone);
    return timeZone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** YYYY-MM-DD */
  date: string;
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function formatDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** Day of the week (0 = Sunday) of a calendar date. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Wall-clock parts of `at` in `timeZone`. */
export function localParts(at: Date, timeZone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(safeTimeZone(timeZone)).formatToParts(at)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const year = values.year ?? 1970;
  const month = values.month ?? 1;
  const day = values.day ?? 1;
  return {
    year,
    month,
    day,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
    date: formatDate(year, month, day),
    weekday: weekdayOf(year, month, day),
  };
}

/** YYYY-MM-DD of `at` in `timeZone`: what `plannedFor` is compared with. */
export function localDate(at: Date, timeZone: string): string {
  return localParts(at, timeZone).date;
}

export function isWeekday(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

/** Offset of `timeZone` from UTC at the instant `ts`, in ms (positive east of Greenwich). */
function offsetAt(ts: number, timeZone: string): number {
  const p = localParts(new Date(ts), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

/** The UTC instant at which the wall clock of `timeZone` shows `date` at `minuteOfDay`. */
export function zonedTimeToUtc(date: string, minuteOfDay: number, timeZone: string): Date {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  const naive = Date.UTC(year, month - 1, day, 0, minuteOfDay);
  // The offset depends on the instant being converted, so refine once (DST edges).
  const first = naive - offsetAt(naive, timeZone);
  return new Date(naive - offsetAt(first, timeZone));
}

/** The calendar date `days` after `date`. */
export function addDays(date: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return formatDate(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

export interface BusinessWindow {
  /** Local calendar date the window belongs to. */
  date: string;
  /** false on Saturday and Sunday. */
  businessDay: boolean;
  start: Date;
  end: Date;
}

/** Business hours of the local day `date` in `timeZone`. */
export function businessWindowOn(date: string, timeZone: string): BusinessWindow {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return {
    date,
    businessDay: isWeekday(weekdayOf(year, month, day)),
    start: zonedTimeToUtc(date, BUSINESS_START_MINUTE, timeZone),
    end: zonedTimeToUtc(date, BUSINESS_END_MINUTE, timeZone),
  };
}

/** Business hours of the local day `at` falls on. */
export function businessWindow(at: Date, timeZone: string): BusinessWindow {
  return businessWindowOn(localDate(at, timeZone), timeZone);
}

/** The first business day strictly after local date `date`. */
export function nextBusinessDate(date: string): string {
  let next = addDays(date, 1);
  for (let guard = 0; guard < 7; guard++) {
    const [year = 1970, month = 1, day = 1] = next.split('-').map(Number);
    if (isWeekday(weekdayOf(year, month, day))) break;
    next = addDays(next, 1);
  }
  return next;
}

/** Latest start, in minutes after opening, of a pushed-back reply. */
const PUSHED_REPLY_SPREAD_MINUTES = 90;

/**
 * Move `at` into the mailbox's business hours "where possible": inside the
 * window it stays; before opening it moves to the opening time (plus up to
 * 90 minutes); after closing or on a weekend it moves to the next business
 * day's opening (plus up to 90 minutes).
 */
export function intoBusinessHours(at: Date, timeZone: string, rng: Rng): Date {
  const window = businessWindow(at, timeZone);
  if (window.businessDay && at >= window.start && at <= window.end) return at;
  const spread = randomBetween(rng, 0, PUSHED_REPLY_SPREAD_MINUTES) * MINUTE_MS;
  if (window.businessDay && at < window.start) return new Date(window.start.getTime() + spread);
  const next = businessWindowOn(nextBusinessDate(window.date), timeZone);
  return new Date(next.start.getTime() + spread);
}
