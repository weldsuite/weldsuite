/**
 * Chart data: a chart's references resolved against the workbook, and the
 * series a range of cells gives (and back: the range a chart's series came
 * from, for the editor's "data range"). Shared by the editor, which draws
 * charts, and the .xlsx writer, which stores their last values.
 */

import { MAX_COLS, MAX_ROWS, type Range } from '../address';
import type { Engine } from '../calc/engine';
import { tokenize, type RefToken } from '../formula/lexer';
import { printRef } from '../formula/references';
import { CHART_PALETTE, type Chart, type ChartSeries } from '../model/charts';
import { isError, toText, type Scalar } from '../values';

/** Points a series draws at most. */
const MAX_POINTS = 10_000;

export interface RangeAt {
  sheetId: string;
  range: Range;
}

/** A reference written as formula text ('Sales'!$B$2:$B$9), as a sheet and range; null when it is anything else. */
export function resolveRef(engine: Engine, text: string, hostSheetId: string): RangeAt | null {
  let tokens;
  try {
    tokens = tokenize(text.startsWith('=') ? text.slice(1) : text).filter((t) => t.type !== 'ws');
  } catch {
    return null;
  }
  const only = tokens[0];
  if (tokens.length !== 1 || only?.type !== 'ref') return null;
  const ref = only.ref;
  const sheetId = ref.sheet === null ? hostSheetId : engine.sheetIdByName(ref.sheet);
  return sheetId ? { sheetId, range: { r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2 } } : null;
}

/** `at` cut to the cells its sheet uses (a whole-column reference holds a million blanks). */
function trimmed(engine: Engine, at: RangeAt): Range | null {
  const used = engine.usedRange(at.sheetId);
  if (!used) return null;
  const r = { ...at.range, r2: Math.min(at.range.r2, used.r2), c2: Math.min(at.range.c2, used.c2) };
  return r.r2 < r.r1 || r.c2 < r.c1 ? null : r;
}

/** The values of a one-row or one-column range, in order (a block is read row by row). */
function vector(engine: Engine, at: RangeAt): Scalar[] {
  const r = trimmed(engine, at);
  if (!r) return [];
  const out: Scalar[] = [];
  for (let row = r.r1; row <= r.r2 && out.length < MAX_POINTS; row++) {
    for (let col = r.c1; col <= r.c2 && out.length < MAX_POINTS; col++) out.push(engine.getValue(at.sheetId, row, col));
  }
  return out;
}

function numberFormat(engine: Engine, at: RangeAt | null): string | undefined {
  if (!at) return undefined;
  const sheet = engine.workbook.getSheet(at.sheetId);
  return sheet ? engine.workbook.style(sheet, at.range.r1, at.range.c1)?.numFmt : undefined;
}

export interface SeriesData {
  name: string;
  values: (number | null)[];
  /** Scatter: the x values. */
  x?: (number | null)[];
  color: string;
  /** Number format of the series' first cell, for axis labels. */
  format?: string;
}

export interface ChartData {
  categories: Scalar[];
  /** Number format of the first category, so dates show as dates. */
  categoryFormat?: string;
  series: SeriesData[];
}

const toNumber = (v: Scalar): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What a chart shows now. References that do not resolve give empty data, not an error. */
export function chartData(engine: Engine, sheetId: string, chart: Chart): ChartData {
  const categoriesAt = chart.categories ? resolveRef(engine, chart.categories, sheetId) : null;
  return {
    categories: categoriesAt ? vector(engine, categoriesAt) : [],
    categoryFormat: numberFormat(engine, categoriesAt),
    series: chart.series.map((s, i) => {
      const at = resolveRef(engine, s.values, sheetId);
      const xAt = s.x ? resolveRef(engine, s.x, sheetId) : null;
      const data: SeriesData = {
        name: seriesName(engine, sheetId, s, i),
        values: at ? vector(engine, at).map(toNumber) : [],
        color: s.color ?? CHART_PALETTE[i % CHART_PALETTE.length]!,
        format: numberFormat(engine, at),
      };
      if (xAt) data.x = vector(engine, xAt).map(toNumber);
      return data;
    }),
  };
}

function seriesName(engine: Engine, sheetId: string, s: ChartSeries, i: number): string {
  const fallback = `Series ${i + 1}`;
  if (!s.name) return fallback;
  const at = resolveRef(engine, s.name, sheetId);
  const value = at ? engine.getValue(at.sheetId, at.range.r1, at.range.c1) : engine.evaluateFormula(sheetId, 0, 0, s.name);
  if (Array.isArray(value) || value === null || isError(value)) return fallback;
  const text = toText(value);
  return typeof text === 'string' && text ? text : fallback;
}

// ---------------------------------------------------------------------------
// From a range, and back
// ---------------------------------------------------------------------------

/** How a block of cells reads as chart data. */
export interface ChartSource {
  /** Each column is a series (else each row). */
  seriesIn: 'columns' | 'rows';
  /** The first row (or column, for series in rows) names the series. */
  headers: boolean;
  /** The first column (or row) holds the category labels. */
  labels: boolean;
}

/** The most likely reading of a block: series along its longer side, names and labels where there is text. */
export function guessChartSource(engine: Engine, sheetId: string, range: Range): ChartSource {
  const r = trimmed(engine, { sheetId, range }) ?? range;
  const rows = r.r2 - r.r1 + 1;
  const cols = r.c2 - r.c1 + 1;
  const byCols = cols <= rows;
  const across = byCols ? cols : rows;
  const along = byCols ? rows : cols;
  // Position `i` along line `line` (0 = the first row or column).
  const at = (line: number, i: number): [number, number] => (byCols ? [r.r1 + i, r.c1 + line] : [r.r1 + line, r.c1 + i]);
  // The first cell of each series names it when there is text there.
  const headers = along > 1 && Array.from({ length: across }, (_, line) => isText(engine.getValue(sheetId, ...at(line, 0)))).some(Boolean);
  // The first line labels the points when it holds text or dates.
  const start = headers ? 1 : 0;
  const sample = Array.from({ length: Math.max(0, Math.min(along, start + 20) - start) }, (_, k) => at(0, start + k));
  const labels = across > 1 && sample.some(([row, col]) => isLabel(engine, sheetId, row, col));
  return { seriesIn: byCols ? 'columns' : 'rows', headers, labels };
}

const isText = (v: Scalar) => typeof v === 'string' && v !== '';

/** Text, or a number shown as a date: what labels points rather than being plotted. */
function isLabel(engine: Engine, sheetId: string, row: number, col: number): boolean {
  const v = engine.getValue(sheetId, row, col);
  if (isText(v)) return true;
  const sheet = engine.workbook.getSheet(sheetId);
  const fmt = sheet ? engine.workbook.style(sheet, row, col)?.numFmt : undefined;
  return typeof v === 'number' && fmt !== undefined && /[dmy]/i.test(fmt) && !/[#0]/.test(fmt);
}

/** The cells at `at` as an absolute, sheet-qualified reference ('Sales'!$A$1:$C$9). */
export function refText(engine: Engine, at: RangeAt): string {
  return absolute(engine.sheetName(at.sheetId) ?? '', at.range);
}

const absolute = (sheet: string, r: Range): string =>
  printRef({
    sheet,
    kind: r.r1 === r.r2 && r.c1 === r.c2 ? 'cell' : 'range',
    r1: r.r1,
    c1: r.c1,
    r2: r.r2,
    c2: r.c2,
    absR1: true,
    absC1: true,
    absR2: true,
    absC2: true,
  } satisfies RefToken);

/** The categories and series a block gives, read as `source` says. */
export function seriesFromRange(engine: Engine, sheetId: string, range: Range, source: ChartSource): Pick<Chart, 'categories' | 'series'> {
  const sheet = engine.sheetName(sheetId) ?? '';
  const r = trimmed(engine, { sheetId, range }) ?? range;
  const byCols = source.seriesIn === 'columns';
  // Lines are what a series runs along; `first`/`last` index the lines across them.
  const first = (byCols ? r.c1 : r.r1) + (source.labels ? 1 : 0);
  const last = byCols ? r.c2 : r.r2;
  const from = (byCols ? r.r1 : r.c1) + (source.headers ? 1 : 0);
  const to = byCols ? r.r2 : r.c2;
  const line = (i: number): Range => (byCols ? { r1: from, c1: i, r2: to, c2: i } : { r1: i, c1: from, r2: i, c2: to });
  const head = (i: number): Range => (byCols ? { r1: r.r1, c1: i, r2: r.r1, c2: i } : { r1: i, c1: r.c1, r2: i, c2: r.c1 });
  const series: ChartSeries[] = [];
  for (let i = first; i <= last && from <= to; i++) {
    series.push(source.headers ? { name: absolute(sheet, head(i)), values: absolute(sheet, line(i)) } : { values: absolute(sheet, line(i)) });
  }
  const out: Pick<Chart, 'categories' | 'series'> = { series };
  if (source.labels && from <= to) out.categories = absolute(sheet, line(byCols ? r.c1 : r.r1));
  return out;
}

/** The block and reading a chart's references came from, when they form one; null for anything else. */
export function chartSourceOf(engine: Engine, sheetId: string, chart: Chart): (ChartSource & RangeAt) | null {
  const block = seriesBlock(chart.series.map((s) => resolveRef(engine, s.values, sheetId)));
  if (!block) return null;
  const { host, byCols, lines } = block;
  const first = lines[0]!;
  const lastLine = lines[lines.length - 1]!;
  // The cell before each series line, and the line before the first series.
  const before = (l: Range): Range => (byCols ? { ...l, r1: l.r1 - 1, r2: l.r1 - 1 } : { ...l, c1: l.c1 - 1, c2: l.c1 - 1 });
  const lineBefore: Range = byCols ? { ...first, c1: first.c1 - 1, c2: first.c1 - 1 } : { ...first, r1: first.r1 - 1, r2: first.r1 - 1 };
  const isAt = (ref: string | undefined, want: Range) => {
    const got = ref ? resolveRef(engine, ref, sheetId) : null;
    return !!got && got.sheetId === host && sameRange(got.range, want);
  };
  const headers = chart.series.every((s, i) => isAt(s.name, before(lines[i]!)));
  const labels = isAt(chart.categories, lineBefore);
  if (chart.categories && !labels) return null;
  const range: Range = byCols
    ? { r1: first.r1 - (headers ? 1 : 0), c1: first.c1 - (labels ? 1 : 0), r2: first.r2, c2: lastLine.c2 }
    : { r1: first.r1 - (labels ? 1 : 0), c1: first.c1 - (headers ? 1 : 0), r2: lastLine.r2, c2: first.c2 };
  if (range.r1 < 0 || range.c1 < 0 || range.r2 >= MAX_ROWS || range.c2 >= MAX_COLS) return null;
  return { sheetId: host, range, seriesIn: byCols ? 'columns' : 'rows', headers, labels };
}

const sameRange = (a: Range, b: Range) => a.r1 === b.r1 && a.c1 === b.c1 && a.r2 === b.r2 && a.c2 === b.c2;

/** Series value lines that sit side by side on one sheet, all the same length; null for anything else. */
function seriesBlock(values: (RangeAt | null)[]): { host: string; byCols: boolean; lines: Range[] } | null {
  if (values.length === 0 || values.some((v) => !v)) return null;
  const at = values as RangeAt[];
  const host = at[0]!.sheetId;
  if (at.some((v) => v.sheetId !== host)) return null;
  const lines = at.map((v) => v.range);
  const byCols = lines.every((l) => l.c1 === l.c2);
  if (!byCols && !lines.every((l) => l.r1 === l.r2)) return null;
  const first = lines[0]!;
  const sideBySide = lines.every((l, i) =>
    byCols ? l.r1 === first.r1 && l.r2 === first.r2 && l.c1 === first.c1 + i : l.c1 === first.c1 && l.c2 === first.c2 && l.r1 === first.r1 + i,
  );
  return sideBySide ? { host, byCols, lines } : null;
}
