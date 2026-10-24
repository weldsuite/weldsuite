/**
 * Pivot tables. A pivot table is the formula
 *
 *   PIVOT(source, rows, columns, values, [filters], [totals])
 *
 * in its top-left cell, spilling its result, so it recalculates, co-edits,
 * undoes and follows row and column changes like any formula. `source` is a
 * range whose first row names the fields; `rows` and `columns` are field
 * names (a text or an array of texts, "-Name" sorting that field
 * descending); `values` are "FUNCTION:Field" texts; `filters` is a two-column
 * array of (field, shown value) pairs; `totals` (default TRUE) adds subtotal
 * and grand total rows and grand total columns.
 *
 * `computePivot` is the whole computation, so the editor can lay out and
 * style a pivot table's cells from the same result the formula spills.
 */

import { parseFormula, type AstNode } from '../formula/parser';
import { printRef } from '../formula/references';
import { compareForSort } from '../ops/sort';
import { ERR, err, isError, toText, type CellError, type Scalar } from '../values';

export const PIVOT_FUNCTIONS = ['SUM', 'COUNTA', 'COUNT', 'AVERAGE', 'MIN', 'MAX', 'COUNTUNIQUE', 'MEDIAN'] as const;
export type PivotFunction = (typeof PIVOT_FUNCTIONS)[number];

export interface PivotGroup {
  field: string;
  descending?: boolean;
}

export interface PivotValue {
  field: string;
  fn: PivotFunction;
}

export interface PivotFilter {
  field: string;
  /** The values shown, as text ('' for blanks); rows with any other value are left out. */
  values: string[];
}

/** What a pivot table shows, without its source. */
export interface PivotLayoutSpec {
  rows: PivotGroup[];
  columns: PivotGroup[];
  values: PivotValue[];
  filters: PivotFilter[];
  totals: boolean;
}

export interface PivotSpec extends PivotLayoutSpec {
  /** Formula text of the source range, its first row naming the fields. */
  source: string;
}

export interface PivotResult {
  cells: Scalar[][];
  /** Rows above the data: field names, column labels, value names. */
  headerRows: number;
  /** Columns left of the data: the row labels. */
  labelCols: number;
  /** For each column, the value (index into `values`) it shows, or -1. */
  valueOf: number[];
  /** Subtotal and grand total rows. */
  totalRows: number[];
  /** Grand total columns. */
  totalCols: number[];
}

/** Cells a pivot table may produce. */
const MAX_PIVOT_CELLS = 500_000;
const GRAND_TOTAL = 'Grand Total';
const ALL = '\u0001all';

/** A formula (with or without '=') whose result is a pivot table. */
export function isPivotFormula(formula: string | undefined): boolean {
  if (!formula) return false;
  const text = formula.trimStart();
  const body = (text.startsWith('=') ? text.slice(1) : text).trimStart();
  return body.slice(0, 5).toUpperCase() === 'PIVOT' && body.slice(5).trimStart().startsWith('(');
}

// ---------------------------------------------------------------------------
// Formula text
// ---------------------------------------------------------------------------

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

function listArg(items: string[]): string {
  if (items.length === 0) return '""';
  if (items.length === 1) return quote(items[0]!);
  return `{${items.map(quote).join(',')}}`;
}

/** The PIVOT formula (canonical syntax, no '=') for a spec. */
export function pivotFormula(spec: PivotSpec): string {
  const args = [
    spec.source,
    listArg(spec.rows.map((g) => (g.descending ? `-${g.field}` : g.field))),
    listArg(spec.columns.map((g) => (g.descending ? `-${g.field}` : g.field))),
    listArg(spec.values.map((v) => `${v.fn}:${v.field}`)),
  ];
  const pairs = spec.filters.flatMap((f) => f.values.map((v) => `${quote(f.field)},${quote(v)}`));
  if (pairs.length || !spec.totals) args.push(pairs.length ? `{${pairs.join(';')}}` : '""');
  if (!spec.totals) args.push('FALSE');
  return `PIVOT(${args.join(',')})`;
}

/** The spec a PIVOT formula holds; null when the formula is not a PIVOT call WeldSheets can read back. */
export function parsePivotFormula(formula: string): PivotSpec | null {
  let ast: AstNode;
  try {
    ast = parseFormula(formula);
  } catch {
    return null;
  }
  if (ast.type !== 'call' || ast.name.toUpperCase() !== 'PIVOT' || ast.args.length < 4) return null;
  const [source, rows, columns, values, filters, totals] = ast.args;
  if (source?.type !== 'ref') return null;
  const texts = (node: AstNode | undefined): string[] | null => {
    if (!node || node.type === 'empty') return [];
    if (node.type === 'string') return node.value === '' ? [] : [node.value];
    if (node.type !== 'array') return null;
    const out = node.rows.flat().map((n) => (n.type === 'string' ? n.value : null));
    return out.includes(null) ? null : (out as string[]).filter(Boolean);
  };
  const r = texts(rows);
  const c = texts(columns);
  const v = texts(values);
  const f = filterPairs(filters);
  if (!r || !c || !v || !f) return null;
  const parsedValues = v.map(parseValue);
  if (parsedValues.some((x) => isError(x))) return null;
  return {
    source: printRef(source.ref),
    rows: r.map(parseGroup),
    columns: c.map(parseGroup),
    values: parsedValues as PivotValue[],
    filters: f,
    totals: totals?.type !== 'boolean' || totals.value,
  };
}

function filterPairs(node: AstNode | undefined): PivotFilter[] | null {
  if (!node || node.type === 'empty' || (node.type === 'string' && node.value === '')) return [];
  if (node.type !== 'array') return null;
  const pairs: [string, string][] = [];
  for (const row of node.rows) {
    const [field, value] = row;
    if (row.length !== 2 || field?.type !== 'string' || value?.type !== 'string') return null;
    pairs.push([field.value, value.value]);
  }
  return groupFilters(pairs);
}

function groupFilters(pairs: [string, string][]): PivotFilter[] {
  const out: PivotFilter[] = [];
  for (const [field, value] of pairs) {
    const existing = out.find((f) => f.field.toLowerCase() === field.toLowerCase());
    if (existing) existing.values.push(value);
    else out.push({ field, values: [value] });
  }
  return out;
}

function parseGroup(text: string): PivotGroup {
  return text.startsWith('-') && text.length > 1 ? { field: text.slice(1), descending: true } : { field: text };
}

function parseValue(text: string): PivotValue | CellError {
  const colon = text.indexOf(':');
  const fn = text.slice(0, colon).trim().toUpperCase();
  const field = text.slice(colon + 1);
  if (colon < 0 || !(PIVOT_FUNCTIONS as readonly string[]).includes(fn) || !field) return err('#VALUE!', `"${text}" is not FUNCTION:Field`);
  return { fn: fn as PivotFunction, field };
}

/** The layout a PIVOT call's evaluated arguments describe. */
export function layoutSpecFromArgs(rows: string[], columns: string[], values: string[], filters: [string, string][], totals: boolean): PivotLayoutSpec | CellError {
  const parsed = values.map(parseValue);
  const bad = parsed.find((v) => isError(v));
  if (bad) return bad as CellError;
  return { rows: rows.map(parseGroup), columns: columns.map(parseGroup), values: parsed as PivotValue[], filters: groupFilters(filters), totals };
}

// ---------------------------------------------------------------------------
// Computing
// ---------------------------------------------------------------------------

const keyOf = (v: Scalar): string => {
  if (v === null || v === '') return 'e';
  if (typeof v === 'number') return `n${v}`;
  if (typeof v === 'string') return `s${v.toLowerCase()}`;
  if (typeof v === 'boolean') return `b${v}`;
  return `x${v.code}`;
};
const tupleKey = (t: Scalar[]) => t.map(keyOf).join('\u0000');
const textOf = (v: Scalar): string => {
  if (v === null) return '';
  const t = toText(v);
  return isError(t) ? t.code : t;
};

interface Field {
  name: string;
  col: number;
  descending: boolean;
}

/** An output column: the column combination it aggregates (ALL for totals) and the value it shows (-1 for none). */
interface DataCol {
  key: string;
  tuple: Scalar[] | null;
  v: number;
}

interface Acc {
  sum: number;
  count: number;
  counta: number;
  min: number;
  max: number;
  nums: number[];
  uniq: Set<string>;
}

const newAcc = (): Acc => ({ sum: 0, count: 0, counta: 0, min: Infinity, max: -Infinity, nums: [], uniq: new Set() });

function add(acc: Acc, v: Scalar): void {
  if (v === null || v === '') return;
  acc.counta++;
  acc.uniq.add(keyOf(v));
  if (typeof v !== 'number') return;
  acc.count++;
  acc.sum += v;
  acc.min = Math.min(acc.min, v);
  acc.max = Math.max(acc.max, v);
  acc.nums.push(v);
}

function result(fn: PivotFunction, acc: Acc | undefined): Scalar {
  if (!acc) return null;
  switch (fn) {
    case 'SUM':
      return acc.sum;
    case 'COUNTA':
      return acc.counta;
    case 'COUNT':
      return acc.count;
    case 'COUNTUNIQUE':
      return acc.uniq.size;
    case 'AVERAGE':
      return acc.count ? acc.sum / acc.count : ERR.div0;
    case 'MIN':
      return acc.count ? acc.min : 0;
    case 'MAX':
      return acc.count ? acc.max : 0;
    case 'MEDIAN': {
      if (!acc.count) return ERR.num;
      const s = [...acc.nums].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
    }
  }
}

export function valueLabel(v: PivotValue): string {
  return `${v.fn} of ${v.field}`;
}

/** The pivot table of `data` (its first row naming the fields), or the error the formula shows. */
export function computePivot(data: Scalar[][], spec: PivotLayoutSpec): PivotResult | CellError {
  const names = new Map<string, { name: string; col: number }>();
  (data[0] ?? []).forEach((v, col) => {
    const name = textOf(v).trim();
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), { name, col });
  });
  const field = (name: string, descending = false): Field | CellError => {
    const f = names.get(name.trim().toLowerCase());
    return f ? { ...f, descending } : err('#REF!', `The source has no field "${name}"`);
  };
  const rows = spec.rows.map((g) => field(g.field, g.descending));
  const columns = spec.columns.map((g) => field(g.field, g.descending));
  const values = spec.values.map((v) => field(v.field));
  const filters = spec.filters.map((f) => field(f.field));
  const missing = [...rows, ...columns, ...values, ...filters].find((f) => isError(f));
  if (missing) return missing as CellError;

  const shown = spec.filters.map((f) => new Set(f.values.map((v) => v.toLowerCase())));
  const records = data.slice(1).filter((rec) => {
    if (!rec.some((v) => v !== null && v !== '')) return false;
    return (filters as Field[]).every((f, i) => shown[i]!.has(textOf(rec[f.col] ?? null).toLowerCase()));
  });
  return new PivotBuilder(records, rows as Field[], columns as Field[], values as Field[], spec).build();
}

class PivotBuilder {
  private readonly acc = new Map<string, Acc[]>();
  private readonly rowTuples: Scalar[][];
  private readonly colTuples: Scalar[][];

  constructor(
    private readonly records: Scalar[][],
    private readonly rows: Field[],
    private readonly cols: Field[],
    private readonly vals: Field[],
    private readonly spec: PivotLayoutSpec,
  ) {
    this.rowTuples = this.distinct(rows);
    this.colTuples = this.distinct(cols);
    for (const rec of records) this.accumulate(rec);
  }

  /** The distinct combinations of `fields` in the records, sorted field by field. */
  private distinct(fields: Field[]): Scalar[][] {
    if (fields.length === 0) return [];
    const seen = new Map<string, Scalar[]>();
    for (const rec of this.records) {
      const t = fields.map((f) => rec[f.col] ?? null);
      const key = tupleKey(t);
      if (!seen.has(key)) seen.set(key, t);
    }
    return [...seen.values()].sort((a, b) => {
      for (let i = 0; i < fields.length; i++) {
        const c = compareForSort(a[i]!, b[i]!, fields[i]!.descending);
        if (c !== 0) return c;
      }
      return 0;
    });
  }

  private accumulate(rec: Scalar[]): void {
    const rowTuple = this.rows.map((f) => rec[f.col] ?? null);
    const colKeys = this.cols.length ? [tupleKey(this.cols.map((f) => rec[f.col] ?? null)), ALL] : [ALL];
    for (let level = 0; level <= this.rows.length; level++) {
      const prefix = tupleKey(rowTuple.slice(0, level));
      for (const colKey of colKeys) {
        const key = `${level}|${prefix}|${colKey}`;
        let accs = this.acc.get(key);
        if (!accs) {
          accs = this.vals.map(() => newAcc());
          this.acc.set(key, accs);
        }
        this.vals.forEach((v, i) => add(accs[i]!, rec[v.col] ?? null));
      }
    }
  }

  private value(level: number, rowPrefix: Scalar[], colKey: string, v: number): Scalar {
    return result(this.spec.values[v]!.fn, this.acc.get(`${level}|${tupleKey(rowPrefix)}|${colKey}`)?.[v]);
  }

  /** Data columns: per column combination one per value (or one, without values), then the grand totals. */
  private dataColumns(): DataCol[] {
    const m = this.vals.length;
    const values = Array.from({ length: m }, (_, v) => v);
    if (this.cols.length === 0) return values.map((v) => ({ key: ALL, tuple: null, v }));
    const perGroup = m ? values : [-1];
    const out: DataCol[] = this.colTuples.flatMap((t) => perGroup.map((v) => ({ key: tupleKey(t), tuple: t, v })));
    if (this.spec.totals) out.push(...values.map((v) => ({ key: ALL, tuple: null, v })));
    return out;
  }

  build(): PivotResult | CellError {
    const m = this.vals.length;
    const k = this.cols.length;
    const L = this.rows.length;
    const labelCols = Math.max(1, L);
    const dataCols = this.dataColumns();
    const width = Math.max(labelCols + dataCols.length, labelCols + k, 1);
    // With column groups: a row of field names, one per column level, and value names when there are several.
    const valueNames = m > 1 ? 1 : 0;
    const headerRows = k === 0 ? 1 : 1 + k + valueNames;
    const bodyCount = L === 0 ? 1 : this.rowTuples.length * 2 + 1;
    if (width * (headerRows + bodyCount) > MAX_PIVOT_CELLS) return err('#CALC!', 'The pivot table is too large');

    const cells: Scalar[][] = [];
    const totalRows: number[] = [];
    const blank = () => new Array<Scalar>(width).fill(null);
    this.header(cells, blank, dataCols, labelCols, headerRows);
    const emit = (labels: Scalar[], level: number, prefix: Scalar[], total: boolean) => {
      const line = blank();
      labels.forEach((l, i) => (line[i] = l));
      dataCols.forEach((dc, j) => {
        if (dc.v >= 0) line[labelCols + j] = this.value(level, prefix, dc.key, dc.v);
      });
      if (total) totalRows.push(cells.length);
      cells.push(line);
    };
    if (L === 0) emit([GRAND_TOTAL], 0, [], true);
    else this.body(emit);
    if (L > 0 && this.spec.totals) emit([GRAND_TOTAL], 0, [], true);

    const valueOf = new Array<number>(width).fill(-1);
    dataCols.forEach((dc, j) => (valueOf[labelCols + j] = dc.v));
    const totalCols = dataCols.flatMap((dc, j) => (k > 0 && dc.tuple === null ? [labelCols + j] : []));
    return { cells, headerRows, labelCols, valueOf, totalRows, totalCols };
  }

  private header(cells: Scalar[][], blank: () => Scalar[], dataCols: DataCol[], labelCols: number, headerRows: number): void {
    const k = this.cols.length;
    const m = this.vals.length;
    const names = this.spec.values;
    for (let i = 0; i < headerRows; i++) cells.push(blank());
    const last = cells[headerRows - 1]!;
    this.rows.forEach((f, i) => (last[i] = f.name));
    if (k === 0) {
      dataCols.forEach((dc, j) => (last[labelCols + j] = valueLabel(names[dc.v]!)));
      return;
    }
    if (m === 1) cells[0]![0] = valueLabel(names[0]!);
    this.cols.forEach((f, i) => (cells[0]![labelCols + i] = f.name));
    dataCols.forEach((dc, j) => {
      const col = labelCols + j;
      if (dc.tuple === null) {
        cells[1]![col] = m === 1 ? GRAND_TOTAL : `Total ${valueLabel(names[dc.v]!)}`;
        return;
      }
      const prev = dataCols[j - 1];
      for (let level = 0; level < k; level++) {
        const same = prev?.tuple && tupleKey(prev.tuple.slice(0, level + 1)) === tupleKey(dc.tuple.slice(0, level + 1));
        if (!same) cells[1 + level]![col] = dc.tuple[level]!;
      }
      if (m > 1) cells[1 + k]![col] = valueLabel(names[dc.v]!);
    });
  }

  /** Row groups, each level's label on the first row of its group, with a subtotal after each outer group. */
  private body(emit: (labels: Scalar[], level: number, prefix: Scalar[], total: boolean) => void): void {
    const L = this.rows.length;
    const tuples = this.rowTuples;
    tuples.forEach((t, n) => {
      const prev = tuples[n - 1];
      const labels = t.map((v, i) => (prev && tupleKey(prev.slice(0, i + 1)) === tupleKey(t.slice(0, i + 1)) ? null : v));
      emit(labels, L, t, false);
      if (!this.spec.totals) return;
      const next = tuples[n + 1];
      for (let level = L - 2; level >= 0; level--) {
        if (next && tupleKey(next.slice(0, level + 1)) === tupleKey(t.slice(0, level + 1))) continue;
        const labelsOut: Scalar[] = new Array<Scalar>(level).fill(null);
        labelsOut.push(`${textOf(t[level]!)} Total`);
        emit(labelsOut, level + 1, t.slice(0, level + 1), true);
      }
    });
  }
}
