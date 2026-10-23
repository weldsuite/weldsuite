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

function parseNumber(input: string, locale: FormatLocale): Parsed | null {
  let t = input;
  let paren = false;
  if (t.startsWith('(') && t.endsWith(')')) {
    paren = true;
    t = t.slice(1, -1).trim();
  }
  let sign = '';
  const takeSign = () => {
    if (!sign && (t[0] === '-' || t[0] === '+')) {
      sign = t[0];
      t = t.slice(1).trim();
    }
  };
  takeSign();
  let currency = '';
  let before = false;
  let spaced = false;
  const pre = new RegExp(`^([${CURRENCY}])(\\s*)`).exec(t);
  if (pre) {
    currency = pre[1]!;
    before = true;
    spaced = pre[2] !== '';
    t = t.slice(pre[0].length);
    takeSign();
  } else {
    const post = new RegExp(`(\\s*)([${CURRENCY}])$`).exec(t);
    if (post) {
      currency = post[2]!;
      spaced = post[1] !== '';
      t = t.slice(0, -post[0].length);
    }
  }
  let percent = false;
  if (t.endsWith('%')) {
    percent = true;
    t = t.slice(0, -1).trim();
  }
  if ((paren && sign) || (percent && currency)) return null;

  const m = coreRe(locale).exec(t);
  if (!m) return null;
  const intPart = m[1] ?? '';
  const fracPart = m[2] ?? '';
  if (intPart === '' && fracPart === '') return null;
  const digits = intPart.split(locale.group).join('');
  let value = Number(`${digits || '0'}.${fracPart || '0'}e${m[3] ?? '0'}`);
  if (!Number.isFinite(value)) return null;
  if (percent) value /= 100;
  if (paren || sign === '-') value = -value;
  if (value === 0) value = 0; // no -0

  const decimals = fracPart.length > 0;
  let numFmt: string | undefined;
  if (m[3] !== undefined) numFmt = '0.00E+00';
  else if (percent) numFmt = decimals ? '0.00%' : '0%';
  else if (currency) {
    const body = decimals ? '#,##0.00' : '#,##0';
    const sym = spaced ? (before ? `${currency} ` : ` ${currency}`) : currency;
    numFmt = before ? `"${sym}"${body}` : `${body}"${sym}"`;
  } else if (intPart.includes(locale.group)) numFmt = decimals ? '#,##0.00' : '#,##0';
  return { value, numFmt };
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

const TIME_RE = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})([.,]\d{1,3})?)?(?:\s*([ap])\.?(?:m\.?)?)?$/i;
const HOUR_AMPM_RE = /^(\d{1,2})\s*([ap])\.?(?:m\.?)?$/i;

function parseTime(s: string): Parsed | null {
  let h: number;
  let mi = 0;
  let se = 0;
  let ap: string | undefined;
  let fmt: string;
  const m = TIME_RE.exec(s);
  if (m) {
    h = Number(m[1]);
    mi = Number(m[2]);
    se = m[3] === undefined ? 0 : Number(m[3]) + (m[4] ? Number(`0.${m[4].slice(1)}`) : 0);
    ap = m[5]?.toLowerCase();
    const sub = m[4] ? `.${'0'.repeat(m[4].length - 1)}` : '';
    const secs = m[3] === undefined ? '' : `:ss${sub}`;
    if (ap) fmt = `h:mm${secs} AM/PM`;
    else fmt = h >= 24 ? `[h]:mm${secs}` : `h:mm${secs}`;
  } else {
    const hm = HOUR_AMPM_RE.exec(s);
    if (!hm) return null;
    h = Number(hm[1]);
    ap = hm[2]!.toLowerCase();
    fmt = 'h AM/PM';
  }
  if (mi >= 60 || se >= 60) return null;
  if (ap) {
    if (h > 12) return null;
    h = (h % 12) + (ap === 'p' ? 12 : 0);
  }
  return { value: (h * 3600 + mi * 60 + se) / 86_400, numFmt: fmt };
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

function numericDate(s: string, order: Order, currentYear: number): Parsed | null {
  const iso = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(s);
  if (iso) {
    const serial = serialOf(Number(iso[1]), Number(iso[3]), Number(iso[4]));
    if (serial === null) return null;
    const padded = iso[3]!.length === 2 || iso[4]!.length === 2;
    const sep = iso[2]!;
    return { value: serial, numFmt: padded ? `yyyy${sep}mm${sep}dd` : `yyyy${sep}m${sep}d` };
  }

  const three = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})$/.exec(s);
  if (three) {
    const [, a = '', sep = '', b = '', c = ''] = three;
    const padded = (a.length === 2 && a[0] === '0') || (b.length === 2 && b[0] === '0');
    const y = order === 'ymd' ? fullYear(a) : fullYear(c);
    const yFmt = (order === 'ymd' ? a : c).length <= 2 ? 'yy' : 'yyyy';
    const d = padded ? 'dd' : 'd';
    const m = padded ? 'mm' : 'm';
    if (order === 'ymd') {
      const serial = serialOf(y, Number(b), Number(c));
      return serial === null ? null : { value: serial, numFmt: `${yFmt}${sep}${m}${sep}${d}` };
    }
    // Try the configured order first, then the other one ("15-01-2026" in a US sheet).
    const tries: ('mdy' | 'dmy')[] = order === 'dmy' ? ['dmy', 'mdy'] : ['mdy', 'dmy'];
    for (const o of tries) {
      const serial = o === 'mdy' ? serialOf(y, Number(a), Number(b)) : serialOf(y, Number(b), Number(a));
      if (serial !== null) {
        return { value: serial, numFmt: o === 'mdy' ? `${m}${sep}${d}${sep}${yFmt}` : `${d}${sep}${m}${sep}${yFmt}` };
      }
    }
    return null;
  }

  const two = /^(\d{1,2})([-/])(\d{1,2})$/.exec(s);
  if (two) {
    const a = Number(two[1]);
    const b = Number(two[3]);
    const first = order === 'dmy' ? serialOf(currentYear, b, a) : serialOf(currentYear, a, b);
    const serial = first ?? (order === 'dmy' ? serialOf(currentYear, a, b) : serialOf(currentYear, b, a));
    return serial === null ? null : { value: serial, numFmt: 'd-mmm' };
  }
  return null;
}

function namedDate(s: string, locale: FormatLocale, currentYear: number): Parsed | null {
  let tokens = s.split(/[\s,./-]+/).filter((t) => t !== '');
  if (tokens.length > 0 && isDayName(tokens[0]!, locale)) tokens = tokens.slice(1);
  if (tokens.length < 2 || tokens.length > 3) return null;
  const dash = s.includes('-');
  const comma = s.includes(',');
  const isNum = (t: string | undefined) => t !== undefined && /^\d+$/.test(t);
  const yearOf = (t: string | undefined) => (t === undefined ? currentYear : fullYear(t));
  const yearFmt = (t: string | undefined) => (t === undefined ? '' : t.length <= 2 ? 'yy' : 'yyyy');
  const validYear = (t: string | undefined) => t === undefined || t.length === 2 || t.length === 4;

  const [t0, t1, t2] = tokens;
  // 15 jan 2026, 15-jan-26, 15 january
  const m1 = isNum(t0) && t0!.length <= 2 ? monthIndex(t1!, locale) : null;
  if (m1 && (t2 === undefined || isNum(t2)) && validYear(t2)) {
    const serial = serialOf(yearOf(t2), m1.month, Number(t0));
    if (serial === null) return null;
    const mon = m1.long ? 'mmmm' : 'mmm';
    const sep = dash ? '-' : ' ';
    return { value: serial, numFmt: t2 === undefined ? `d${sep}${mon}` : `d${sep}${mon}${sep}${yearFmt(t2)}` };
  }
  const m0 = monthIndex(t0!, locale);
  if (!m0) return null;
  const mon = m0.long ? 'mmmm' : 'mmm';
  // Jan 15, 2026 / January 15 / jan 15 26
  if (isNum(t1) && t1!.length <= 2 && (t2 === undefined || isNum(t2)) && validYear(t2)) {
    const serial = serialOf(yearOf(t2), m0.month, Number(t1));
    if (serial === null) return null;
    return { value: serial, numFmt: t2 === undefined ? `${mon} d` : `${mon} d${comma ? ',' : ''} ${yearFmt(t2)}` };
  }
  // jan 2026: the first of the month
  if (t2 === undefined && isNum(t1) && t1!.length === 4) {
    const serial = serialOf(Number(t1), m0.month, 1);
    return serial === null ? null : { value: serial, numFmt: `${mon} yyyy` };
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
