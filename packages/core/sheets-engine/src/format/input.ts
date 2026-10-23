/**
 * What a typed cell entry means: a formula, a literal value, or a value plus
 * the number format Excel would apply ("12%" → 0.12 shown as "0%",
 * "15-01-2026" → a date serial shown as "dd-mm-yyyy").
 */

import { err, isErrorCode, type Scalar } from '../values';
import { daysInMonth, serialFromYMD } from './date';
import { EN_LOCALE, type FormatLocale } from './number-format';

export type ParsedInput = { kind: 'formula'; formula: string } | { kind: 'value'; value: Scalar; numFmt?: string };

export interface ParseInputOptions {
  locale?: FormatLocale;
  /** Order of numeric dates such as 1/2/2026. Defaults to the locale's, else month first. */
  dateOrder?: 'mdy' | 'dmy' | 'ymd';
  /** Year for dates typed without one ("15 jan"). Defaults to the current year. */
  currentYear?: number;
}

type Order = 'mdy' | 'dmy' | 'ymd';

interface Parsed {
  value: number;
  numFmt?: string;
}

export function parseInput(text: string, opts: ParseInputOptions = {}): ParsedInput {
  if (text === '') return { kind: 'value', value: null };
  if (text[0] === '=' && text.length > 1) return { kind: 'formula', formula: text.slice(1) };
  if (text[0] === "'") return { kind: 'value', value: text.slice(1) };

  const s = text.trim();
  if (s === '') return { kind: 'value', value: text };
  const upper = s.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return { kind: 'value', value: upper === 'TRUE' };
  if (isErrorCode(upper)) return { kind: 'value', value: err(upper) };

  const locale = opts.locale ?? EN_LOCALE;
  const order = opts.dateOrder ?? locale.dateOrder ?? 'mdy';
  const parsed =
    parseNumber(s, locale) ??
    parseFraction(s) ??
    parseDateTime(s, locale, order, opts.currentYear ?? new Date().getFullYear());
  if (parsed) {
    return parsed.numFmt === undefined
      ? { kind: 'value', value: parsed.value }
      : { kind: 'value', value: parsed.value, numFmt: parsed.numFmt };
  }
  return { kind: 'value', value: text };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const CURRENCY = '$€£¥₹';
const coreCache = new Map<string, RegExp>();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Digits with the locale's group (in threes) and decimal separators, optional exponent. */
function coreRe(locale: FormatLocale): RegExp {
  const key = locale.decimal + locale.group;
  let re = coreCache.get(key);
  if (!re) {
    const g = escapeRe(locale.group);
    const d = escapeRe(locale.decimal);
    re = new RegExp(`^(\\d{1,3}(?:${g}\\d{3})+|\\d+)?(?:${d}(\\d*))?(?:[eE]([+-]?\\d+))?$`);
    coreCache.set(key, re);
  }
  return re;
}

/** What surrounds the digits of a typed number. */
interface NumberAffixes {
  /** '-', '+' or ''. */
  sign: string;
  /** Accounting negative: "(5)". */
  paren: boolean;
  /** Currency symbol, '' for none. */
  currency: string;
  /** The symbol comes before the digits ("$5") rather than after ("5 €"). */
  before: boolean;
  /** Whitespace separates the symbol from the digits. */
  spaced: boolean;
  percent: boolean;
}

const PRE_CURRENCY_RE = new RegExp(`^([${CURRENCY}])(\\s*)`);
const POST_CURRENCY_RE = new RegExp(`(\\s*)([${CURRENCY}])$`);

function parseNumber(input: string, locale: FormatLocale): Parsed | null {
  const stripped = stripAffixes(input);
  if (!stripped) return null;
  const { body, affixes } = stripped;

  const m = coreRe(locale).exec(body);
  if (!m) return null;
  const intPart = m[1] ?? '';
  const fracPart = m[2] ?? '';
  if (intPart === '' && fracPart === '') return null;
  const digits = intPart.split(locale.group).join('');
  const magnitude = Number(`${digits || '0'}.${fracPart || '0'}e${m[3] ?? '0'}`);
  if (!Number.isFinite(magnitude)) return null;

  const numFmt = typedNumberFormat(affixes, m[3] !== undefined, fracPart.length > 0, intPart.includes(locale.group));
  return { value: signedValue(magnitude, affixes), numFmt };
}

/**
 * Splits parentheses, sign, currency symbol and percent sign off a typed
 * number. Null for combinations Excel does not read as a number: a sign
 * inside parentheses, or a percentage with a currency.
 */
function stripAffixes(input: string): { body: string; affixes: NumberAffixes } | null {
  const affixes: NumberAffixes = { sign: '', paren: false, currency: '', before: false, spaced: false, percent: false };
  let t = input;
  if (t.startsWith('(') && t.endsWith(')')) {
    affixes.paren = true;
    t = t.slice(1, -1).trim();
  }
  t = takeCurrency(takeSign(t, affixes), affixes);
  if (t.endsWith('%')) {
    affixes.percent = true;
    t = t.slice(0, -1).trim();
  }
  if ((affixes.paren && affixes.sign) || (affixes.percent && affixes.currency)) return null;
  return { body: t, affixes };
}

/** Moves a leading + or - of `t` into `affixes.sign`, unless a sign was taken already. */
function takeSign(t: string, affixes: NumberAffixes): string {
  if (affixes.sign || (t[0] !== '-' && t[0] !== '+')) return t;
  affixes.sign = t[0];
  return t.slice(1).trim();
}

/** Moves a currency symbol at either end of `t` into `affixes`; a sign may follow a leading one ("$-5"). */
function takeCurrency(t: string, affixes: NumberAffixes): string {
  const pre = PRE_CURRENCY_RE.exec(t);
  if (pre) {
    affixes.currency = pre[1]!;
    affixes.before = true;
    affixes.spaced = pre[2] !== '';
    return takeSign(t.slice(pre[0].length), affixes);
  }
  const post = POST_CURRENCY_RE.exec(t);
  if (!post) return t;
  affixes.currency = post[2]!;
  affixes.spaced = post[1] !== '';
  return t.slice(0, -post[0].length);
}

/** Applies the percent sign and a minus (or accounting parentheses) to a typed magnitude. */
function signedValue(magnitude: number, affixes: NumberAffixes): number {
  let value = affixes.percent ? magnitude / 100 : magnitude;
  if (affixes.paren || affixes.sign === '-') value = -value;
  return value === 0 ? 0 : value; // no -0
}

/** The format Excel gives a typed number: scientific, percent, currency, thousands separators or none. */
function typedNumberFormat(
  affixes: NumberAffixes,
  exponent: boolean,
  decimals: boolean,
  grouped: boolean,
): string | undefined {
  if (exponent) return '0.00E+00';
  if (affixes.percent) return decimals ? '0.00%' : '0%';
  if (affixes.currency) return currencyFormat(affixes, decimals ? '#,##0.00' : '#,##0');
  if (grouped) return decimals ? '#,##0.00' : '#,##0';
  return undefined;
}

/** `"$"#,##0` or `#,##0" €"`: the symbol on the side and with the spacing it was typed. */
function currencyFormat(affixes: NumberAffixes, body: string): string {
  const { currency, before, spaced } = affixes;
  if (before) return spaced ? `"${currency} "${body}` : `"${currency}"${body}`;
  return spaced ? `${body}" ${currency}"` : `${body}"${currency}"`;
}

/** Mixed fractions: "1 1/2" → 1.5 shown as "# ?/?". A bare "1/2" is a date, as in Excel. */
function parseFraction(s: string): Parsed | null {
  const m = /^([+-]?)(\d+)\s+(\d+)\/(\d+)$/.exec(s);
  if (!m) return null;
  const den = Number(m[4]);
  const num = Number(m[3]);
  if (den === 0 || num >= den) return null;
  const value = (Number(m[2]) + num / den) * (m[1] === '-' ? -1 : 1);
  const width = Math.min(String(den).length, 3);
  return { value, numFmt: `# ${'?'.repeat(width)}/${'?'.repeat(width)}` };
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

/** h:mm with optional :ss and a fraction of a second; whatever follows must be an am/pm marker. */
const CLOCK_RE = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})([.,]\d{1,3})?)?/;
/** The rest of a clock time: an am/pm marker ("pm", "p.m.", "a"). */
const MERIDIEM_RE = /^\s*([ap])\.?(?:m\.?)?$/i;
const HOUR_AMPM_RE = /^(\d{1,2})\s*([ap])\.?(?:m\.?)?$/i;

/** A typed time before it is checked and converted to a day fraction. */
interface Clock {
  h: number;
  mi: number;
  se: number;
  /** 'a' or 'p' when an am/pm marker was typed. */
  ap: string | undefined;
  fmt: string;
}

function parseTime(s: string): Parsed | null {
  const clock = readClock(s) ?? readHourAmPm(s);
  if (!clock) return null;
  const { mi, se, ap } = clock;
  if (mi >= 60 || se >= 60) return null;
  let h = clock.h;
  if (ap) {
    if (h > 12) return null;
    h = (h % 12) + (ap === 'p' ? 12 : 0);
  }
  return { value: (h * 3600 + mi * 60 + se) / 86_400, numFmt: clock.fmt };
}

/** "9:30", "9:30:15.25", "21:30", "9:30 pm". */
function readClock(s: string): Clock | null {
  const m = CLOCK_RE.exec(s);
  if (!m) return null;
  let ap: string | undefined;
  const rest = s.slice(m[0].length);
  if (rest !== '') {
    const marker = MERIDIEM_RE.exec(rest);
    if (!marker) return null;
    ap = marker[1]!.toLowerCase();
  }
  const h = Number(m[1]);
  const seconds = m[3];
  const fraction = m[4] ?? ''; // separator included: ".25"
  let se = 0;
  let secs = '';
  if (seconds !== undefined) {
    se = Number(seconds) + (fraction ? Number(`0.${fraction.slice(1)}`) : 0);
    secs = fraction ? `:ss.${'0'.repeat(fraction.length - 1)}` : ':ss';
  }
  let fmt: string;
  if (ap) fmt = `h:mm${secs} AM/PM`;
  else fmt = h >= 24 ? `[h]:mm${secs}` : `h:mm${secs}`;
  return { h, mi: Number(m[2]), se, ap, fmt };
}

/** "9 pm", "9a". */
function readHourAmPm(s: string): Clock | null {
  const hm = HOUR_AMPM_RE.exec(s);
  if (!hm) return null;
  return { h: Number(hm[1]), mi: 0, se: 0, ap: hm[2]!.toLowerCase(), fmt: 'h AM/PM' };
}

function fullYear(typed: string): number {
  const y = Number(typed);
  if (typed.length > 2) return y;
  return y < 30 ? 2000 + y : 1900 + y;
}

/** Serial of a calendar date, or null when it does not exist. 1900-02-29 is Excel's serial 60. */
function serialOf(y: number, m: number, d: number): number | null {
  if (y < 1900 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  if (y === 1900 && m === 2 && d === 29) return 60;
  if (d > daysInMonth(y, m)) return null;
  const serial = serialFromYMD(y, m, d);
  return Number.isNaN(serial) ? null : serial;
}

function monthIndex(token: string, locale: FormatLocale): { month: number; long: boolean } | null {
  const t = token.toLowerCase();
  if (t.length < 3) return null;
  for (const loc of locale === EN_LOCALE ? [locale] : [locale, EN_LOCALE]) {
    for (let i = 0; i < 12; i++) {
      const full = loc.monthNames[i]!.toLowerCase();
      const short = loc.monthShort[i]!.toLowerCase();
      if (t === short) return { month: i + 1, long: false };
      if (full.startsWith(t)) return { month: i + 1, long: t === full };
    }
  }
  return null;
}

function isDayName(token: string, locale: FormatLocale): boolean {
  const t = token.toLowerCase();
  return [locale, EN_LOCALE].some(
    (loc) => loc.dayNames.some((d) => d.toLowerCase() === t) || loc.dayShort.some((d) => d.toLowerCase() === t),
  );
}

/** A date result, or null when the date does not exist. */
function dateResult(serial: number | null, numFmt: string): Parsed | null {
  return serial === null ? null : { value: serial, numFmt };
}

/** 'yy' or 'yyyy', as the year was typed. */
function yearCode(typed: string): string {
  return typed.length <= 2 ? 'yy' : 'yyyy';
}

const ISO_DATE_RE = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
const THREE_PART_DATE_RE = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})$/;
const TWO_PART_DATE_RE = /^(\d{1,2})([-/])(\d{1,2})$/;

/**
 * ISO dates start with four digits and the other two shapes differ in their
 * number of separators, so at most one of the three can match.
 */
function numericDate(s: string, order: Order, currentYear: number): Parsed | null {
  return isoDate(s) ?? threePartDate(s, order) ?? twoPartDate(s, order, currentYear);
}

/** 2026-01-15, 2026/1/5. */
function isoDate(s: string): Parsed | null {
  const iso = ISO_DATE_RE.exec(s);
  if (!iso) return null;
  const [, y = '', sep = '', mo = '', d = ''] = iso;
  const padded = mo.length === 2 || d.length === 2;
  return dateResult(
    serialOf(Number(y), Number(mo), Number(d)),
    padded ? `yyyy${sep}mm${sep}dd` : `yyyy${sep}m${sep}d`,
  );
}

function isZeroPadded(part: string): boolean {
  return part.length === 2 && part[0] === '0';
}

/** 15-01-2026, 1/15/26, or 26.01.15 when the order is ymd. */
function threePartDate(s: string, order: Order): Parsed | null {
  const three = THREE_PART_DATE_RE.exec(s);
  if (!three) return null;
  const [, a = '', sep = '', b = '', c = ''] = three;
  const padded = isZeroPadded(a) || isZeroPadded(b);
  const d = padded ? 'dd' : 'd';
  const m = padded ? 'mm' : 'm';
  if (order === 'ymd') {
    return dateResult(serialOf(fullYear(a), Number(b), Number(c)), `${yearCode(a)}${sep}${m}${sep}${d}`);
  }

  // Try the configured order first, then the other one ("15-01-2026" in a US sheet).
  const y = fullYear(c);
  const yFmt = yearCode(c);
  const mdy = dateResult(serialOf(y, Number(a), Number(b)), `${m}${sep}${d}${sep}${yFmt}`);
  const dmy = dateResult(serialOf(y, Number(b), Number(a)), `${d}${sep}${m}${sep}${yFmt}`);
  return order === 'dmy' ? (dmy ?? mdy) : (mdy ?? dmy);
}

/** 15/1 or 1-15: a day in the current year, in the configured order first. */
function twoPartDate(s: string, order: Order, currentYear: number): Parsed | null {
  const two = TWO_PART_DATE_RE.exec(s);
  if (!two) return null;
  const a = Number(two[1]);
  const b = Number(two[3]);
  const mdy = serialOf(currentYear, a, b);
  const dmy = serialOf(currentYear, b, a);
  return dateResult(order === 'dmy' ? (dmy ?? mdy) : (mdy ?? dmy), 'd-mmm');
}

/** The two or three words of a named date ("15 jan 2026"), a leading day name dropped. */
type DateWords = readonly [string, string, string | undefined];

function dateWords(s: string, locale: FormatLocale): DateWords | null {
  let tokens = s.split(/[\s,./-]+/).filter((t) => t !== '');
  if (tokens.length > 0 && isDayName(tokens[0]!, locale)) tokens = tokens.slice(1);
  if (tokens.length < 2 || tokens.length > 3) return null;
  return [tokens[0]!, tokens[1]!, tokens[2]];
}

function isDigits(t: string): boolean {
  return /^\d+$/.test(t);
}

/** A day of the month: one or two digits. */
function isDayWord(t: string): boolean {
  return t.length <= 2 && isDigits(t);
}

/** An omitted year, or a two- or four-digit one. */
function isYearWord(t: string | undefined): boolean {
  return t === undefined || ((t.length === 2 || t.length === 4) && isDigits(t));
}

function monthCode(month: { long: boolean }): string {
  return month.long ? 'mmmm' : 'mmm';
}

/** A day-first date starts with digits, which never name a month, so at most one shape applies. */
function namedDate(s: string, locale: FormatLocale, currentYear: number): Parsed | null {
  const words = dateWords(s, locale);
  if (!words) return null;
  return dayFirstDate(s, words, locale, currentYear) ?? monthFirstDate(s, words, locale, currentYear);
}

/** 15 jan 2026, 15-jan-26, 15 january. */
function dayFirstDate(s: string, words: DateWords, locale: FormatLocale, currentYear: number): Parsed | null {
  const [day, monthWord, year] = words;
  const month = isDayWord(day) ? monthIndex(monthWord, locale) : null;
  if (!month || !isYearWord(year)) return null;
  const sep = s.includes('-') ? '-' : ' ';
  const yFmt = year === undefined ? '' : `${sep}${yearCode(year)}`;
  return dateResult(
    serialOf(year === undefined ? currentYear : fullYear(year), month.month, Number(day)),
    `d${sep}${monthCode(month)}${yFmt}`,
  );
}

/** Jan 15, 2026 / January 15 / jan 15 26, and jan 2026 for the first of the month. */
function monthFirstDate(s: string, words: DateWords, locale: FormatLocale, currentYear: number): Parsed | null {
  const [monthWord, second, year] = words;
  const month = monthIndex(monthWord, locale);
  if (!month) return null;
  const mon = monthCode(month);
  if (isDayWord(second) && isYearWord(year)) {
    const comma = s.includes(',') ? ',' : '';
    const yFmt = year === undefined ? '' : `${comma} ${yearCode(year)}`;
    return dateResult(
      serialOf(year === undefined ? currentYear : fullYear(year), month.month, Number(second)),
      `${mon} d${yFmt}`,
    );
  }
  if (year === undefined && second.length === 4 && isDigits(second)) {
    return dateResult(serialOf(Number(second), month.month, 1), `${mon} yyyy`);
  }
  return null;
}

function parseDate(s: string, locale: FormatLocale, order: Order, currentYear: number): Parsed | null {
  return numericDate(s, order, currentYear) ?? namedDate(s, locale, currentYear);
}

function parseDateTime(s: string, locale: FormatLocale, order: Order, currentYear: number): Parsed | null {
  const isoT = /^(\d{4}-\d{1,2}-\d{1,2})T(.+)$/.exec(s);
  if (isoT) return combine(parseDate(isoT[1]!, locale, order, currentYear), parseTime(isoT[2]!));

  const time = parseTime(s);
  if (time) return time;
  const parts = s.split(/\s+/);
  for (const k of [2, 1]) {
    if (parts.length <= k) continue;
    const t = parseTime(parts.slice(-k).join(' '));
    if (t) return combine(parseDate(parts.slice(0, -k).join(' '), locale, order, currentYear), t);
  }
  return parseDate(s, locale, order, currentYear);
}

function combine(date: Parsed | null, time: Parsed | null): Parsed | null {
  if (!date || !time) return null;
  return { value: date.value + time.value, numFmt: `${date.numFmt ?? ''} ${time.numFmt ?? ''}`.trim() };
}
