/**
 * Text functions. Numbers become text with General formatting; text that
 * must be a number (VALUE, TEXT) goes through the same parser as cell input.
 */

import { parseInput } from '../../format/input';
import { EN_LOCALE, formatValue } from '../../format/number-format';
import {
  ERR,
  isError,
  isMatrix,
  isRange,
  matrix,
  type CellError,
  type EvalValue,
  type Scalar,
} from '../../values';
import type { EvalContext, FunctionSpec } from '../types';
import { bool, int, num, opt, text, toScalar, values2d } from './helpers';

/** Longest string a cell can hold in Excel. */
const MAX_TEXT = 32_767;

type Impl = (args: EvalValue[], ctx: EvalContext) => EvalValue;

/** An element-wise function: every argument is lifted over arrays. */
function scalarFn(name: string, minArgs: number, maxArgs: number, impl: Impl): FunctionSpec {
  return { name, minArgs, maxArgs, scalarArgs: 'all', impl };
}

function capped(s: string): string | CellError {
  return s.length > MAX_TEXT ? ERR.value : s;
}

/** Every value of an argument, row-major, blanks included. */
function flat(v: EvalValue, ctx: EvalContext): Scalar[] | CellError {
  if (isRange(v) || isMatrix(v)) {
    const d = values2d(v, ctx);
    return isError(d) ? d : d.flat();
  }
  return [v];
}

/** One or more delimiters (TEXTJOIN, TEXTBEFORE, TEXTSPLIT take an array of them). */
function textList(v: EvalValue, ctx: EvalContext): string[] | CellError {
  const values = flat(v, ctx);
  if (isError(values)) return values;
  const out: string[] = [];
  for (const x of values) {
    const t = text(x, ctx);
    if (isError(t)) return t;
    out.push(t);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** SEARCH patterns: * any run, ? one char, ~ escapes; not anchored. */
function searchRegExp(pattern: string): RegExp {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '~' && i + 1 < pattern.length) src += escapeRe(pattern[++i]!);
    else if (ch === '*') src += '[\\s\\S]*';
    else if (ch === '?') src += '[\\s\\S]';
    else src += escapeRe(ch);
  }
  return new RegExp(src, 'i');
}

interface Match {
  start: number;
  end: number;
}

/** Non-overlapping matches of any delimiter, left to right; the longest wins at a position. */
function findAll(s: string, delims: readonly string[], ignoreCase: boolean): Match[] {
  const hay = ignoreCase ? s.toLowerCase() : s;
  const ds = delims.filter((d) => d !== '').map((d) => (ignoreCase ? d.toLowerCase() : d));
  const out: Match[] = [];
  let i = 0;
  while (i <= hay.length && ds.length > 0) {
    let best = -1;
    let len = 0;
    for (const d of ds) {
      const pos = hay.indexOf(d, i);
      if (pos >= 0 && (best < 0 || pos < best || (pos === best && d.length > len))) {
        best = pos;
        len = d.length;
      }
    }
    if (best < 0) break;
    out.push({ start: best, end: best + len });
    i = best + len;
  }
  return out;
}

function splitBy(s: string, delims: readonly string[], ignoreCase: boolean): string[] {
  const parts: string[] = [];
  let from = 0;
  for (const m of findAll(s, delims, ignoreCase)) {
    parts.push(s.slice(from, m.start));
    from = m.end;
  }
  parts.push(s.slice(from));
  return parts;
}

/** Windows-1252 characters for codes 128–159 (CHAR/CODE); gaps map to themselves. */
const CP1252: Record<number, number> = {
  128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020, 135: 0x2021,
  136: 0x02c6, 137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152, 142: 0x017d, 145: 0x2018,
  146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022, 150: 0x2013, 151: 0x2014, 152: 0x02dc,
  153: 0x2122, 154: 0x0161, 155: 0x203a, 156: 0x0153, 158: 0x017e, 159: 0x0178,
};
const CP1252_REVERSE = new Map(Object.entries(CP1252).map(([k, v]) => [v, Number(k)]));

/** VALUETOTEXT/ARRAYTOTEXT rendering of one value; strict quotes text. */
function valueText(v: Scalar, strict: boolean): string {
  if (v === null) return '';
  if (isError(v)) return v.code;
  if (typeof v === 'string') return strict ? `"${v.replace(/"/g, '""')}"` : v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return formatValue(v, undefined).text;
}

/** Rounds half away from zero to `decimals` places, which may be negative (FIXED, DOLLAR). */
function roundTo(n: number, decimals: number): number {
  if (decimals >= 0) return n;
  const f = 10 ** -decimals;
  return Math.sign(n) * Math.round(Math.abs(n) / f) * f;
}

function textBeforeAfter(args: EvalValue[], ctx: EvalContext, after: boolean): EvalValue {
  const s = text(args[0]!, ctx);
  if (isError(s)) return s;
  const delims = textList(args[1]!, ctx);
  if (isError(delims)) return delims;
  const instance = opt(args, 2, 1, (v) => int(v, ctx));
  if (isError(instance)) return instance;
  const mode = opt(args, 3, 0, (v) => int(v, ctx));
  if (isError(mode)) return mode;
  const matchEnd = opt(args, 4, false, (v) => bool(v, ctx));
  if (isError(matchEnd)) return matchEnd;
  if (instance === 0 || (mode !== 0 && mode !== 1)) return ERR.value;
  const notFound = (): EvalValue => (args.length > 5 ? (toScalar(args[5]!, ctx) ?? '') : ERR.na);
  if (Math.abs(instance) > s.length && !delims.includes('')) return notFound();

  let pick: Match | undefined;
  if (delims.includes('')) {
    pick = instance > 0 ? { start: 0, end: 0 } : { start: s.length, end: s.length };
  } else {
    const matches = findAll(s, delims, mode === 1);
    if (matchEnd) {
      if (instance > 0) matches.push({ start: s.length, end: s.length });
      else matches.unshift({ start: 0, end: 0 });
    }
    pick = instance > 0 ? matches[instance - 1] : matches[matches.length + instance];
  }
  if (!pick) return notFound();
  return after ? s.slice(pick.end) : s.slice(0, pick.start);
}

function regex(pattern: string, caseArg: number, global: boolean): RegExp | CellError {
  if (caseArg !== 0 && caseArg !== 1) return ERR.value;
  try {
    return new RegExp(pattern, (global ? 'g' : '') + (caseArg === 1 ? 'i' : ''));
  } catch {
    return { ...ERR.value, message: 'Invalid regular expression' };
  }
}

/** $1, $<name>, $& and $$ in a replacement for one match. */
function expandReplacement(rep: string, m: RegExpMatchArray): string {
  return rep.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (tok: string, what: string, name: string | undefined) => {
    if (what === '$') return '$';
    if (what === '&') return m[0];
    if (name !== undefined) return m.groups?.[name] ?? '';
    const n = Number(what);
    return n >= 1 && n < m.length ? (m[n] ?? '') : tok;
  });
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// ---------------------------------------------------------------------------
// Implementations shared by the byte (…B) variants. Byte counting only
// differs in double-byte (CJK) Excel locales, which are not modelled.
// ---------------------------------------------------------------------------

const left: Impl = (args, ctx) => {
  const s = text(args[0]!, ctx);
  if (isError(s)) return s;
  const n = opt(args, 1, 1, (v) => int(v, ctx));
  if (isError(n)) return n;
  return n < 0 ? ERR.value : s.slice(0, n);
};

const right: Impl = (args, ctx) => {
  const s = text(args[0]!, ctx);
  if (isError(s)) return s;
  const n = opt(args, 1, 1, (v) => int(v, ctx));
  if (isError(n)) return n;
  if (n < 0) return ERR.value;
  return n === 0 ? '' : s.slice(Math.max(0, s.length - n));
};

const mid: Impl = (args, ctx) => {
  const s = text(args[0]!, ctx);
  if (isError(s)) return s;
  const start = int(args[1]!, ctx);
  if (isError(start)) return start;
  const n = int(args[2]!, ctx);
  if (isError(n)) return n;
  if (start < 1 || n < 0) return ERR.value;
  return s.slice(start - 1, start - 1 + n);
};

const len: Impl = (args, ctx) => {
  const s = text(args[0]!, ctx);
  return isError(s) ? s : s.length;
};

const replace: Impl = (args, ctx) => {
  const s = text(args[0]!, ctx);
  if (isError(s)) return s;
  const start = int(args[1]!, ctx);
  if (isError(start)) return start;
  const n = int(args[2]!, ctx);
  if (isError(n)) return n;
  const repl = text(args[3]!, ctx);
  if (isError(repl)) return repl;
  if (start < 1 || n < 0) return ERR.value;
  return capped(s.slice(0, start - 1) + repl + s.slice(start - 1 + n));
};

const find: Impl = (args, ctx) => {
  const needle = text(args[0]!, ctx);
  if (isError(needle)) return needle;
  const hay = text(args[1]!, ctx);
  if (isError(hay)) return hay;
  const start = opt(args, 2, 1, (v) => int(v, ctx));
  if (isError(start)) return start;
  if (start < 1 || start > hay.length + 1) return ERR.value;
  const at = hay.indexOf(needle, start - 1);
  return at < 0 ? ERR.value : at + 1;
};

const search: Impl = (args, ctx) => {
  const needle = text(args[0]!, ctx);
  if (isError(needle)) return needle;
  const hay = text(args[1]!, ctx);
  if (isError(hay)) return hay;
  const start = opt(args, 2, 1, (v) => int(v, ctx));
  if (isError(start)) return start;
  if (start < 1 || start > hay.length + 1) return ERR.value;
  const at = hay.slice(start - 1).search(searchRegExp(needle));
  return at < 0 ? ERR.value : at + start;
};

const fixedLike =
  (currency: boolean): Impl =>
  (args, ctx) => {
    const n = num(args[0]!, ctx);
    if (isError(n)) return n;
    const decimals = opt(args, 1, 2, (v) => int(v, ctx));
    if (isError(decimals)) return decimals;
    const noCommas = currency ? false : opt(args, 2, false, (v) => bool(v, ctx));
    if (isError(noCommas)) return noCommas;
    if (decimals > 127) return ERR.value;
    const body = (noCommas ? '0' : '#,##0') + (decimals > 0 ? `.${'0'.repeat(decimals)}` : '');
    const code = currency ? `"$"${body};("$"${body})` : body;
    return formatValue(roundTo(n, decimals), code).text;
  };

const textBefore: Impl = (args, ctx) => textBeforeAfter(args, ctx, false);
const textAfter: Impl = (args, ctx) => textBeforeAfter(args, ctx, true);

export const textFunctions: FunctionSpec[] = [
  {
    name: 'CONCAT',
    minArgs: 1,
    maxArgs: 255,
    impl(args, ctx) {
      let out = '';
      for (const a of args) {
        const values = flat(a, ctx);
        if (isError(values)) return values;
        for (const v of values) {
          const t = text(v, ctx);
          if (isError(t)) return t;
          out += t;
          if (out.length > MAX_TEXT) return ERR.value;
        }
      }
      return out;
    },
  },
  scalarFn('CONCATENATE', 1, 255, (args, ctx) => {
    let out = '';
    for (const a of args) {
      const t = text(a, ctx);
      if (isError(t)) return t;
      out += t;
    }
    return capped(out);
  }),
  {
    name: 'TEXTJOIN',
    minArgs: 3,
    maxArgs: 255,
    impl(args, ctx) {
      const delims = textList(args[0]!, ctx);
      if (isError(delims)) return delims;
      const ignoreEmpty = bool(args[1]!, ctx);
      if (isError(ignoreEmpty)) return ignoreEmpty;
      const parts: string[] = [];
      for (const a of args.slice(2)) {
        const values = flat(a, ctx);
        if (isError(values)) return values;
        for (const v of values) {
          const t = text(v, ctx);
          if (isError(t)) return t;
          if (!(ignoreEmpty && t === '')) parts.push(t);
        }
      }
      let out = parts[0] ?? '';
      for (let i = 1; i < parts.length; i++) {
        out += (delims.length ? delims[(i - 1) % delims.length]! : '') + parts[i]!;
        if (out.length > MAX_TEXT) return ERR.value;
      }
      return out;
    },
  },
  scalarFn('LEFT', 1, 2, left),
  scalarFn('LEFTB', 1, 2, left),
  scalarFn('RIGHT', 1, 2, right),
  scalarFn('RIGHTB', 1, 2, right),
  scalarFn('MID', 3, 3, mid),
  scalarFn('MIDB', 3, 3, mid),
  scalarFn('LEN', 1, 1, len),
  scalarFn('LENB', 1, 1, len),
  scalarFn('LOWER', 1, 1, (args, ctx) => {
    const s = text(args[0]!, ctx);
    return isError(s) ? s : s.toLowerCase();
  }),
  scalarFn('UPPER', 1, 1, (args, ctx) => {
    const s = text(args[0]!, ctx);
    return isError(s) ? s : s.toUpperCase();
  }),
  scalarFn('PROPER', 1, 1, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    // Upper-case a letter after any non-letter (digits and apostrophes included, as Excel does).
    let out = '';
    let prevLetter = false;
    for (const ch of s) {
      const letter = /\p{L}/u.test(ch);
      out += letter ? (prevLetter ? ch.toLowerCase() : ch.toUpperCase()) : ch;
      prevLetter = letter;
    }
    return out;
  }),
  scalarFn('TRIM', 1, 1, (args, ctx) => {
    const s = text(args[0]!, ctx);
    // Only the ASCII space, unlike String#trim.
    return isError(s) ? s : s.replace(/^ +| +$/g, '').replace(/ {2,}/g, ' ');
  }),
  scalarFn('CLEAN', 1, 1, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    let out = '';
    for (const ch of s) if (ch.charCodeAt(0) >= 32) out += ch;
    return out;
  }),
  scalarFn('SUBSTITUTE', 3, 4, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    const from = text(args[1]!, ctx);
    if (isError(from)) return from;
    const to = text(args[2]!, ctx);
    if (isError(to)) return to;
    const instance = opt<number | null>(args, 3, null, (v) => int(v, ctx));
    if (isError(instance)) return instance;
    if (instance !== null && instance < 1) return ERR.value;
    if (from === '') return s;
    if (instance === null) return capped(s.split(from).join(to));
    let at = -from.length;
    for (let k = 0; k < instance; k++) {
      at = s.indexOf(from, at + from.length);
      if (at < 0) return s;
    }
    return capped(s.slice(0, at) + to + s.slice(at + from.length));
  }),
  scalarFn('REPLACE', 4, 4, replace),
  scalarFn('REPLACEB', 4, 4, replace),
  scalarFn('FIND', 2, 3, find),
  scalarFn('FINDB', 2, 3, find),
  scalarFn('SEARCH', 2, 3, search),
  scalarFn('SEARCHB', 2, 3, search),
  scalarFn('REPT', 2, 2, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    const n = int(args[1]!, ctx);
    if (isError(n)) return n;
    if (n < 0 || s.length * n > MAX_TEXT) return ERR.value;
    return s.repeat(n);
  }),
  scalarFn('TEXT', 2, 2, (args, ctx) => {
    const v = toScalar(args[0]!, ctx);
    if (isError(v)) return v;
    const code = text(args[1]!, ctx);
    if (isError(code)) return code;
    let value: Scalar = v ?? 0;
    if (typeof value === 'string') {
      const p = parseInput(value, { locale: EN_LOCALE });
      if (p.kind === 'value' && typeof p.value === 'number') value = p.value;
    }
    const r = formatValue(value, code, EN_LOCALE);
    return r.overflow ? ERR.value : r.text;
  }),
  scalarFn('VALUE', 1, 1, (args, ctx) => {
    const v = toScalar(args[0]!, ctx);
    if (v === null) return 0;
    if (typeof v === 'number' || isError(v)) return v;
    if (typeof v === 'boolean' || v.trim() === '') return ERR.value;
    const p = parseInput(v, { locale: EN_LOCALE });
    return p.kind === 'value' && typeof p.value === 'number' ? p.value : ERR.value;
  }),
  scalarFn('NUMBERVALUE', 1, 3, (args, ctx) => {
    const v = toScalar(args[0]!, ctx);
    if (v === null) return 0;
    if (typeof v === 'number' || isError(v)) return v;
    if (typeof v === 'boolean') return ERR.value;
    const dec = opt(args, 1, '.', (x) => text(x, ctx));
    if (isError(dec)) return dec;
    const grp = opt(args, 2, ',', (x) => text(x, ctx));
    if (isError(grp)) return grp;
    // Only the first character of each separator counts.
    const d = dec.charAt(0) || '.';
    const g = grp.charAt(0) || ',';
    if (d === g) return ERR.value;
    let s = v.replace(/\s+/g, '');
    if (s === '') return 0;
    let percents = 0;
    while (s.endsWith('%')) {
      percents++;
      s = s.slice(0, -1);
    }
    const at = s.indexOf(d);
    if (at >= 0 && (s.indexOf(d, at + 1) >= 0 || s.slice(at + 1).includes(g))) return ERR.value;
    const intPart = (at >= 0 ? s.slice(0, at) : s).split(g).join('');
    const plain = at >= 0 ? `${intPart}.${s.slice(at + 1)}` : intPart;
    if (!NUMERIC.test(plain)) return ERR.value;
    return Number(plain) / 100 ** percents;
  }),
  scalarFn('FIXED', 1, 3, fixedLike(false)),
  scalarFn('DOLLAR', 1, 2, fixedLike(true)),
  scalarFn('EXACT', 2, 2, (args, ctx) => {
    const a = text(args[0]!, ctx);
    if (isError(a)) return a;
    const b = text(args[1]!, ctx);
    return isError(b) ? b : a === b;
  }),
  scalarFn('CHAR', 1, 1, (args, ctx) => {
    const n = int(args[0]!, ctx);
    if (isError(n)) return n;
    if (n < 1 || n > 255) return ERR.value;
    return String.fromCharCode(CP1252[n] ?? n);
  }),
  scalarFn('UNICHAR', 1, 1, (args, ctx) => {
    const n = int(args[0]!, ctx);
    if (isError(n)) return n;
    if (n < 1 || n > 0x10ffff) return ERR.value;
    if (n >= 0xd800 && n <= 0xdfff) return ERR.na;
    return String.fromCodePoint(n);
  }),
  scalarFn('CODE', 1, 1, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    if (s === '') return ERR.value;
    const c = s.charCodeAt(0);
    if (c < 128 || (c >= 160 && c <= 255)) return c;
    const mapped = CP1252_REVERSE.get(c);
    if (mapped !== undefined) return mapped;
    return c < 160 ? c : 63; // '?' for characters outside the code page
  }),
  scalarFn('UNICODE', 1, 1, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    return s === '' ? ERR.value : (s.codePointAt(0) ?? ERR.value);
  }),
  scalarFn('T', 1, 1, (args, ctx) => {
    const v = toScalar(args[0]!, ctx);
    if (isError(v)) return v;
    return typeof v === 'string' ? v : '';
  }),
  { name: 'TEXTBEFORE', minArgs: 2, maxArgs: 6, scalarArgs: [0, 2, 3, 4, 5], impl: textBefore },
  { name: 'TEXTAFTER', minArgs: 2, maxArgs: 6, scalarArgs: [0, 2, 3, 4, 5], impl: textAfter },
  {
    name: 'TEXTSPLIT',
    minArgs: 2,
    maxArgs: 6,
    impl(args, ctx) {
      const s = text(args[0]!, ctx);
      if (isError(s)) return s;
      const delims = (i: number): string[] | CellError => {
        const a = args[i];
        if (a === undefined || a === null) return [];
        const list = textList(a, ctx);
        return isError(list) ? list : list.filter((d) => d !== '');
      };
      const colD = delims(1);
      if (isError(colD)) return colD;
      const rowD = delims(2);
      if (isError(rowD)) return rowD;
      const ignoreEmpty = opt(args, 3, false, (v) => bool(v, ctx));
      if (isError(ignoreEmpty)) return ignoreEmpty;
      const mode = opt(args, 4, 0, (v) => int(v, ctx));
      if (isError(mode)) return mode;
      if ((colD.length === 0 && rowD.length === 0) || (mode !== 0 && mode !== 1)) return ERR.value;
      const pad: Scalar = args[5] === undefined || args[5] === null ? ERR.na : toScalar(args[5], ctx);

      let rows = rowD.length ? splitBy(s, rowD, mode === 1) : [s];
      if (ignoreEmpty) rows = rows.filter((r) => r !== '');
      const data: Scalar[][] = rows.map((r) => {
        const cells = colD.length ? splitBy(r, colD, mode === 1) : [r];
        return ignoreEmpty ? cells.filter((c) => c !== '') : cells;
      });
      const width = Math.max(1, ...data.map((r) => r.length));
      if (data.length === 0) return ERR.calc;
      for (const r of data) while (r.length < width) r.push(pad);
      return matrix(data);
    },
  },
  scalarFn('VALUETOTEXT', 1, 2, (args, ctx) => {
    const format = opt(args, 1, 0, (v) => int(v, ctx));
    if (isError(format)) return format;
    if (format !== 0 && format !== 1) return ERR.value;
    return valueText(toScalar(args[0]!, ctx), format === 1);
  }),
  {
    name: 'ARRAYTOTEXT',
    minArgs: 1,
    maxArgs: 2,
    scalarArgs: [1],
    impl(args, ctx) {
      const format = opt(args, 1, 0, (v) => int(v, ctx));
      if (isError(format)) return format;
      if (format !== 0 && format !== 1) return ERR.value;
      const a = args[0]!;
      const data = isRange(a) || isMatrix(a) ? values2d(a, ctx) : [[a]];
      if (isError(data)) return data;
      const strict = format === 1;
      const out = strict
        ? `{${data.map((row) => row.map((v) => valueText(v, true)).join(',')).join(';')}}`
        : data.flat().map((v) => valueText(v, false)).join(', ');
      return capped(out);
    },
  },
  scalarFn('REGEXMATCH', 2, 2, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    const p = text(args[1]!, ctx);
    if (isError(p)) return p;
    const re = regex(p, 0, false);
    return isError(re) ? re : re.test(s);
  }),
  scalarFn('REGEXTEST', 2, 3, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    const p = text(args[1]!, ctx);
    if (isError(p)) return p;
    const cs = opt(args, 2, 0, (v) => int(v, ctx));
    if (isError(cs)) return cs;
    const re = regex(p, cs, false);
    return isError(re) ? re : re.test(s);
  }),
  scalarFn('REGEXEXTRACT', 2, 4, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    const p = text(args[1]!, ctx);
    if (isError(p)) return p;
    const mode = opt(args, 2, 0, (v) => int(v, ctx));
    if (isError(mode)) return mode;
    const cs = opt(args, 3, 0, (v) => int(v, ctx));
    if (isError(cs)) return cs;
    if (mode < 0 || mode > 2) return ERR.value;
    const re = regex(p, cs, mode === 1);
    if (isError(re)) return re;
    if (mode === 1) {
      const all = [...s.matchAll(re)].map((m): Scalar[] => [m[0]]);
      return all.length ? matrix(all) : ERR.na;
    }
    const m = re.exec(s);
    if (!m) return ERR.na;
    if (mode === 0 || m.length === 1) return m[0];
    return matrix([m.slice(1).map((g) => g ?? '')]);
  }),
  scalarFn('REGEXREPLACE', 3, 5, (args, ctx) => {
    const s = text(args[0]!, ctx);
    if (isError(s)) return s;
    const p = text(args[1]!, ctx);
    if (isError(p)) return p;
    const rep = text(args[2]!, ctx);
    if (isError(rep)) return rep;
    const occurrence = opt(args, 3, 0, (v) => int(v, ctx));
    if (isError(occurrence)) return occurrence;
    const cs = opt(args, 4, 0, (v) => int(v, ctx));
    if (isError(cs)) return cs;
    const re = regex(p, cs, true);
    if (isError(re)) return re;
    if (occurrence === 0) return capped(s.replace(re, rep));
    // Only the n-th match (counted from the end when negative).
    const matches = [...s.matchAll(re)];
    const m = occurrence > 0 ? matches[occurrence - 1] : matches[matches.length + occurrence];
    if (!m || m.index === undefined) return s;
    return capped(s.slice(0, m.index) + expandReplacement(rep, m) + s.slice(m.index + m[0].length));
  }),
  {
    // Google Sheets: splits into one row; numeric parts become numbers.
    name: 'SPLIT',
    minArgs: 2,
    maxArgs: 4,
    scalarArgs: [2, 3],
    impl(args, ctx) {
      const s = text(args[0]!, ctx);
      if (isError(s)) return s;
      const d = text(args[1]!, ctx);
      if (isError(d)) return d;
      const each = opt(args, 2, true, (v) => bool(v, ctx));
      if (isError(each)) return each;
      const removeEmpty = opt(args, 3, true, (v) => bool(v, ctx));
      if (isError(removeEmpty)) return removeEmpty;
      if (d === '') return ERR.value;
      let parts = each ? splitBy(s, [...d], false) : s.split(d);
      if (removeEmpty) parts = parts.filter((x) => x !== '');
      if (parts.length === 0) return '';
      return matrix([parts.map((x): Scalar => (NUMERIC.test(x.trim()) ? Number(x) : x))]);
    },
  },
  {
    // Google Sheets: joins values and arrays, blanks included.
    name: 'JOIN',
    minArgs: 2,
    maxArgs: 255,
    impl(args, ctx) {
      const d = text(args[0]!, ctx);
      if (isError(d)) return d;
      const parts: string[] = [];
      for (const a of args.slice(1)) {
        const values = flat(a, ctx);
        if (isError(values)) return values;
        for (const v of values) {
          const t = text(v, ctx);
          if (isError(t)) return t;
          parts.push(t);
        }
      }
      return capped(parts.join(d));
    },
  },
  scalarFn('HYPERLINK', 1, 2, (args, ctx) => {
    const url = text(args[0]!, ctx);
    if (isError(url)) return url;
    const label = args[1] === undefined ? null : toScalar(args[1], ctx);
    return label === null ? url : label;
  }),
];
