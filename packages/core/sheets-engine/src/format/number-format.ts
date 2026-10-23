/**
 * Excel number format codes: compiled once, rendered many times.
 *
 * A code has up to four sections (positive; negative; zero; text). Each is a
 * list of tokens: digit placeholders, literals, date/time parts and the
 * bracketed colour, condition, currency and elapsed-time tags. Codes use the
 * invariant (en-US) syntax stored in xlsx files; the locale only changes what
 * is rendered (separators, month and day names, AM/PM).
 */

import { formatGeneralNumber, isError, type Scalar } from '../values';
import { weekdayFromSerial, ymdFromSerial } from './date';

export interface FormatLocale {
  decimal: string;
  group: string;
  /** January first, 12 entries. */
  monthNames: readonly string[];
  monthShort: readonly string[];
  /** Sunday first, 7 entries. */
  dayNames: readonly string[];
  dayShort: readonly string[];
  ampm: readonly [string, string];
  /** Day/month/year order of typed numeric dates (used by `parseInput`). */
  dateOrder?: 'mdy' | 'dmy' | 'ymd';
}

export const EN_LOCALE: FormatLocale = {
  decimal: '.',
  group: ',',
  monthNames: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  monthShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  dayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  dayShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ampm: ['AM', 'PM'],
  dateOrder: 'mdy',
};

export const NL_LOCALE: FormatLocale = {
  decimal: ',',
  group: '.',
  monthNames: [
    'januari',
    'februari',
    'maart',
    'april',
    'mei',
    'juni',
    'juli',
    'augustus',
    'september',
    'oktober',
    'november',
    'december',
  ],
  monthShort: ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'],
  dayNames: ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'],
  dayShort: ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'],
  ampm: ['a.m.', 'p.m.'],
  dateOrder: 'dmy',
};

export interface FormattedValue {
  text: string;
  /** CSS hex colour from a [Red] / [ColorN] tag. */
  color?: string;
  /**
   * The value cannot be shown in this format (a negative or out-of-range
   * date). `text` is then "########", as Excel fills the cell; TEXT() returns
   * #VALUE! instead.
   */
  overflow?: true;
}

export type FormatCategory =
  | 'general'
  | 'number'
  | 'percent'
  | 'currency'
  | 'scientific'
  | 'fraction'
  | 'date'
  | 'time'
  | 'datetime'
  | 'duration'
  | 'text';

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type DigitChar = '0' | '#' | '?';

type Token =
  | { t: 'lit'; s: string }
  | { t: 'digit'; c: DigitChar }
  | { t: 'point' }
  | { t: 'comma' }
  | { t: 'percent' }
  | { t: 'exp'; s: string; plus: boolean }
  /** `fixed` is a literal denominator such as the 16 in `# ??/16`. */
  | { t: 'slash'; fixed?: string }
  | { t: 'at' }
  | { t: 'general' }
  | { t: 'fill' }
  | { t: 'year'; n: number }
  /** An m-run before the month/minute rule resolves it. */
  | { t: 'month'; n: number }
  | { t: 'minute'; n: number }
  | { t: 'day'; n: number }
  | { t: 'hour'; n: number }
  | { t: 'second'; n: number }
  | { t: 'ampm'; short: boolean; lower: boolean }
  | { t: 'elapsed'; unit: 'h' | 'm' | 's'; n: number }
  | { t: 'subsec'; n: number };

type Op = '<' | '>' | '=' | '<=' | '>=' | '<>';

interface Condition {
  op: Op;
  value: number;
}

type NumberMode = 'decimal' | 'scientific' | 'fraction' | 'general';

interface Section {
  kind: 'number' | 'date' | 'text';
  tokens: Token[];
  color?: string;
  cond?: Condition;
  currency: boolean;
  // number sections
  mode: NumberMode;
  /** Which part of the number each digit token renders, aligned with `tokens`. */
  parts: (Part | null)[];
  /** Token indices of each part's placeholders, left to right. */
  idx: Record<Part, number[]>;
  percent: number;
  scale: number;
  grouping: boolean;
  // date sections
  hour12: boolean;
  subsec: number;
  hasDate: boolean;
  hasTime: boolean;
  hasElapsed: boolean;
}

type Part = 'int' | 'frac' | 'exp' | 'num' | 'den';

interface Compiled {
  general: boolean;
  /** Number sections in order (at most three), the text section excluded. */
  sections: Section[];
  text?: Section;
  conditional: boolean;
}

class FormatCodeError extends Error {}

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
};

/** Excel's default 56-colour palette, for [Color1] … [Color56]. */
const PALETTE = [
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff',
  '800000', '008000', '000080', '808000', '800080', '008080', 'c0c0c0', '808080',
  '9999ff', '993366', 'ffffcc', 'ccffff', '660066', 'ff8080', '0066cc', 'ccccff',
  '000080', 'ff00ff', 'ffff00', '00ffff', '800080', '800000', '008080', '0000ff',
  '00ccff', 'ccffff', 'ccffcc', 'ffff99', '99ccff', 'ff99cc', 'cc99ff', 'ffcc99',
  '3366ff', '33cccc', '99cc00', 'ffcc00', 'ff9900', 'ff6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

const CURRENCY_CHARS = /[$€£¥₹¤]/;

/** Splits a code into sections at `;` outside quotes, escapes and brackets. */
function splitSections(code: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      if (end < 0) throw new FormatCodeError('Unterminated quote');
      i = end;
    } else if (ch === '\\' || ch === '_' || ch === '*') {
      i++;
    } else if (ch === '[') {
      const end = code.indexOf(']', i + 1);
      if (end < 0) throw new FormatCodeError('Unterminated bracket');
      i = end;
    } else if (ch === ';') {
      out.push(code.slice(start, i));
      start = i + 1;
    }
  }
  out.push(code.slice(start));
  if (out.length > 4) throw new FormatCodeError('Too many sections');
  return out;
}

const COND_RE = /^(<=|>=|<>|<|>|=)\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;

function tokenize(src: string): Section {
  const tokens: Token[] = [];
  const sec: Section = {
    kind: 'number',
    tokens,
    currency: false,
    mode: 'decimal',
    parts: [],
    idx: { int: [], frac: [], exp: [], num: [], den: [] },
    percent: 0,
    scale: 0,
    grouping: false,
    hour12: false,
    subsec: 0,
    hasDate: false,
    hasTime: false,
    hasElapsed: false,
  };
  const lit = (s: string) => {
    if (s === '') return;
    const last = tokens[tokens.length - 1];
    if (last?.t === 'lit') last.s += s;
    else tokens.push({ t: 'lit', s });
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    switch (ch) {
      case '"': {
        const end = src.indexOf('"', i + 1);
        if (end < 0) throw new FormatCodeError('Unterminated quote');
        const s = src.slice(i + 1, end);
        if (CURRENCY_CHARS.test(s)) sec.currency = true;
        lit(s);
        i = end + 1;
        continue;
      }
      case '\\':
        lit(src[i + 1] ?? '');
        i += 2;
        continue;
      case '_':
        // Space the width of the next character; a plain space is close enough.
        lit(' ');
        i += 2;
        continue;
      case '*':
        // Repeat-fill to the column width: the renderer does not pad, so nothing.
        tokens.push({ t: 'fill' });
        i += 2;
        continue;
      case '[': {
        const end = src.indexOf(']', i + 1);
        if (end < 0) throw new FormatCodeError('Unterminated bracket');
        readBracket(src.slice(i + 1, end), sec, lit);
        i = end + 1;
        continue;
      }
      case '0':
      case '#':
      case '?':
        tokens.push({ t: 'digit', c: ch });
        i++;
        continue;
      case '.':
        tokens.push({ t: 'point' });
        i++;
        continue;
      case ',':
        tokens.push({ t: 'comma' });
        i++;
        continue;
      case '%':
        tokens.push({ t: 'percent' });
        i++;
        continue;
      case '@':
        tokens.push({ t: 'at' });
        i++;
        continue;
      case '/': {
        const m = /^[1-9]\d*/.exec(src.slice(i + 1));
        if (m) {
          tokens.push({ t: 'slash', fixed: m[0] });
          i += 1 + m[0].length;
        } else {
          tokens.push({ t: 'slash' });
          i++;
        }
        continue;
      }
      case 'E':
      case 'e': {
        const next = src[i + 1];
        if (next === '+' || next === '-') {
          tokens.push({ t: 'exp', s: ch, plus: next === '+' });
          i += 2;
        } else {
          lit(ch);
          i++;
        }
        continue;
      }
      default: {
        if (src.slice(i, i + 7).toLowerCase() === 'general') {
          tokens.push({ t: 'general' });
          i += 7;
          continue;
        }
        if (src.slice(i, i + 5).toUpperCase() === 'AM/PM') {
          tokens.push({ t: 'ampm', short: false, lower: false });
          i += 5;
          continue;
        }
        if (src.slice(i, i + 3).toUpperCase() === 'A/P') {
          tokens.push({ t: 'ampm', short: true, lower: ch === 'a' });
          i += 3;
          continue;
        }
        const lower = ch.toLowerCase();
        if (lower === 'y' || lower === 'm' || lower === 'd' || lower === 'h' || lower === 's') {
          let n = 1;
          while (src[i + n]?.toLowerCase() === lower) n++;
          if (lower === 'y') tokens.push({ t: 'year', n });
          else if (lower === 'm') tokens.push({ t: 'month', n });
          else if (lower === 'd') tokens.push({ t: 'day', n });
          else if (lower === 'h') tokens.push({ t: 'hour', n });
          else tokens.push({ t: 'second', n });
          i += n;
          continue;
        }
        if (CURRENCY_CHARS.test(ch)) sec.currency = true;
        lit(ch);
        i++;
      }
    }
  }
  return sec;
}

function readBracket(inner: string, sec: Section, lit: (s: string) => void): void {
  const lower = inner.toLowerCase();
  const named = NAMED_COLORS[lower];
  if (named) {
    sec.color = named;
    return;
  }
  const colorN = /^color\s*(\d+)$/.exec(lower);
  if (colorN) {
    const hex = PALETTE[Number(colorN[1]) - 1];
    if (hex) sec.color = `#${hex}`;
    return;
  }
  const cond = COND_RE.exec(inner.trim());
  if (cond) {
    sec.cond = { op: cond[1] as Op, value: Number(cond[2]) };
    return;
  }
  if (inner.startsWith('$')) {
    // [$€-413]: currency symbol, then an optional locale id (ignored, the
    // renderer's locale wins). [$-409] carries only the locale.
    const symbol = /^\$([^-]*)/.exec(inner)?.[1] ?? '';
    if (symbol) {
      sec.currency = true;
      lit(symbol);
    }
    return;
  }
  const elapsed = /^(h+|m+|s+)$/.exec(lower);
  if (elapsed) {
    const run = elapsed[1]!;
    sec.tokens.push({ t: 'elapsed', unit: run[0] as 'h' | 'm' | 's', n: run.length });
  }
  // Anything else ([DBNum1], [natnum1], …) is ignored.
}

const DATE_PARTS = new Set<Token['t']>(['year', 'month', 'minute', 'day', 'hour', 'second', 'elapsed']);

function analyse(sec: Section): void {
  const tokens = sec.tokens;
  if (tokens.some((t) => DATE_PARTS.has(t.t) || t.t === 'ampm')) analyseDate(sec);
  else if (tokens.some((t) => t.t === 'at')) sec.kind = 'text';
  else analyseNumber(sec);
}

function isDatePart(tok: Token | undefined): boolean {
  return tok !== undefined && DATE_PARTS.has(tok.t);
}

function analyseDate(sec: Section): void {
  sec.kind = 'date';
  const src = sec.tokens;
  // The m rule: m/mm right after an hour or right before a second is minutes.
  for (let j = 0; j < src.length; j++) {
    const tok = src[j]!;
    if (tok.t !== 'month' || tok.n > 2) continue;
    let prev = j - 1;
    while (prev >= 0 && !isDatePart(src[prev])) prev--;
    let next = j + 1;
    while (next < src.length && !isDatePart(src[next])) next++;
    const p = src[prev];
    const n = src[next];
    const afterHour = p?.t === 'hour' || (p?.t === 'elapsed' && p.unit === 'h');
    const beforeSecond = n?.t === 'second' || (n?.t === 'elapsed' && n.unit === 's');
    if (afterHour || beforeSecond) src[j] = { t: 'minute', n: tok.n };
  }
  // Number syntax inside a date section is literal, except `.000` after seconds.
  const out: Token[] = [];
  const lit = (s: string) => {
    const last = out[out.length - 1];
    if (last?.t === 'lit') last.s += s;
    else out.push({ t: 'lit', s });
  };
  for (let j = 0; j < src.length; j++) {
    const tok = src[j]!;
    switch (tok.t) {
      case 'point': {
        let k = 0;
        for (let next = src[j + 1]; next?.t === 'digit' && next.c === '0'; next = src[j + 1 + k]) k++;
        let prev = out.length - 1;
        while (prev >= 0 && out[prev]!.t === 'lit') prev--;
        const p = out[prev];
        if (k > 0 && (p?.t === 'second' || (p?.t === 'elapsed' && p.unit === 's'))) {
          out.push({ t: 'subsec', n: k });
          sec.subsec = Math.max(sec.subsec, Math.min(k, 3));
          j += k;
        } else lit('.');
        break;
      }
      case 'digit':
        lit(tok.c);
        break;
      case 'comma':
        lit(',');
        break;
      case 'percent':
        lit('%');
        break;
      case 'slash':
        lit(`/${tok.fixed ?? ''}`);
        break;
      case 'exp':
        lit(`${tok.s}${tok.plus ? '+' : '-'}`);
        break;
      case 'general':
        lit('General');
        break;
      case 'at':
        break;
      default:
        out.push(tok);
    }
  }
  sec.tokens = out;
  for (const tok of out) {
    if (tok.t === 'year' || tok.t === 'month' || tok.t === 'day') sec.hasDate = true;
    else if (tok.t === 'elapsed') sec.hasElapsed = true;
    else if (tok.t === 'hour' || tok.t === 'minute' || tok.t === 'second' || tok.t === 'subsec') sec.hasTime = true;
    else if (tok.t === 'ampm') {
      sec.hasTime = true;
      sec.hour12 = true;
    }
  }
}

function analyseNumber(sec: Section): void {
  const tokens = sec.tokens;
  const parts: (Part | null)[] = tokens.map(() => null);
  sec.parts = parts;
  sec.percent = tokens.filter((t) => t.t === 'percent').length;
  if (tokens.some((t) => t.t === 'general')) {
    sec.mode = 'general';
    return;
  }
  const isDigit = (j: number) => tokens[j]?.t === 'digit';

  const expIdx = tokens.findIndex((t) => t.t === 'exp');
  if (expIdx >= 0 && tokens.slice(expIdx + 1).some((t) => t.t === 'digit')) {
    sec.mode = 'scientific';
    let seenPoint = false;
    for (let j = 0; j < tokens.length; j++) {
      const t = tokens[j]!;
      if (j < expIdx) {
        if (t.t === 'point') seenPoint = true;
        else if (t.t === 'digit') parts[j] = seenPoint ? 'frac' : 'int';
      } else if (t.t === 'digit') parts[j] = 'exp';
    }
    return;
  }

  const slashIdx = tokens.findIndex((t) => t.t === 'slash');
  const slash = tokens[slashIdx];
  if (slash?.t === 'slash' && isDigit(slashIdx - 1) && (slash.fixed !== undefined || isDigit(slashIdx + 1))) {
    sec.mode = 'fraction';
    let j = slashIdx - 1;
    while (isDigit(j)) parts[j--] = 'num';
    for (; j >= 0; j--) if (isDigit(j)) parts[j] = 'int';
    for (let k = slashIdx + 1; isDigit(k); k++) parts[k] = 'den';
    return;
  }

  sec.mode = 'decimal';
  const pointIdx = tokens.findIndex((t) => t.t === 'point');
  let firstDigit = -1;
  let lastDigit = -1;
  for (let j = 0; j < tokens.length; j++) {
    if (tokens[j]!.t !== 'digit') continue;
    parts[j] = pointIdx >= 0 && j > pointIdx ? 'frac' : 'int';
    if (firstDigit < 0) firstDigit = j;
    lastDigit = j;
  }
  // A comma between integer placeholders groups thousands; each comma after
  // the last placeholder scales the number down by 1,000.
  for (let j = 0; j < tokens.length; j++) {
    if (tokens[j]!.t !== 'comma' || firstDigit < 0 || j < firstDigit) continue;
    if (j > lastDigit) sec.scale++;
    else if (pointIdx < 0 || j < pointIdx) sec.grouping = true;
  }
}

const GENERAL: Compiled = { general: true, sections: [], conditional: false };

function compile(code: string): Compiled {
  const trimmed = code.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'general') return GENERAL;
  const raw = splitSections(code).map(tokenize);
  for (const sec of raw) {
    analyse(sec);
    sec.parts.forEach((p, j) => {
      if (p) sec.idx[p].push(j);
    });
  }
  const sections: Section[] = [];
  let text: Section | undefined;
  raw.forEach((sec, i) => {
    if (i === 3 || (sec.kind === 'text' && !text)) text = sec;
    else if (sections.length < 3) sections.push(sec);
  });
  return { general: false, sections, text, conditional: sections.some((s) => s.cond !== undefined) };
}

const cache = new Map<string, Compiled>();
const CACHE_LIMIT = 4096;

function compiled(code: string | undefined): Compiled {
  if (code === undefined) return GENERAL;
  let c = cache.get(code);
  if (!c) {
    try {
      c = compile(code);
    } catch {
      // An invalid code renders as General instead of failing the frame.
      c = GENERAL;
    }
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(code, c);
  }
  return c;
}

function test(cond: Condition, v: number): boolean {
  switch (cond.op) {
    case '<':
      return v < cond.value;
    case '>':
      return v > cond.value;
    case '=':
      return v === cond.value;
    case '<=':
      return v <= cond.value;
    case '>=':
      return v >= cond.value;
    case '<>':
      return v !== cond.value;
  }
}

/** True when only negative numbers satisfy the condition; that section then drops the sign. */
function negativeOnly(cond: Condition | undefined): boolean {
  if (!cond) return false;
  return (cond.op === '<' && cond.value <= 0) || ((cond.op === '<=' || cond.op === '=') && cond.value < 0);
}

/** The section a number renders with, and whether it gets a leading minus. */
function pickSection(c: Compiled, v: number): { sec: Section | undefined; signed: boolean } {
  const [s0, s1, s2] = c.sections;
  if (!s0) return { sec: undefined, signed: false };
  if (c.conditional) {
    let sec: Section;
    if (s0.cond && test(s0.cond, v)) sec = s0;
    else if (s1?.cond && test(s1.cond, v)) sec = s1;
    else if (s0.cond && s1?.cond) sec = s2 ?? s1;
    else sec = s1 ?? s0;
    return { sec, signed: v < 0 && !negativeOnly(sec.cond) };
  }
  if (!s1) return { sec: s0, signed: v < 0 };
  if (v < 0) return { sec: s1, signed: false };
  if (v === 0 && s2) return { sec: s2, signed: false };
  return { sec: s0, signed: false };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const OVERFLOW = '########';
/** 10000-01-01, the first serial Excel cannot show as a date. */
const MAX_DATE_SERIAL = 2_958_466;

/** Plain decimal digits of a non-negative number, on its 15-significant-digit value as Excel keeps it. */
function plainDigits(x: number): string {
  const s = String(Number(x.toPrecision(15)));
  const e = s.indexOf('e');
  if (e < 0) return s;
  const exp = Number(s.slice(e + 1));
  const [mi = '0', mf = ''] = s.slice(0, e).split('.');
  const digits = mi + mf;
  const point = mi.length + exp;
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

function increment(digits: string): string {
  const arr = digits.split('');
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] === '9') arr[i] = '0';
    else {
      arr[i] = String(Number(arr[i]) + 1);
      return arr.join('');
    }
  }
  return `1${arr.join('')}`;
}

/**
 * Integer and fraction digits of a non-negative number rounded half away
 * from zero, in decimal (so 1.005 → 1.01, as in Excel, not 1.00).
 */
export function roundDigits(x: number, decimals: number): { int: string; frac: string } {
  const plain = plainDigits(x);
  const dot = plain.indexOf('.');
  let ip = dot < 0 ? plain : plain.slice(0, dot);
  let fp = dot < 0 ? '' : plain.slice(dot + 1);
  if (fp.length > decimals) {
    const up = fp.charCodeAt(decimals) >= 53; // '5'
    fp = fp.slice(0, decimals);
    if (up) {
      const inc = increment(ip + fp);
      ip = inc.slice(0, inc.length - decimals);
      fp = inc.slice(inc.length - decimals);
    }
  }
  ip = ip.replace(/^0+(?=\d)/, '');
  return { int: ip === '' ? '0' : ip, frac: fp.padEnd(decimals, '0') };
}

function padChar(c: DigitChar): string {
  return c === '0' ? '0' : c === '?' ? ' ' : '';
}

function digitChar(tokens: Token[], j: number): DigitChar {
  const t = tokens[j];
  return t?.t === 'digit' ? t.c : '#';
}

/** Spreads digits right to left over placeholders; the leftmost takes any overflow. */
function fillRight(digits: string, idx: readonly number[], tokens: Token[], out: string[]): void {
  let pos = digits.length;
  for (let k = idx.length - 1; k >= 0; k--) {
    const j = idx[k]!;
    if (k === 0) out[j] = pos > 0 ? digits.slice(0, pos) : padChar(digitChar(tokens, j));
    else out[j] = pos > 0 ? digits[--pos]! : padChar(digitChar(tokens, j));
  }
}

/** Decimal digits left to right; trailing zeros on # and ? placeholders drop out. */
function fillDecimals(digits: string, idx: readonly number[], tokens: Token[], out: string[]): void {
  let trailing = true;
  for (let k = idx.length - 1; k >= 0; k--) {
    const j = idx[k]!;
    const d = digits[k] ?? '0';
    const c = digitChar(tokens, j);
    if (trailing && d === '0' && c !== '0') out[j] = padChar(c);
    else {
      trailing = false;
      out[j] = d;
    }
  }
}

/** Denominator digits are left-aligned, padded on the right. */
function fillLeft(digits: string, idx: readonly number[], tokens: Token[], out: string[]): void {
  for (let k = 0; k < idx.length; k++) {
    const j = idx[k]!;
    const fill = digitChar(tokens, j) === '?' ? ' ' : '';
    if (k === idx.length - 1) out[j] = digits.length > k ? digits.slice(k) : fill;
    else out[j] = digits[k] ?? fill;
  }
}

function groupDigits(idx: readonly number[], out: string[], sep: string): void {
  let count = 0;
  for (let k = idx.length - 1; k >= 0; k--) {
    const j = idx[k]!;
    const s = out[j]!;
    let r = '';
    for (let q = s.length - 1; q >= 0; q--) {
      const ch = s[q]!;
      if (ch >= '0' && ch <= '9') {
        if (count > 0 && count % 3 === 0) r = sep + r;
        count++;
      }
      r = ch + r;
    }
    out[j] = r;
  }
}

/** Best rational approximation of x >= 0 with a denominator up to maxDen (continued fractions). */
function approxFraction(x: number, maxDen: number): [number, number] {
  let p0 = 0;
  let q0 = 1;
  let p1 = 1;
  let q1 = 0;
  let v = x;
  for (let iter = 0; iter < 64; iter++) {
    const a = Math.floor(v);
    const p2 = a * p1 + p0;
    const q2 = a * q1 + q0;
    if (q2 > maxDen) {
      const k = Math.floor((maxDen - q0) / q1);
      const ps = k * p1 + p0;
      const qs = k * q1 + q0;
      return Math.abs(ps / qs - x) < Math.abs(p1 / q1 - x) ? [ps, qs] : [p1, q1];
    }
    p0 = p1;
    q0 = q1;
    p1 = p2;
    q1 = q2;
    const r = v - a;
    if (r < 1e-10 || Math.abs(p1 / q1 - x) < 1e-12) break;
    v = 1 / r;
  }
  return [p1, q1];
}

function generalText(n: number, locale: FormatLocale): string {
  const s = formatGeneralNumber(n);
  return locale.decimal === '.' ? s : s.replace('.', locale.decimal);
}

function renderNumber(sec: Section, value: number, locale: FormatLocale): string {
  const { tokens, idx } = sec;
  const x = (Math.abs(value) * 100 ** sec.percent) / 1000 ** sec.scale;
  const out: string[] = tokens.map(() => '');
  let intText = '';
  let expSign = '';
  let blank: [number, number] | null = null;

  if (sec.mode === 'general') {
    intText = generalText(x, locale);
  } else if (sec.mode === 'decimal') {
    const r = roundDigits(x, idx.frac.length);
    intText = r.int === '0' ? '' : r.int;
    fillRight(intText, idx.int, tokens, out);
    if (sec.grouping) groupDigits(idx.int, out, locale.group);
    fillDecimals(r.frac, idx.frac, tokens, out);
  } else if (sec.mode === 'scientific') {
    const ic = idx.int.length;
    const engineering = ic > 1 && idx.int.some((j) => digitChar(tokens, j) === '#');
    const step = engineering ? ic : 1;
    let e = 0;
    let r = roundDigits(0, idx.frac.length);
    if (x !== 0) {
      const e10 = Number(x.toExponential().split('e')[1]);
      e = engineering ? Math.floor(e10 / ic) * ic : e10 - Math.max(ic, 1) + 1;
      r = roundDigits(x * 10 ** -e, idx.frac.length);
      if (r.int.length > (engineering ? ic : Math.max(ic, 1))) {
        e += step;
        r = roundDigits(x * 10 ** -e, idx.frac.length);
      }
    }
    intText = r.int === '0' ? '' : r.int;
    fillRight(intText, idx.int, tokens, out);
    fillDecimals(r.frac, idx.frac, tokens, out);
    const expTok = tokens.find((t) => t.t === 'exp');
    expSign = e < 0 ? '-' : expTok?.t === 'exp' && expTok.plus ? '+' : '';
    fillRight(e === 0 ? '' : String(Math.abs(e)), idx.exp, tokens, out);
  } else {
    const slashIdx = tokens.findIndex((t) => t.t === 'slash');
    const slash = tokens[slashIdx];
    const fixed = slash?.t === 'slash' && slash.fixed !== undefined ? Number(slash.fixed) : 0;
    const hasInt = idx.int.length > 0;
    let whole = hasInt ? Math.floor(x) : 0;
    const f = x - whole;
    let n: number;
    let d: number;
    if (fixed) {
      n = Math.round(f * fixed);
      d = fixed;
    } else {
      [n, d] = approxFraction(f, 10 ** Math.min(idx.den.length, 7) - 1);
    }
    if (hasInt && n >= d) {
      whole += Math.floor(n / d);
      n %= d;
    }
    if (hasInt) {
      fillRight(whole === 0 ? (n === 0 ? '0' : '') : String(whole), idx.int, tokens, out);
      if (n === 0) blank = [idx.num[0] ?? slashIdx, fixed ? slashIdx : (idx.den[idx.den.length - 1] ?? slashIdx)];
    }
    fillRight(String(n), idx.num, tokens, out);
    if (!fixed) fillLeft(String(d), idx.den, tokens, out);
  }

  let text = '';
  let intPlaced = idx.int.length > 0;
  for (let j = 0; j < tokens.length; j++) {
    const t = tokens[j]!;
    let s: string;
    switch (t.t) {
      case 'digit':
        s = out[j]!;
        break;
      case 'lit':
        s = t.s;
        break;
      case 'point':
        s = (intPlaced ? '' : intText) + locale.decimal;
        intPlaced = true;
        break;
      case 'percent':
        s = '%';
        break;
      case 'exp':
        s = t.s + expSign;
        break;
      case 'slash':
        s = `/${t.fixed ?? ''}`;
        break;
      case 'general':
        s = intText;
        break;
      default:
        s = '';
    }
    // A zero fraction part is replaced by spaces of its nominal width.
    if (blank && j >= blank[0] && j <= blank[1]) s = t.t === 'digit' ? ' ' : ' '.repeat(s.length);
    text += s;
  }
  return text;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function renderDate(sec: Section, serial: number, locale: FormatLocale): string | null {
  if (!(serial >= 0) || serial >= MAX_DATE_SERIAL) return null;
  // Round to the shown precision first, so 23:59:59.7 reads as the next day.
  const sub = 10 ** sec.subsec;
  const total = Math.round(serial * 86_400 * sub);
  const totalSeconds = Math.floor(total / sub);
  const fraction = total - totalSeconds * sub;
  const day = Math.floor(totalSeconds / 86_400);
  const secs = totalSeconds - day * 86_400;
  const hour = Math.floor(secs / 3600);
  const minute = Math.floor((secs % 3600) / 60);
  const second = secs % 60;
  const ymd = sec.hasDate ? ymdFromSerial(day) : null;

  let text = '';
  for (const t of sec.tokens) {
    switch (t.t) {
      case 'lit':
        text += t.s;
        break;
      case 'year': {
        const y = ymd?.year ?? 1900;
        text += t.n <= 2 ? pad2(y % 100) : String(y).padStart(4, '0');
        break;
      }
      case 'month': {
        const m = ymd?.month ?? 1;
        if (t.n === 1) text += String(m);
        else if (t.n === 2) text += pad2(m);
        else if (t.n === 3) text += locale.monthShort[m - 1] ?? '';
        else if (t.n === 5) text += (locale.monthNames[m - 1] ?? '').charAt(0);
        else text += locale.monthNames[m - 1] ?? '';
        break;
      }
      case 'day': {
        if (t.n <= 2) {
          const d = ymd?.day ?? 0;
          text += t.n === 1 ? String(d) : pad2(d);
        } else {
          const w = weekdayFromSerial(day);
          text += (t.n === 3 ? locale.dayShort[w] : locale.dayNames[w]) ?? '';
        }
        break;
      }
      case 'hour': {
        const h = sec.hour12 ? hour % 12 || 12 : hour;
        text += t.n === 1 ? String(h) : pad2(h);
        break;
      }
      case 'minute':
        text += t.n === 1 ? String(minute) : pad2(minute);
        break;
      case 'second':
        text += t.n === 1 ? String(second) : pad2(second);
        break;
      case 'subsec':
        text += locale.decimal + String(fraction).padStart(sec.subsec, '0').slice(0, t.n).padEnd(t.n, '0');
        break;
      case 'ampm':
        if (t.short) {
          const s = hour < 12 ? 'A' : 'P';
          text += t.lower ? s.toLowerCase() : s;
        } else text += hour < 12 ? locale.ampm[0] : locale.ampm[1];
        break;
      case 'elapsed': {
        const v = t.unit === 'h' ? Math.floor(totalSeconds / 3600) : t.unit === 'm' ? Math.floor(totalSeconds / 60) : totalSeconds;
        text += String(v).padStart(t.n, '0');
        break;
      }
      default:
        break;
    }
  }
  return text;
}

function renderText(sec: Section, value: string): string {
  let text = '';
  for (const t of sec.tokens) {
    if (t.t === 'lit') text += t.s;
    else if (t.t === 'at') text += value;
  }
  return text;
}

function result(text: string, sec: Section | undefined): FormattedValue {
  return sec?.color ? { text, color: sec.color } : { text };
}

/**
 * Renders a value with an Excel number format code. `undefined`, "" and
 * "General" give General formatting. Booleans, errors and blanks ignore the
 * code; text uses the code's text section when it has one.
 */
export function formatValue(value: Scalar, code: string | undefined, locale: FormatLocale = EN_LOCALE): FormattedValue {
  if (value === null) return { text: '' };
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE' };
  if (isError(value)) return { text: value.code };
  const c = compiled(code);
  if (typeof value === 'string') return c.text ? result(renderText(c.text, value), c.text) : { text: value };
  if (c.general || !Number.isFinite(value)) return { text: generalText(value, locale) };
  const { sec, signed } = pickSection(c, value);
  if (!sec) return { text: generalText(value, locale) };
  try {
    if (sec.kind === 'date') {
      const text = renderDate(sec, value, locale);
      return text === null ? { text: OVERFLOW, overflow: true } : result(text, sec);
    }
    const body = sec.kind === 'text' ? renderText(sec, generalText(Math.abs(value), locale)) : renderNumber(sec, value, locale);
    return result(signed ? `-${body}` : body, sec);
  } catch {
    return { text: generalText(value, locale) };
  }
}

/** Toolbar category of a format code ("Number", "Date", …). */
export function formatCategory(code: string | undefined): FormatCategory {
  const c = compiled(code);
  if (c.general) return 'general';
  const sec = c.sections[0];
  if (!sec || sec.kind === 'text') return c.text ? 'text' : 'general';
  if (sec.kind === 'date') {
    if (sec.hasElapsed) return 'duration';
    if (sec.hasDate && sec.hasTime) return 'datetime';
    return sec.hasDate ? 'date' : 'time';
  }
  if (sec.mode === 'scientific') return 'scientific';
  if (sec.mode === 'fraction') return 'fraction';
  if (sec.mode === 'general') return 'general';
  if (sec.percent > 0) return 'percent';
  if (sec.currency) return 'currency';
  return sec.idx.int.length + sec.idx.frac.length > 0 ? 'number' : 'general';
}

/** True for date, time, date-time and elapsed-time codes. */
export function isDateFormat(code: string | undefined): boolean {
  const cat = formatCategory(code);
  return cat === 'date' || cat === 'time' || cat === 'datetime' || cat === 'duration';
}
