/**
 * Date and time functions over Excel 1900 serials (see format/date.ts):
 * 1 is 1900-01-01, 60 the fictitious 1900-02-29, times are day fractions.
 *
 * Date arguments accept numbers and date/time text ("2024-01-15",
 * "1/15/2024", "15-Jan-2024", "Jan 15, 2024", "10:30 PM"), parsed by the
 * small private parser below.
 */

import {
  daysInMonth,
  isLeapYear,
  localSerial,
  serialFromUtcMs,
  weekdayFromSerial,
  ymdFromSerial,
  type YMD,
} from '../../format/date';
import { ERR, isError, parseNumericText, toNumber, type CellError, type EvalValue, type Scalar } from '../../values';
import type { EvalContext, FunctionSpec } from '../types';
import { bool, finite, int, num, toScalar, values2d } from './helpers';

/** 9999-12-31, the last date Excel accepts. */
const MAX_SERIAL = 2_958_465;

// ---------------------------------------------------------------------------
// Serial arithmetic
// ---------------------------------------------------------------------------

/** Serial of the first day of a month (month0 0-11, any year), on the Excel calendar. */
function firstOfMonth(year: number, month0: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month0, 1);
  return serialFromUtcMs(d.getTime());
}

/**
 * Serial for year/month/day without DATE's two-digit year rule: months and
 * days overflow, and counting days from the first of the month keeps
 * Excel's 1900-02-29 (DATE(1900,2,29) is 60, DATE(1900,3,0) too).
 */
function rawSerial(year: number, month: number, day: number): number {
  const months = year * 12 + (month - 1);
  const y = Math.floor(months / 12);
  return firstOfMonth(y, months - y * 12) + day - 1;
}

/** DATE semantics: years 0-1899 are 1900+year; NaN outside 1900-01-00 … 9999-12-31. */
function dateSerial(year: number, month: number, day: number): number {
  let y = Math.trunc(year);
  if (y < 0 || y > 9999) return NaN;
  if (y < 1900) y += 1900;
  const serial = rawSerial(y, Math.trunc(month), Math.trunc(day));
  return serial < 0 || serial > MAX_SERIAL ? NaN : serial;
}

/** Days in a month as Excel counts them: February 1900 has 29. */
function excelDaysInMonth(year: number, month: number): number {
  return year === 1900 && month === 2 ? 29 : daysInMonth(year, month);
}

/** Weekday 0 = Sunday … 6 = Saturday, safe for negative serials. */
function dow(serial: number): number {
  const whole = Math.floor(serial);
  return whole < 61 ? (((whole + 6) % 7) + 7) % 7 : weekdayFromSerial(whole);
}

// ---------------------------------------------------------------------------
// Date/time text
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** 1-12 for a month name or its abbreviation of 3+ letters ("Jan", "Sept"), else 0. */
function monthFromName(name: string): number {
  const l = name.toLowerCase().replace(/\.$/, '');
  if (l.length < 3) return 0;
  const i = MONTH_NAMES.findIndex((m) => m.startsWith(l));
  return i + 1;
}

function fullYear(text: string): number {
  const y = Number(text);
  if (text.length <= 2) return y < 30 ? 2000 + y : 1900 + y;
  return text.length === 4 ? y : NaN;
}

function validDate(y: number, m: number, d: number): number | null {
  if (!(y >= 1900 && y <= 9999) || m < 1 || m > 12 || d < 1 || d > excelDaysInMonth(y, m)) return null;
  return rawSerial(y, m, d);
}

/** "10:30", "10:30:15.5", "2:24 AM", "10 PM" → day fraction (may exceed 1 for "25:00"). */
function parseTimeText(s: string): number | null {
  let m = /^(\d{1,4}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?\s*([ap]m?)?$/i.exec(s);
  let h: number;
  let min = 0;
  let sec = 0;
  let ampm: string | undefined;
  if (m) {
    h = Number(m[1]);
    min = Number(m[2]);
    sec = m[3] === undefined ? 0 : Number(m[3]);
    ampm = m[4];
  } else {
    m = /^(\d{1,2})\s*([ap]m?)$/i.exec(s);
    if (!m) return null;
    h = Number(m[1]);
    ampm = m[2];
  }
  if (min >= 60 || sec >= 60) return null;
  if (ampm) {
    if (h > 12) return null;
    if (h === 12) h = 0;
    if (ampm[0]!.toLowerCase() === 'p') h += 12;
  }
  return (h * 3600 + min * 60 + sec) / 86_400;
}

/**
 * A date layout: `date` matches the date at the start of the text, `separator`
 * the characters allowed between it and a time, and `serial` reads the match.
 */
interface DateLayout {
  date: RegExp;
  separator: RegExp;
  serial(m: RegExpExecArray): number | null;
}

const SPACES = /^\s*/;

const DATE_LAYOUTS: readonly DateLayout[] = [
  // yyyy-mm-dd, the time after spaces or a T
  {
    date: /^(\d{4})-(\d{1,2})-(\d{1,2})/,
    separator: /^[T\s]*/i,
    serial: (m) => validDate(Number(m[1]), Number(m[2]), Number(m[3])),
  },
  // m/d/yyyy or yyyy/m/d
  {
    date: /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})/,
    separator: SPACES,
    serial: (m) => {
      const [a, b, c] = [m[1]!, m[2]!, m[3]!];
      return a.length === 4 ? validDate(Number(a), Number(b), Number(c)) : validDate(fullYear(c), Number(a), Number(b));
    },
  },
  // d-mmm-yyyy, d mmm yyyy
  {
    date: /^(\d{1,2})[-\s]([A-Za-z]{3,9}\.?)[-\s,]\s*(\d{2,4})/,
    separator: SPACES,
    serial: (m) => validDate(fullYear(m[3]!), monthFromName(m[2]!), Number(m[1])),
  },
  // mmm d, yyyy, mmm-d-yyyy
  {
    date: /^([A-Za-z]{3,9}\.?)[-\s](\d{1,2})(?:,\s*|\s+|-)(\d{2,4})/,
    separator: SPACES,
    serial: (m) => validDate(fullYear(m[3]!), monthFromName(m[1]!), Number(m[2])),
  },
];

/**
 * What follows a date: undefined when nothing does, else the time text after
 * one or more separator characters (which leave it at least one character), or
 * null when the text does not have that shape. The time may not span lines.
 */
function timeAfterDate(rest: string, separator: RegExp): string | null | undefined {
  if (rest === '') return undefined;
  const skip = separator.exec(rest)?.[0].length ?? 0;
  if (skip === 0) return null;
  const time = rest.slice(Math.min(skip, rest.length - 1));
  return /[\n\r\u2028\u2029]/.test(time) ? null : time;
}

/**
 * Parses date and/or time text to a serial: ISO yyyy-mm-dd, m/d/yyyy,
 * yyyy/m/d, d-mmm-yyyy, mmm d, yyyy, each optionally followed by a time, or a
 * time alone. Null when the text is none of these.
 */
function parseDateTimeText(input: string): number | null {
  const s = input.trim();
  if (s === '') return null;
  const time = parseTimeText(s);
  if (time !== null) return time;
  for (const layout of DATE_LAYOUTS) {
    const m = layout.date.exec(s);
    const rest = m ? timeAfterDate(s.slice(m[0].length), layout.separator) : null;
    if (!m || rest === null) continue;
    const date = layout.serial(m);
    if (date === null) return null;
    if (rest === undefined) return date;
    const t = parseTimeText(rest.trim());
    return t === null ? null : date + t;
  }
  return null;
}

/** A date/time argument: numbers as they are, text parsed as a number or a date. */
function serialArg(v: EvalValue, ctx: EvalContext): number | CellError {
  const s = toScalar(v, ctx);
  if (typeof s === 'string') {
    const n = parseNumericText(s);
    if (n !== null) return n;
    const d = parseDateTimeText(s);
    return d === null ? ERR.value : d;
  }
  return toNumber(s);
}

/** A date argument within Excel's calendar (#NUM! outside 0 … 9999-12-31). */
function dateArg(v: EvalValue, ctx: EvalContext): number | CellError {
  const n = serialArg(v, ctx);
  if (isError(n)) return n;
  return n < 0 || n >= MAX_SERIAL + 1 ? ERR.num : n;
}

/** Whole-day date argument. */
function dayArg(v: EvalValue, ctx: EvalContext): number | CellError {
  const n = dateArg(v, ctx);
  return isError(n) ? n : Math.floor(n);
}

function optInt(args: EvalValue[], i: number, fallback: number, ctx: EvalContext): number | CellError {
  const v = args[i];
  return v === undefined || v === null ? fallback : int(v, ctx);
}

/** Result guard: a serial outside the calendar is #NUM!. */
function serialResult(n: number): number | CellError {
  return Number.isFinite(n) && n >= 0 && n <= MAX_SERIAL ? n : ERR.num;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** Time of day rounded to the second, as HOUR/MINUTE/SECOND see it. */
function clock(serial: number): { h: number; m: number; s: number } {
  let secs = Math.round((serial - Math.floor(serial)) * 86_400);
  if (secs >= 86_400) secs -= 86_400;
  return { h: Math.floor(secs / 3600), m: Math.floor((secs % 3600) / 60), s: secs % 60 };
}

/** WEEKDAY numbering: 1/17 Sunday = 1, 2/11 Monday = 1, 3 Monday = 0, 12-16 Tuesday … Saturday = 1. */
function weekdayNumber(serial: number, type: number): number | CellError {
  const wd = dow(serial);
  switch (type) {
    case 1:
    case 17:
      return wd + 1;
    case 2:
    case 11:
      return ((wd + 6) % 7) + 1;
    case 3:
      return (wd + 6) % 7;
    case 12:
    case 13:
    case 14:
    case 15:
    case 16:
      return ((wd - (type - 10) + 7) % 7) + 1;
    default:
      return ERR.num;
  }
}

/** ISO 8601 week number: weeks start on Monday, week 1 holds the year's first Thursday. */
function isoWeek(serial: number): number {
  const s = Math.floor(serial);
  const thursday = s - ((dow(s) + 6) % 7) + 3;
  const year = ymdFromSerial(thursday).year;
  return Math.floor((thursday - firstOfMonth(year, 0)) / 7) + 1;
}

/** WEEKNUM return type → first day of the week (0 = Sunday); 21 is ISO. */
const WEEK_START: Record<number, number> = { 1: 0, 2: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 0 };

function weekNum(serial: number, type: number): number | CellError {
  if (type === 21) return isoWeek(serial);
  const start = WEEK_START[type];
  if (start === undefined) return ERR.num;
  const s = Math.floor(serial);
  const jan1 = firstOfMonth(ymdFromSerial(s).year, 0);
  const offset = (dow(jan1) - start + 7) % 7;
  return Math.floor((s - jan1 + offset) / 7) + 1;
}

/** EDATE/EOMONTH month shift; `end` gives the last day of the target month. */
function shiftMonths(serial: number, months: number, end: boolean): number | CellError {
  const { year, month, day } = ymdFromSerial(serial);
  const total = year * 12 + month - 1 + Math.trunc(months);
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  if (y < 1900 || y > 9999) return ERR.num;
  const d = end ? excelDaysInMonth(y, m) : Math.min(day, excelDaysInMonth(y, m));
  return serialResult(rawSerial(y, m, d));
}

function datedif(start: number, end: number, unit: string): number | CellError {
  if (start > end) return ERR.num;
  const a = ymdFromSerial(start);
  const b = ymdFromSerial(end);
  switch (unit.toUpperCase()) {
    case 'Y':
      return b.year - a.year - (b.month < a.month || (b.month === a.month && b.day < a.day) ? 1 : 0);
    case 'M':
      return (b.year - a.year) * 12 + b.month - a.month - (b.day < a.day ? 1 : 0);
    case 'D':
      return end - start;
    case 'MD':
      // Excel's own algorithm, quirks included: DATEDIF(1/31/2015, 3/1/2015, "MD") is -2.
      return b.day >= a.day ? b.day - a.day : end - rawSerial(b.year, b.month - 1, a.day);
    case 'YM':
      return (b.month - a.month - (b.day < a.day ? 1 : 0) + 12) % 12;
    case 'YD': {
      let anniversary = rawSerial(b.year, a.month, a.day);
      if (anniversary > end) anniversary = rawSerial(b.year - 1, a.month, a.day);
      return end - anniversary;
    }
    default:
      return ERR.num;
  }
}

function isLastOfFebruary(y: number, m: number, d: number): boolean {
  return m === 2 && d === (isLeapYear(y) ? 29 : 28);
}

/** Days from day d1 of a's month to day d2 of b's month on a calendar of 30-day months. */
function diff360(a: YMD, d1: number, b: YMD, d2: number): number {
  return (b.year - a.year) * 360 + (b.month - a.month) * 30 + d2 - d1;
}

/** DAYS360: US (NASD) method by default, European when `european`. */
function days360(start: number, end: number, european: boolean): number {
  const a = ymdFromSerial(start);
  const b = ymdFromSerial(end);
  if (european) return diff360(a, Math.min(a.day, 30), b, Math.min(b.day, 30));
  const d1 = a.day === 31 || isLastOfFebruary(a.year, a.month, a.day) ? 30 : a.day;
  if (b.day !== 31) return diff360(a, d1, b, b.day);
  if (d1 === 30) return diff360(a, d1, b, 30);
  // Otherwise an end on the 31st moves to the 1st of the next month, 30 days past the 1st of its own.
  return diff360(a, d1, b, 1) + 30;
}

/** YEARFRAC basis 0: 30/360 with Excel's US end-of-month rules, which differ from DAYS360's. */
function yearFrac30(a: YMD, b: YMD): number {
  const startLastOfFeb = isLastOfFebruary(a.year, a.month, a.day);
  const bothLastOfFeb = startLastOfFeb && isLastOfFebruary(b.year, b.month, b.day);
  const d1 = a.day === 31 || startLastOfFeb ? 30 : a.day;
  const d2 = (b.day === 31 && a.day >= 30) || bothLastOfFeb ? 30 : b.day;
  return diff360(a, d1, b, d2) / 360;
}

/** True when b is in a's year, or in the next year on or before a's anniversary. */
function withinAYear(a: YMD, b: YMD): boolean {
  if (a.year === b.year) return true;
  if (a.year + 1 !== b.year) return false;
  return a.month > b.month || (a.month === b.month && a.day >= b.day);
}

/** YEARFRAC basis 1: actual/actual, over the average length of the years spanned past one year. */
function yearFracActual(s: number, e: number, a: YMD, b: YMD): number {
  if (withinAYear(a, b)) {
    const leap =
      (a.year === b.year && isLeapYear(a.year)) ||
      feb29Between(s, e, a.year, b.year) ||
      (b.month === 2 && b.day === 29);
    return (e - s) / (leap ? 366 : 365);
  }
  const years = b.year - a.year + 1;
  const average = (firstOfMonth(b.year + 1, 0) - firstOfMonth(a.year, 0)) / years;
  return (e - s) / average;
}

/** YEARFRAC, following Excel's per-basis rules (30/360 US, actual/actual, actual/360, actual/365, 30/360 EU). */
function yearFrac(s0: number, e0: number, basis: number): number | CellError {
  const s = Math.min(s0, e0);
  const e = Math.max(s0, e0);
  const a = ymdFromSerial(s);
  const b = ymdFromSerial(e);
  switch (basis) {
    case 0:
      return yearFrac30(a, b);
    case 1:
      return yearFracActual(s, e, a, b);
    case 2:
      return (e - s) / 360;
    case 3:
      return (e - s) / 365;
    case 4:
      return diff360(a, Math.min(a.day, 30), b, Math.min(b.day, 30)) / 360;
    default:
      return ERR.num;
  }
}

function feb29Between(s: number, e: number, y1: number, y2: number): boolean {
  const mar1a = firstOfMonth(y1, 2);
  if (isLeapYear(y1) && s < mar1a && e >= mar1a) return true;
  const mar1b = firstOfMonth(y2, 2);
  return isLeapYear(y2) && e >= mar1b && s < mar1b;
}

// ---------------------------------------------------------------------------
// Working days
// ---------------------------------------------------------------------------

/** Weekend days indexed by weekday (0 = Sunday); true is a weekend day. */
type Weekend = boolean[];

/** NETWORKDAYS.INTL / WORKDAY.INTL weekend argument: a code 1-7, 11-17, or a "0000011" mask (Monday first). */
function weekendArg(v: EvalValue | undefined, ctx: EvalContext): Weekend | CellError {
  const days: Weekend = new Array<boolean>(7).fill(false);
  if (v === undefined || v === null) {
    days[0] = days[6] = true;
    return days;
  }
  const s = toScalar(v, ctx);
  if (isError(s)) return s;
  if (typeof s === 'string') {
    if (!/^[01]{7}$/.test(s) || s === '1111111') return ERR.value;
    for (let i = 0; i < 7; i++) days[(i + 1) % 7] = s[i] === '1';
    return days;
  }
  const n = toNumber(s);
  if (isError(n)) return n;
  const code = Math.trunc(n);
  if (code >= 1 && code <= 7) {
    days[(code + 5) % 7] = days[(code + 6) % 7] = true;
  } else if (code >= 11 && code <= 17) {
    days[code - 11] = true;
  } else {
    return ERR.num;
  }
  return days;
}

/** Holiday serials (whole days, sorted, unique) from a range, array or single value. */
function holidaysArg(v: EvalValue | undefined, ctx: EvalContext): number[] | CellError {
  if (v === undefined || v === null) return [];
  const data = values2d(v, ctx);
  if (isError(data)) return data;
  const out = new Set<number>();
  for (const row of data) {
    for (const x of row) {
      const day = holidayDay(x, ctx);
      if (isError(day)) return day;
      if (day !== null) out.add(day);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** One holiday entry as a whole-day serial; null for a blank, which is skipped. */
function holidayDay(x: Scalar, ctx: EvalContext): number | null | CellError {
  if (x === null) return null;
  if (typeof x === 'boolean') return ERR.value;
  const n = serialArg(x, ctx);
  if (isError(n)) return n;
  return n < 0 ? ERR.num : Math.floor(n);
}

class WorkCalendar {
  private readonly perWeek: number;
  /** Holidays that fall on working days, sorted. */
  private readonly holidays: number[];

  constructor(
    private readonly weekend: Weekend,
    holidays: number[],
  ) {
    this.perWeek = weekend.filter((w) => !w).length;
    this.holidays = holidays.filter((h) => !weekend[dow(h)]);
  }

  get valid(): boolean {
    return this.perWeek > 0;
  }

  /** Index of the first holiday >= x. */
  private holidayIndex(x: number): number {
    let lo = 0;
    let hi = this.holidays.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.holidays[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Working days in [a, b], both whole serials, a <= b. */
  count(a: number, b: number): number {
    const days = b - a + 1;
    const weeks = Math.floor(days / 7);
    let n = weeks * this.perWeek;
    for (let s = a + weeks * 7; s <= b; s++) if (!this.weekend[dow(s)]) n++;
    return n - (this.holidayIndex(b + 1) - this.holidayIndex(a));
  }

  /** The working day `days` working days after (or before, when negative) `start`. */
  shift(start: number, days: number): number {
    if (days === 0) return start;
    const steps = Math.abs(days);
    // Each 7-day stretch holds perWeek working days and each holiday costs at most a week.
    const span = (Math.ceil(steps / this.perWeek) + this.holidays.length + 1) * 7;
    if (days > 0) {
      let lo = start + 1;
      let hi = start + span;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (this.count(start + 1, mid) >= steps) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }
    let lo = start - span;
    let hi = start - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.count(mid, start - 1) >= steps) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

function networkDays(args: EvalValue[], ctx: EvalContext, intl: boolean): EvalValue {
  const start = dayArg(args[0]!, ctx);
  if (isError(start)) return start;
  const end = dayArg(args[1]!, ctx);
  if (isError(end)) return end;
  const weekend = intl ? weekendArg(args[2], ctx) : weekendArg(undefined, ctx);
  if (isError(weekend)) return weekend;
  const holidays = holidaysArg(args[intl ? 3 : 2], ctx);
  if (isError(holidays)) return holidays;
  const cal = new WorkCalendar(weekend, holidays);
  return start <= end ? cal.count(start, end) : -cal.count(end, start);
}

function workDay(args: EvalValue[], ctx: EvalContext, intl: boolean): EvalValue {
  const start = dayArg(args[0]!, ctx);
  if (isError(start)) return start;
  const days = num(args[1]!, ctx);
  if (isError(days)) return days;
  const weekend = intl ? weekendArg(args[2], ctx) : weekendArg(undefined, ctx);
  if (isError(weekend)) return weekend;
  const holidays = holidaysArg(args[intl ? 3 : 2], ctx);
  if (isError(holidays)) return holidays;
  const cal = new WorkCalendar(weekend, holidays);
  if (!cal.valid) return ERR.value;
  return serialResult(cal.shift(start, Math.trunc(days)));
}

// ---------------------------------------------------------------------------
// Registry entries
// ---------------------------------------------------------------------------

/** YEAR/MONTH/DAY-style accessor over a date argument. */
function datePart(name: string, pick: (serial: number) => number): FunctionSpec {
  return {
    name,
    minArgs: 1,
    maxArgs: 1,
    scalarArgs: 'all',
    impl: ([v], ctx) => {
      const s = dateArg(v!, ctx);
      return isError(s) ? s : pick(s);
    },
  };
}

export const datetimeFunctions: FunctionSpec[] = [
  {
    name: 'DATE',
    minArgs: 3,
    maxArgs: 3,
    scalarArgs: 'all',
    impl: ([y, m, d], ctx) => {
      const year = num(y!, ctx);
      if (isError(year)) return year;
      const month = num(m!, ctx);
      if (isError(month)) return month;
      const day = num(d!, ctx);
      if (isError(day)) return day;
      return finite(dateSerial(year, month, day));
    },
  },
  {
    name: 'TIME',
    minArgs: 3,
    maxArgs: 3,
    scalarArgs: 'all',
    impl: ([h, m, s], ctx) => {
      const parts: number[] = [];
      for (const v of [h!, m!, s!]) {
        const n = int(v, ctx);
        if (isError(n)) return n;
        if (n > 32_767) return ERR.num;
        parts.push(n);
      }
      const total = parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
      if (total < 0) return ERR.num;
      return (total % 86_400) / 86_400;
    },
  },
  {
    name: 'TODAY',
    minArgs: 0,
    maxArgs: 0,
    volatile: true,
    impl: (_args, ctx) => Math.floor(localSerial(ctx.host.now(), ctx.host.timezoneOffset())),
  },
  {
    name: 'NOW',
    minArgs: 0,
    maxArgs: 0,
    volatile: true,
    impl: (_args, ctx) => localSerial(ctx.host.now(), ctx.host.timezoneOffset()),
  },
  datePart('YEAR', (s) => ymdFromSerial(s).year),
  datePart('MONTH', (s) => ymdFromSerial(s).month),
  datePart('DAY', (s) => ymdFromSerial(s).day),
  datePart('HOUR', (s) => clock(s).h),
  datePart('MINUTE', (s) => clock(s).m),
  datePart('SECOND', (s) => clock(s).s),
  datePart('ISOWEEKNUM', isoWeek),
  {
    name: 'WEEKDAY',
    minArgs: 1,
    maxArgs: 2,
    scalarArgs: 'all',
    impl: (args, ctx) => {
      const s = dateArg(args[0]!, ctx);
      if (isError(s)) return s;
      const type = optInt(args, 1, 1, ctx);
      return isError(type) ? type : weekdayNumber(s, type);
    },
  },
  {
    name: 'WEEKNUM',
    minArgs: 1,
    maxArgs: 2,
    scalarArgs: 'all',
    impl: (args, ctx) => {
      const s = dateArg(args[0]!, ctx);
      if (isError(s)) return s;
      const type = optInt(args, 1, 1, ctx);
      return isError(type) ? type : weekNum(s, type);
    },
  },
  {
    name: 'EDATE',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: 'all',
    impl: ([d, n], ctx) => {
      const s = dayArg(d!, ctx);
      if (isError(s)) return s;
      const months = num(n!, ctx);
      return isError(months) ? months : shiftMonths(s, months, false);
    },
  },
  {
    name: 'EOMONTH',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: 'all',
    impl: ([d, n], ctx) => {
      const s = dayArg(d!, ctx);
      if (isError(s)) return s;
      const months = num(n!, ctx);
      return isError(months) ? months : shiftMonths(s, months, true);
    },
  },
  {
    name: 'DATEDIF',
    minArgs: 3,
    maxArgs: 3,
    scalarArgs: 'all',
    impl: ([a, b, u], ctx) => {
      const start = dayArg(a!, ctx);
      if (isError(start)) return start;
      const end = dayArg(b!, ctx);
      if (isError(end)) return end;
      const unit = toScalar(u!, ctx);
      if (isError(unit)) return unit;
      return typeof unit === 'string' ? datedif(start, end, unit) : ERR.num;
    },
  },
  {
    name: 'DAYS',
    minArgs: 2,
    maxArgs: 2,
    scalarArgs: 'all',
    impl: ([e, s], ctx) => {
      const end = dayArg(e!, ctx);
      if (isError(end)) return end;
      const start = dayArg(s!, ctx);
      return isError(start) ? start : end - start;
    },
  },
  {
    name: 'DAYS360',
    minArgs: 2,
    maxArgs: 3,
    scalarArgs: 'all',
    impl: (args, ctx) => {
      const start = dayArg(args[0]!, ctx);
      if (isError(start)) return start;
      const end = dayArg(args[1]!, ctx);
      if (isError(end)) return end;
      const european = args[2] === undefined || args[2] === null ? false : bool(args[2], ctx);
      return isError(european) ? european : days360(start, end, european);
    },
  },
  {
    name: 'DATEVALUE',
    minArgs: 1,
    maxArgs: 1,
    scalarArgs: 'all',
    impl: ([v], ctx) => {
      const s = toScalar(v!, ctx);
      if (isError(s)) return s;
      if (typeof s !== 'string') return ERR.value;
      const d = parseDateTimeText(s);
      return d === null ? ERR.value : Math.floor(d);
    },
  },
  {
    name: 'TIMEVALUE',
    minArgs: 1,
    maxArgs: 1,
    scalarArgs: 'all',
    impl: ([v], ctx) => {
      const s = toScalar(v!, ctx);
      if (isError(s)) return s;
      if (typeof s !== 'string') return ERR.value;
      const d = parseDateTimeText(s);
      return d === null ? ERR.value : d - Math.floor(d);
    },
  },
  { name: 'NETWORKDAYS', minArgs: 2, maxArgs: 3, scalarArgs: [0, 1], impl: (a, ctx) => networkDays(a, ctx, false) },
  {
    name: 'NETWORKDAYS.INTL',
    minArgs: 2,
    maxArgs: 4,
    scalarArgs: [0, 1, 2],
    impl: (a, ctx) => networkDays(a, ctx, true),
  },
  { name: 'WORKDAY', minArgs: 2, maxArgs: 3, scalarArgs: [0, 1], impl: (a, ctx) => workDay(a, ctx, false) },
  { name: 'WORKDAY.INTL', minArgs: 2, maxArgs: 4, scalarArgs: [0, 1, 2], impl: (a, ctx) => workDay(a, ctx, true) },
  {
    name: 'YEARFRAC',
    minArgs: 2,
    maxArgs: 3,
    scalarArgs: 'all',
    impl: (args, ctx) => {
      const start = dayArg(args[0]!, ctx);
      if (isError(start)) return start;
      const end = dayArg(args[1]!, ctx);
      if (isError(end)) return end;
      const basis = optInt(args, 2, 0, ctx);
      if (isError(basis)) return basis;
      const r = yearFrac(start, end, basis);
      return isError(r) ? r : finite(r);
    },
  },
];

