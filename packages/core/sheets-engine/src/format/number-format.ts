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

/** Index of the `close` character that ends the quoted string or tag opened at `open`. */
function closingIndex(src: string, open: number, close: string, what: string): number {
  const end = src.indexOf(close, open + 1);
  if (end < 0) throw new FormatCodeError(`Unterminated ${what}`);
  return end;
}

/** Index of the last character of the code unit at `i`: a quoted string, an escape pair or a [tag]. */
function unitEnd(code: string, i: number): number {
  const ch = code[i];
  if (ch === '"') return closingIndex(code, i, '"', 'quote');
  if (ch === '[') return closingIndex(code, i, ']', 'bracket');
  if (ch === '\\' || ch === '_' || ch === '*') return i + 1;
  return i;
}

/** Splits a code into sections at `;` outside quotes, escapes and brackets. */
function splitSections(code: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < code.length) {
    if (code[i] === ';') {
      out.push(code.slice(start, i));
      start = i + 1;
    }
    i = unitEnd(code, i) + 1;
  }
  out.push(code.slice(start));
  if (out.length > 4) throw new FormatCodeError('Too many sections');
  return out;
}

const COND_OP_RE = /^(?:<=|>=|<>|<|>|=)/;
/** A plain decimal number: 5, -1.5, .5, 5., 1e3. */
const COND_VALUE_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A [<=100]-style condition, or null when the tag is something else. */
function readCondition(inner: string): Condition | null {
  const trimmed = inner.trim();
  const op = COND_OP_RE.exec(trimmed)?.[0];
  if (op === undefined) return null;
  const value = trimmed.slice(op.length).trimStart();
  return COND_VALUE_RE.test(value) ? { op: op as Op, value: Number(value) } : null;
}

function newSection(): Section {
  return {
    kind: 'number',
    tokens: [],
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
}

/** Appends literal text, merging it into a literal token right before it. */
function pushLit(tokens: Token[], s: string): void {
  if (s === '') return;
  const last = tokens[tokens.length - 1];
  if (last?.t === 'lit') last.s += s;
  else tokens.push({ t: 'lit', s });
}

function tokenize(src: string): Section {
  const sec = newSection();
  let i = 0;
  while (i < src.length) i = readToken(src, i, sec);
  return sec;
}

/** Reads the token at `i` into `sec` and returns the index just past it. */
function readToken(src: string, i: number, sec: Section): number {
  const ch = src[i]!;
  const tokens = sec.tokens;
  switch (ch) {
    case '"':
      return readQuoted(src, i, sec);
    case '\\':
      pushLit(tokens, src[i + 1] ?? '');
      return i + 2;
    case '_':
      // Space the width of the next character; a plain space is close enough.
      pushLit(tokens, ' ');
      return i + 2;
    case '*':
      // Repeat-fill to the column width: the renderer does not pad, so nothing.
      tokens.push({ t: 'fill' });
      return i + 2;
    case '[': {
      const end = closingIndex(src, i, ']', 'bracket');
      readBracket(src.slice(i + 1, end), sec);
      return end + 1;
    }
    case '0':
    case '#':
    case '?':
      tokens.push({ t: 'digit', c: ch });
      return i + 1;
    case '.':
      tokens.push({ t: 'point' });
      return i + 1;
    case ',':
      tokens.push({ t: 'comma' });
      return i + 1;
    case '%':
      tokens.push({ t: 'percent' });
      return i + 1;
    case '@':
      tokens.push({ t: 'at' });
      return i + 1;
    case '/':
      return readSlash(src, i, tokens);
    case 'E':
    case 'e':
      return readExponent(src, i, tokens);
    default:
      return readWord(src, i, sec);
  }
}

/** A "quoted literal"; a currency symbol inside makes the section a currency format. */
function readQuoted(src: string, i: number, sec: Section): number {
  const end = closingIndex(src, i, '"', 'quote');
  const s = src.slice(i + 1, end);
  if (CURRENCY_CHARS.test(s)) sec.currency = true;
  pushLit(sec.tokens, s);
  return end + 1;
}

/** `/`, or `/16` with a literal denominator. */
function readSlash(src: string, i: number, tokens: Token[]): number {
  const m = /^[1-9]\d*/.exec(src.slice(i + 1));
  if (!m) {
    tokens.push({ t: 'slash' });
    return i + 1;
  }
  tokens.push({ t: 'slash', fixed: m[0] });
  return i + 1 + m[0].length;
}

/** E+ / E- (scientific notation); an E without a sign is a literal. */
function readExponent(src: string, i: number, tokens: Token[]): number {
  const ch = src[i]!;
  const next = src[i + 1];
  if (next !== '+' && next !== '-') {
    pushLit(tokens, ch);
    return i + 1;
  }
  tokens.push({ t: 'exp', s: ch, plus: next === '+' });
  return i + 2;
}

/** The token each date/time letter starts a run of. */
const DATE_RUNS = new Map<string, 'year' | 'month' | 'day' | 'hour' | 'second'>([
  ['y', 'year'],
  ['m', 'month'],
  ['d', 'day'],
  ['h', 'hour'],
  ['s', 'second'],
]);

/** General, AM/PM, A/P, a run of a date/time letter (yyyy, mm, …), or a literal character. */
function readWord(src: string, i: number, sec: Section): number {
  const ch = src[i]!;
  const tokens = sec.tokens;
  if (src.slice(i, i + 7).toLowerCase() === 'general') {
    tokens.push({ t: 'general' });
    return i + 7;
  }
  if (src.slice(i, i + 5).toUpperCase() === 'AM/PM') {
    tokens.push({ t: 'ampm', short: false, lower: false });
    return i + 5;
  }
  if (src.slice(i, i + 3).toUpperCase() === 'A/P') {
    tokens.push({ t: 'ampm', short: true, lower: ch === 'a' });
    return i + 3;
  }
  const lower = ch.toLowerCase();
  const run = DATE_RUNS.get(lower);
  if (run) {
    let n = 1;
    while (src[i + n]?.toLowerCase() === lower) n++;
    tokens.push({ t: run, n });
    return i + n;
  }
  if (CURRENCY_CHARS.test(ch)) sec.currency = true;
  pushLit(tokens, ch);
  return i + 1;
}

function readBracket(inner: string, sec: Section): void {
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
  const cond = readCondition(inner);
  if (cond) {
    sec.cond = cond;
    return;
  }
  if (inner.startsWith('$')) {
    // [$€-413]: currency symbol, then an optional locale id (ignored, the
    // renderer's locale wins). [$-409] carries only the locale.
    const symbol = /^\$([^-]*)/.exec(inner)?.[1] ?? '';
    if (symbol) {
      sec.currency = true;
      pushLit(sec.tokens, symbol);
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

function isHourPart(tok: Token | undefined): boolean {
  return tok?.t === 'hour' || (tok?.t === 'elapsed' && tok.unit === 'h');
}

function isSecondPart(tok: Token | undefined): boolean {
  return tok?.t === 'second' || (tok?.t === 'elapsed' && tok.unit === 's');
}

function analyseDate(sec: Section): void {
  sec.kind = 'date';
  resolveMinutes(sec.tokens);
  sec.tokens = dateTokens(sec);
  for (const tok of sec.tokens) flagDatePart(sec, tok);
}

/** The m rule: m/mm right after an hour or right before a second is minutes. */
function resolveMinutes(src: Token[]): void {
  for (let j = 0; j < src.length; j++) {
    const tok = src[j]!;
    if (tok.t !== 'month' || tok.n > 2) continue;
    let prev = j - 1;
    while (prev >= 0 && !isDatePart(src[prev])) prev--;
    let next = j + 1;
    while (next < src.length && !isDatePart(src[next])) next++;
    if (isHourPart(src[prev]) || isSecondPart(src[next])) src[j] = { t: 'minute', n: tok.n };
  }
}

/** Number syntax inside a date section is literal, except `.000` after seconds. */
function dateTokens(sec: Section): Token[] {
  const src = sec.tokens;
  const out: Token[] = [];
  let j = 0;
  while (j < src.length) {
    const tok = src[j]!;
    const k = tok.t === 'point' ? subsecondDigits(src, j, out) : 0;
    if (k > 0) {
      out.push({ t: 'subsec', n: k });
      sec.subsec = Math.max(sec.subsec, Math.min(k, 3));
      j += k;
    } else {
      const s = dateLiteral(tok);
      if (s === null) out.push(tok);
      else pushLit(out, s);
    }
    j++;
  }
  return out;
}

/** How many `0` placeholders follow the point at `j` when it continues seconds (ss.000); 0 otherwise. */
function subsecondDigits(src: Token[], j: number, out: Token[]): number {
  let k = 0;
  for (let next = src[j + 1]; next?.t === 'digit' && next.c === '0'; next = src[j + 1 + k]) k++;
  if (k === 0) return 0;
  let prev = out.length - 1;
  while (prev >= 0 && out[prev]!.t === 'lit') prev--;
  return isSecondPart(out[prev]) ? k : 0;
}

/** The literal text a number-syntax token stands for in a date section; null for tokens that stay. */
function dateLiteral(tok: Token): string | null {
  switch (tok.t) {
    case 'point':
      return '.';
    case 'digit':
      return tok.c;
    case 'comma':
      return ',';
    case 'percent':
      return '%';
    case 'slash':
      return `/${tok.fixed ?? ''}`;
    case 'exp':
      return `${tok.s}${tok.plus ? '+' : '-'}`;
    case 'general':
      return 'General';
    case 'at':
      return '';
    default:
      return null;
  }
}

function flagDatePart(sec: Section, tok: Token): void {
  switch (tok.t) {
    case 'year':
    case 'month':
    case 'day':
      sec.hasDate = true;
      break;
    case 'elapsed':
      sec.hasElapsed = true;
      break;
    case 'ampm':
      sec.hasTime = true;
      sec.hour12 = true;
      break;
    case 'hour':
    case 'minute':
    case 'second':
    case 'subsec':
      sec.hasTime = true;
      break;
    default:
      break;
  }
}

function isDigitAt(tokens: Token[], j: number): boolean {
  return tokens[j]?.t === 'digit';
}

function analyseNumber(sec: Section): void {
  const tokens = sec.tokens;
  sec.parts = tokens.map(() => null);
  sec.percent = tokens.filter((t) => t.t === 'percent').length;
  if (tokens.some((t) => t.t === 'general')) {
    sec.mode = 'general';
    return;
  }
  const expIdx = tokens.findIndex((t) => t.t === 'exp');
  if (expIdx >= 0 && tokens.slice(expIdx + 1).some((t) => t.t === 'digit')) {
    analyseScientific(sec, expIdx);
    return;
  }
  const slashIdx = tokens.findIndex((t) => t.t === 'slash');
  const slash = tokens[slashIdx];
  if (
    slash?.t === 'slash' &&
    isDigitAt(tokens, slashIdx - 1) &&
    (slash.fixed !== undefined || isDigitAt(tokens, slashIdx + 1))
  ) {
    analyseFraction(sec, slashIdx);
    return;
  }
  analyseDecimal(sec);
}

/** Mantissa digits are integer or fraction places around the point; digits after the E are the exponent. */
function analyseScientific(sec: Section, expIdx: number): void {
  sec.mode = 'scientific';
  const { tokens, parts } = sec;
  let seenPoint = false;
  for (let j = 0; j < expIdx; j++) {
    const t = tokens[j]!;
    if (t.t === 'point') seenPoint = true;
    else if (t.t === 'digit') parts[j] = seenPoint ? 'frac' : 'int';
  }
  for (let j = expIdx + 1; j < tokens.length; j++) {
    if (tokens[j]!.t === 'digit') parts[j] = 'exp';
  }
}

/** The digit run before the slash is the numerator, the one after it the denominator; earlier digits the whole part. */
function analyseFraction(sec: Section, slashIdx: number): void {
  sec.mode = 'fraction';
  const { tokens, parts } = sec;
  let j = slashIdx - 1;
  while (isDigitAt(tokens, j)) parts[j--] = 'num';
  for (; j >= 0; j--) if (isDigitAt(tokens, j)) parts[j] = 'int';
  for (let k = slashIdx + 1; isDigitAt(tokens, k); k++) parts[k] = 'den';
}

function analyseDecimal(sec: Section): void {
  sec.mode = 'decimal';
  const { tokens, parts } = sec;
  const pointIdx = tokens.findIndex((t) => t.t === 'point');
  let firstDigit = -1;
  let lastDigit = -1;
  for (let j = 0; j < tokens.length; j++) {
    if (tokens[j]!.t !== 'digit') continue;
    parts[j] = pointIdx >= 0 && j > pointIdx ? 'frac' : 'int';
    if (firstDigit < 0) firstDigit = j;
    lastDigit = j;
  }
  if (firstDigit >= 0) analyseCommas(sec, pointIdx, firstDigit, lastDigit);
}

/**
 * A comma between integer placeholders groups thousands; each comma after
 * the last placeholder scales the number down by 1,000.
 */
function analyseCommas(sec: Section, pointIdx: number, firstDigit: number, lastDigit: number): void {
  const tokens = sec.tokens;
  for (let j = firstDigit; j < tokens.length; j++) {
    if (tokens[j]!.t !== 'comma') continue;
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

/** What an unused placeholder shows: 0 a zero, ? a space, # nothing. */
function padChar(c: DigitChar): string {
  if (c === '0') return '0';
  return c === '?' ? ' ' : '';
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

/**
 * Renders a number section in three steps: the mode fills the digit
 * placeholders into `out` (one string per token), then `assemble` joins them
 * with the other tokens.
 */
function renderNumber(sec: Section, value: number, locale: FormatLocale): string {
  const x = (Math.abs(value) * 100 ** sec.percent) / 1000 ** sec.scale;
  const out: string[] = sec.tokens.map(() => '');
  switch (sec.mode) {
    case 'general':
      return assemble(sec, out, generalText(x, locale), '', null, locale);
    case 'decimal':
      return assemble(sec, out, fillDecimal(sec, x, out, locale), '', null, locale);
    case 'scientific':
      return renderScientific(sec, x, out, locale);
    default:
      return assemble(sec, out, '', '', fillFraction(sec, x, out), locale);
  }
}

/** Decimal mode: fills integer and fraction placeholders; returns the integer digits ('' for 0). */
function fillDecimal(sec: Section, x: number, out: string[], locale: FormatLocale): string {
  const { tokens, idx } = sec;
  const r = roundDigits(x, idx.frac.length);
  const intText = r.int === '0' ? '' : r.int;
  fillRight(intText, idx.int, tokens, out);
  if (sec.grouping) groupDigits(idx.int, out, locale.group);
  fillDecimals(r.frac, idx.frac, tokens, out);
  return intText;
}

function renderScientific(sec: Section, x: number, out: string[], locale: FormatLocale): string {
  const { tokens, idx } = sec;
  const ic = idx.int.length;
  const decimals = idx.frac.length;
  // Engineering notation (##0.0E+0): the exponent stays a multiple of the integer width.
  const engineering = ic > 1 && idx.int.some((j) => digitChar(tokens, j) === '#');
  const width = engineering ? ic : Math.max(ic, 1);
  let e = 0;
  let r = roundDigits(0, decimals);
  if (x !== 0) {
    const e10 = Number(x.toExponential().split('e')[1]);
    e = engineering ? Math.floor(e10 / ic) * ic : e10 - width + 1;
    r = roundDigits(x * 10 ** -e, decimals);
    // Rounding carried into an extra integer digit (9.99 → 10.0): move one step.
    if (r.int.length > width) {
      e += engineering ? ic : 1;
      r = roundDigits(x * 10 ** -e, decimals);
    }
  }
  const intText = r.int === '0' ? '' : r.int;
  fillRight(intText, idx.int, tokens, out);
  fillDecimals(r.frac, idx.frac, tokens, out);
  return assemble(sec, out, intText, fillExponent(sec, e, out), null, locale);
}

/** Fills the exponent placeholders; returns the sign shown after the E. */
function fillExponent(sec: Section, e: number, out: string[]): string {
  fillRight(e === 0 ? '' : String(Math.abs(e)), sec.idx.exp, sec.tokens, out);
  if (e < 0) return '-';
  const expTok = sec.tokens.find((t) => t.t === 'exp');
  return expTok?.t === 'exp' && expTok.plus ? '+' : '';
}

/** The literal denominator of `# ??/16`, 0 for a computed one. */
function fixedDenominator(slash: Token | undefined): number {
  return slash?.t === 'slash' && slash.fixed !== undefined ? Number(slash.fixed) : 0;
}

/** The whole-number part of a fraction: blank for a pure fraction ("1/2"), "0" for zero itself. */
function wholeText(whole: number, numerator: number): string {
  if (whole !== 0) return String(whole);
  return numerator === 0 ? '0' : '';
}

/**
 * Fraction mode: fills the whole part, numerator and denominator. Returns
 * the token span (numerator to denominator) to blank out when the fraction
 * part is zero, else null.
 */
function fillFraction(sec: Section, x: number, out: string[]): [number, number] | null {
  const { tokens, idx } = sec;
  const slashIdx = tokens.findIndex((t) => t.t === 'slash');
  const fixed = fixedDenominator(tokens[slashIdx]);
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
  let blank: [number, number] | null = null;
  if (hasInt) {
    fillRight(wholeText(whole, n), idx.int, tokens, out);
    if (n === 0) blank = [idx.num[0] ?? slashIdx, fixed ? slashIdx : (idx.den[idx.den.length - 1] ?? slashIdx)];
  }
  fillRight(String(n), idx.num, tokens, out);
  if (!fixed) fillLeft(String(d), idx.den, tokens, out);
  return blank;
}

/**
 * Joins a number section's tokens: digit placeholders from `out`, the
 * integer digits before the first point when no placeholder took them,
 * `expSign` after the E, and spaces over the `blank` span.
 */
function assemble(
  sec: Section,
  out: string[],
  intText: string,
  expSign: string,
  blank: [number, number] | null,
  locale: FormatLocale,
): string {
  const tokens = sec.tokens;
  let text = '';
  let beforePoint = sec.idx.int.length > 0 ? '' : intText;
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
        s = beforePoint + locale.decimal;
        beforePoint = '';
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

/** h / hh, m / mm, s / ss and d / dd: one digit or zero-padded to two. */
function twoDigit(n: number, v: number): string {
  return n === 1 ? String(v) : pad2(v);
}

function yearText(n: number, year: number): string {
  return n <= 2 ? pad2(year % 100) : String(year).padStart(4, '0');
}

/** m, mm, mmm (Jan), mmmm (January), mmmmm (J); six or more m's read as mmmm. */
function monthText(n: number, month: number, locale: FormatLocale): string {
  switch (n) {
    case 1:
      return String(month);
    case 2:
      return pad2(month);
    case 3:
      return locale.monthShort[month - 1] ?? '';
    case 5:
      return (locale.monthNames[month - 1] ?? '').charAt(0);
    default:
      return locale.monthNames[month - 1] ?? '';
  }
}

/** d, dd: the day of the month; ddd (Mon), dddd (Monday): the weekday of serial day `day`. */
function dayText(n: number, dayOfMonth: number, day: number, locale: FormatLocale): string {
  if (n <= 2) return twoDigit(n, dayOfMonth);
  const w = weekdayFromSerial(day);
  return (n === 3 ? locale.dayShort[w] : locale.dayNames[w]) ?? '';
}

function ampmText(t: { short: boolean; lower: boolean }, hour: number, locale: FormatLocale): string {
  const pm = hour >= 12;
  if (!t.short) return pm ? locale.ampm[1] : locale.ampm[0];
  if (pm) return t.lower ? 'p' : 'P';
  return t.lower ? 'a' : 'A';
}

/** [h], [mm], [ss]: the whole duration in one unit, zero-padded to the run length. */
function elapsedText(unit: 'h' | 'm' | 's', n: number, totalSeconds: number): string {
  let v = totalSeconds;
  if (unit === 'h') v = Math.floor(totalSeconds / 3600);
  else if (unit === 'm') v = Math.floor(totalSeconds / 60);
  return String(v).padStart(n, '0');
}

/** The date parts shown when a section has no date tokens (its serial's date is never read). */
const NO_DATE = { year: 1900, month: 1, day: 0 };

function renderDate(sec: Section, serial: number, locale: FormatLocale): string | null {
  if (Number.isNaN(serial) || serial < 0 || serial >= MAX_DATE_SERIAL) return null;
  // Round to the shown precision first, so 23:59:59.7 reads as the next day.
  const sub = 10 ** sec.subsec;
  const total = Math.round(serial * 86_400 * sub);
  const totalSeconds = Math.floor(total / sub);
  const fraction = total - totalSeconds * sub;
  const day = Math.floor(totalSeconds / 86_400);
  const secs = totalSeconds - day * 86_400;
  const hour = Math.floor(secs / 3600);
  const shownHour = sec.hour12 ? hour % 12 || 12 : hour;
  const minute = Math.floor((secs % 3600) / 60);
  const second = secs % 60;
  const ymd = sec.hasDate ? ymdFromSerial(day) : NO_DATE;

  let text = '';
  for (const t of sec.tokens) {
    switch (t.t) {
      case 'lit':
        text += t.s;
        break;
      case 'year':
        text += yearText(t.n, ymd.year);
        break;
      case 'month':
        text += monthText(t.n, ymd.month, locale);
        break;
      case 'day':
        text += dayText(t.n, ymd.day, day, locale);
        break;
      case 'hour':
        text += twoDigit(t.n, shownHour);
        break;
      case 'minute':
        text += twoDigit(t.n, minute);
        break;
      case 'second':
        text += twoDigit(t.n, second);
        break;
      case 'subsec':
        text += locale.decimal + String(fraction).padStart(sec.subsec, '0').slice(0, t.n).padEnd(t.n, '0');
        break;
      case 'ampm':
        text += ampmText(t, hour, locale);
        break;
      case 'elapsed':
        text += elapsedText(t.unit, t.n, totalSeconds);
        break;
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
  return formatNumber(c, value, locale);
}

/** formatValue for a number: picks the section and renders it, falling back to General. */
function formatNumber(c: Compiled, value: number, locale: FormatLocale): FormattedValue {
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
  return sec.kind === 'date' ? dateCategory(sec) : numberCategory(sec);
}

function dateCategory(sec: Section): FormatCategory {
  if (sec.hasElapsed) return 'duration';
  if (sec.hasDate && sec.hasTime) return 'datetime';
  return sec.hasDate ? 'date' : 'time';
}

function numberCategory(sec: Section): FormatCategory {
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
