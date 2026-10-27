import {
  daysInMonth,
  EN_LOCALE,
  isDateFormat,
  serialFromYMD,
  translateFormula,
  ymdFromSerial,
  type CellContent,
  type CellPatch,
  type FormatLocale,
  type Range,
} from '@weldsuite/sheets-engine';

/** One source cell of a fill: what it holds, its style id, and its number format (dates step by day or month). */
export interface FillCell {
  content: CellContent | null;
  style: string | null;
  numFmt?: string;
}

export type FillDirection = 'down' | 'up' | 'right' | 'left';

export interface FillOptions {
  /**
   * Copy instead of continuing a series (dragging with Ctrl held). A single
   * number copies by default and counts up with Ctrl, as in Excel.
   */
  toggle: boolean;
  /** Always copy (Ctrl+D, Ctrl+R); formulas still move. */
  copy?: boolean;
  locale: FormatLocale;
}

/** What the k-th cell past the source (k = 1 is the next one) gets, with the source cell it repeats. */
export type LineSeries = (k: number) => { content: CellContent | null; from: number };

/** Which way `target` (the source range grown along one axis) extends `source`, or null when it does not. */
export function fillDirection(source: Range, target: Range): FillDirection | null {
  if (target.r2 > source.r2) return 'down';
  if (target.r1 < source.r1) return 'up';
  if (target.c2 > source.c2) return 'right';
  if (target.c1 < source.c1) return 'left';
  return null;
}

/**
 * Where a fill handle dragged to (row, col) fills: the source grown towards
 * the pointer along the axis it moved furthest on, or shrunk back inside it
 * (the cells left out are cleared).
 */
export function fillTarget(source: Range, row: number, col: number): Range {
  const dRow = beyond(row, source.r1, source.r2);
  const dCol = beyond(col, source.c1, source.c2);
  if (dRow === 0 && dCol === 0) return shrunk(source, row, col);
  if (Math.abs(dRow) >= Math.abs(dCol)) return dRow > 0 ? { ...source, r2: row } : { ...source, r1: row };
  return dCol > 0 ? { ...source, c2: col } : { ...source, c1: col };
}

/** How far `p` lies past [lo, hi]: negative before it, 0 inside. */
function beyond(p: number, lo: number, hi: number): number {
  if (p > hi) return p - hi;
  if (p < lo) return p - lo;
  return 0;
}

/** The source pulled back to (row, col) inside it, along the axis pulled back further. */
function shrunk(source: Range, row: number, col: number): Range {
  const rowsBack = source.r2 - row;
  const colsBack = source.c2 - col;
  if (rowsBack === 0 && colsBack === 0) return source;
  return rowsBack >= colsBack ? { ...source, r2: row } : { ...source, c2: col };
}

/** How many cells a fill adds to each line. */
function fillCount(source: Range, target: Range, dir: FillDirection): number {
  switch (dir) {
    case 'down':
      return target.r2 - source.r2;
    case 'up':
      return source.r1 - target.r1;
    case 'right':
      return target.c2 - source.c2;
    default:
      return source.c1 - target.c1;
  }
}

type CellAt = (row: number, col: number) => FillCell;

/** How one fill runs: its direction, how many cells it adds per line, and the lines across it. */
function plan(source: Range, target: Range) {
  const dir = fillDirection(source, target);
  if (!dir) return null;
  const vertical = dir === 'down' || dir === 'up';
  const forward = dir === 'down' || dir === 'right';
  const [srcLo, srcHi] = vertical ? [source.r1, source.r2] : [source.c1, source.c2];
  const count = fillCount(source, target, dir);
  // Source positions in fill order: nearest to the new cells last.
  const positions: number[] = [];
  if (forward) for (let p = srcLo; p <= srcHi; p++) positions.push(p);
  else for (let p = srcHi; p >= srcLo; p--) positions.push(p);
  const lines: [number, number] = vertical ? [source.c1, source.c2] : [source.r1, source.r2];
  /** The k-th new cell of a line, and the source cell it continues. */
  const cellOf = (line: number, k: number, from: number) => {
    const at = forward ? srcHi + k : srcLo - k;
    const pos = positions[from]!;
    return vertical ? { row: at, col: line, srcRow: pos, srcCol: line } : { row: line, col: at, srcRow: line, srcCol: pos };
  };
  const series = (line: number, cellAt: CellAt, opts: FillOptions) => {
    const cells = positions.map((p) => (vertical ? cellAt(p, line) : cellAt(line, p)));
    return { cells, next: lineSeries(cells, opts, forward ? 1 : -1) };
  };
  return { vertical, count, lines, cellOf, series };
}

function moveFormula(content: CellContent | null, dRow: number, dCol: number): CellContent | null {
  return content?.f !== undefined ? { f: translateFormula(content.f, dRow, dCol) } : content;
}

/**
 * Fills `target` from `source` (which it contains and extends on one side).
 * Each row or column across the fill continues on its own: numbers and dates
 * as a linear series (dates by month when they fall on the same day),
 * "Item 1" counts up, weekday and month names go round, formulas move like
 * copies, and anything else repeats. Styles repeat with their cells.
 */
export function autofill(
  source: Range,
  target: Range,
  cellAt: CellAt,
  opts: FillOptions,
): { setCells: CellPatch[]; setStyles: [number, number, string | null][] } | null {
  const p = plan(source, target);
  if (!p) return null;
  const setCells: CellPatch[] = [];
  const setStyles: [number, number, string | null][] = [];
  for (let line = p.lines[0]; line <= p.lines[1]; line++) {
    const { cells, next } = p.series(line, cellAt, opts);
    for (let k = 1; k <= p.count; k++) {
      const { content, from } = next(k);
      const at = p.cellOf(line, k, from);
      setCells.push([at.row, at.col, moveFormula(content, at.row - at.srcRow, at.col - at.srcCol)]);
      setStyles.push([at.row, at.col, cells[from]!.style]);
    }
  }
  return { setCells, setStyles };
}

/**
 * What the last cell of one line of a fill gets (`line`: the column of a
 * fill down or up, the row of one left or right): the hint shown while the
 * handle is dragged. Null when the target does not extend the source.
 */
export function lastFilled(source: Range, target: Range, line: number, cellAt: CellAt, opts: FillOptions): FillCell | null {
  const p = plan(source, target);
  if (!p) return null;
  const l = Math.max(p.lines[0], Math.min(p.lines[1], line));
  const { cells, next } = p.series(l, cellAt, opts);
  const { content, from } = next(p.count);
  const at = p.cellOf(l, p.count, from);
  return { ...cells[from]!, content: moveFormula(content, at.row - at.srcRow, at.col - at.srcCol) };
}

/**
 * The series one row or column of source cells continues into. `step` is
 * which way a single value counts: -1 when filling up or left.
 */
export function lineSeries(cells: FillCell[], opts: FillOptions, step: 1 | -1 = 1): LineSeries {
  const n = cells.length;
  const repeat = (k: number) => (n - 1 + k) % n;
  const copy: LineSeries = (k) => ({ content: cells[repeat(k)]!.content, from: repeat(k) });
  if (opts.copy) return copy;
  const contents = cells.map((c) => c.content);

  if (contents.every((c) => typeof c?.v === 'number')) {
    const next = numberSeries(cells, opts.toggle, step);
    return next ? (k) => ({ content: { v: next(n - 1 + k) }, from: repeat(k) }) : copy;
  }
  if (opts.toggle) return copy;
  const text = numberedSeries(contents, step) ?? namedSeries(contents, opts.locale, step);
  if (text) return (k) => ({ content: { v: text(n - 1 + k) }, from: repeat(k) });
  return patternSeries(cells, opts.locale, step);
}

/**
 * Numbers (and dates) as a series, or null when they copy. One number
 * copies (Ctrl counts it on by one); one date counts on by a day (Ctrl
 * copies it); more go on as a line, dates by months when they can.
 */
function numberSeries(cells: FillCell[], toggle: boolean, step: 1 | -1): ((x: number) => number) | null {
  const values = cells.map((c) => c.content!.v as number);
  const dates = cells.every((c) => isDateFormat(c.numFmt));
  if (values.length === 1) return dates === toggle ? null : (x) => values[0]! + step * x;
  if (toggle) return null;
  return (dates ? monthlySeries(values) : null) ?? linearSeries(values);
}

/** "Item 1", "Item 2": one prefix and suffix around a counting number. */
function numberedSeries(contents: (CellContent | null)[], step: 1 | -1): ((x: number) => string) | null {
  const parts = contents.map((c) => (typeof c?.v === 'string' ? numberedText(c.v) : null));
  const first = parts[0];
  if (!first || parts.some((p) => !p || p.prefix !== first.prefix || p.suffix !== first.suffix)) return null;
  const values = parts.map((p) => p!.n);
  const next = values.length === 1 ? (x: number) => values[0]! + step * x : linearSeries(values);
  const last = parts[parts.length - 1]!;
  return (x) => last.prefix + pad(Math.abs(Math.round(next(x))), last.width) + last.suffix;
}

/** Anything else repeats; within the pattern, numbered text and names still count on per round. */
function patternSeries(cells: FillCell[], locale: FormatLocale, step: 1 | -1): LineSeries {
  const n = cells.length;
  return (k) => {
    const from = (n - 1 + k) % n;
    const round = Math.floor((n - 1 + k) / n);
    const content = cells[from]!.content;
    if (typeof content?.v !== 'string' || round === 0) return { content, from };
    const numbered = numberedText(content.v);
    if (numbered) return { content: { v: numbered.prefix + pad(Math.abs(numbered.n + step * round), numbered.width) + numbered.suffix }, from };
    const named = namedSeries([content], locale, 1);
    return { content: named ? { v: named(step * round) } : content, from };
  };
}

/** Least-squares line through the values at 0, 1, 2, …: exact for an even step, Excel's trend otherwise. */
function linearSeries(values: number[]): (x: number) => number {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  values.forEach((y, x) => {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  });
  const slope = num / den;
  return (x) => tidy(meanY + slope * (x - meanX));
}

/** Dates on the same day of the month, a whole number of months apart: steps by months (or years). */
function monthlySeries(values: number[]): ((x: number) => number) | null {
  if (values.some((v) => v !== Math.floor(v))) return null;
  const ymds = values.map(ymdFromSerial);
  const day = ymds[0]!.day;
  if (ymds.some((d) => d.day !== day)) return null;
  const months = ymds.map((d) => d.year * 12 + d.month - 1);
  const step = months[1]! - months[0]!;
  if (step === 0 || months.some((m, i) => i > 0 && m - months[i - 1]! !== step)) return null;
  return (x) => {
    const m = months[0]! + step * x;
    const year = Math.floor(m / 12);
    const month = (m % 12) + 1;
    const serial = serialFromYMD(year, month, Math.min(day, daysInMonth(year, month)));
    return Number.isNaN(serial) ? values[values.length - 1]! : serial;
  };
}

/** Rounds off floating-point noise (0.1 + 0.2), keeping 15 significant digits as Excel does. */
function tidy(n: number): number {
  return Number(n.toPrecision(15));
}

/** "Item 007" → prefix "Item ", 7, width 3. The number is the last run of digits. */
function numberedText(text: string): { prefix: string; n: number; width: number; suffix: string } | null {
  const isDigit = (i: number) => text[i]! >= '0' && text[i]! <= '9';
  let end = text.length;
  while (end > 0 && !isDigit(end - 1)) end--;
  let start = end;
  while (start > 0 && isDigit(start - 1)) start--;
  const digits = text.slice(start, end);
  if (digits.length === 0 || digits.length > 15) return null;
  return { prefix: text.slice(0, start), n: Number(digits), width: digits.length, suffix: text.slice(end) };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** The lists names go round in: weekdays and months, long and short, in the sheet's locale and English. */
function nameLists(locale: FormatLocale): (readonly string[])[] {
  const lists = [locale.dayNames, locale.dayShort, locale.monthNames, locale.monthShort];
  if (locale !== EN_LOCALE) lists.push(EN_LOCALE.dayNames, EN_LOCALE.dayShort, EN_LOCALE.monthNames, EN_LOCALE.monthShort);
  return lists;
}

/**
 * Names from one list (Mon, Tue / January, March) as a series: by the step
 * between them, written like the last one (MONDAY, monday, Monday).
 */
function namedSeries(contents: (CellContent | null)[], locale: FormatLocale, single: 1 | -1): ((x: number) => string) | null {
  const texts = contents.map((c) => (typeof c?.v === 'string' ? c.v.trim() : null));
  if (texts.some((t) => !t)) return null;
  for (const list of nameLists(locale)) {
    const lower = list.map((s) => s.toLowerCase());
    const indices = texts.map((t) => lower.indexOf(t!.toLowerCase()));
    if (indices.some((i) => i < 0)) continue;
    const len = list.length;
    const step = indices.length > 1 ? (((indices[1]! - indices[0]!) % len) + len) % len || 1 : single;
    const last = texts[texts.length - 1]!;
    return (x) => matchCase(list[(((indices[0]! + step * x) % len) + len) % len]!, last);
  }
  return null;
}

function matchCase(name: string, like: string): string {
  if (like.length > 1 && like === like.toUpperCase()) return name.toUpperCase();
  if (like === like.toLowerCase()) return name.toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}
