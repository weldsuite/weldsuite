/**
 * Evaluating sheet rules (model/rules.ts) against cell values: which rows a
 * filter hides, how a conditional format styles a cell, whether a value passes
 * data validation. Pure functions over a small host, so the engine (filters)
 * and the editor (formats, validation) share them.
 */

import { rangeContains, type Range } from '../address';
import { parseInput } from '../format/input';
import type { FormatLocale } from '../format/number-format';
import { translateFormula } from '../formula/references';
import type { Sheet } from '../model/workbook';
import {
  valueKey,
  type ColorPoint,
  type Condition,
  type ConditionalFormat,
  type ConditionalStyle,
  type DataValidation,
  type SheetFilter,
} from '../model/rules';
import { isError, toText, type Scalar } from '../values';

export interface RuleHost {
  cellValue(sheetId: string, row: number, col: number): Scalar;
  forEachValue(sheetId: string, range: Range, fn: (row: number, col: number, value: Scalar) => void): void;
  /** Formula text evaluated as if it were in (row, col); arrays come back whole. */
  evaluateFormula(sheetId: string, row: number, col: number, formula: string): Scalar | Scalar[][];
}

export interface CellAt {
  sheetId: string;
  row: number;
  col: number;
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

/** Does `value` (the value of the cell at `at`) pass `condition`? `anchor` is where a formula condition is written for. */
export function matchesCondition(host: RuleHost, condition: Condition, value: Scalar, at: CellAt, anchor: { row: number; col: number }): boolean {
  switch (condition.type) {
    case 'empty':
      return isBlank(value);
    case 'notEmpty':
      return !isBlank(value);
    case 'formula':
      return formulaPasses(host, condition.formula, at, anchor);
    case 'between':
    case 'notBetween': {
      if (typeof value !== 'number') return false;
      const inside = value >= Math.min(condition.min, condition.max) && value <= Math.max(condition.min, condition.max);
      return condition.type === 'between' ? inside : !inside;
    }
    case 'greater':
    case 'greaterOrEqual':
    case 'less':
    case 'lessOrEqual':
    case 'equal':
    case 'notEqual':
      return typeof value === 'number' && compareNumber(condition.type, value, condition.value);
    default:
      return matchesText(condition.type, textOf(value), condition.value.toLowerCase());
  }
}

function compareNumber(type: 'greater' | 'greaterOrEqual' | 'less' | 'lessOrEqual' | 'equal' | 'notEqual', v: number, x: number): boolean {
  switch (type) {
    case 'greater':
      return v > x;
    case 'greaterOrEqual':
      return v >= x;
    case 'less':
      return v < x;
    case 'lessOrEqual':
      return v <= x;
    case 'equal':
      return v === x;
    case 'notEqual':
      return v !== x;
  }
}

function matchesText(type: 'textContains' | 'textNotContains' | 'textStartsWith' | 'textEndsWith' | 'textIs', text: string, wanted: string): boolean {
  switch (type) {
    case 'textContains':
      return text.includes(wanted);
    case 'textNotContains':
      return !text.includes(wanted);
    case 'textStartsWith':
      return text.startsWith(wanted);
    case 'textEndsWith':
      return text.endsWith(wanted);
    case 'textIs':
      return text === wanted;
  }
}

function formulaPasses(host: RuleHost, formula: string, at: CellAt, anchor: { row: number; col: number }): boolean {
  const moved = translateFormula(formula, at.row - anchor.row, at.col - anchor.col);
  const result = host.evaluateFormula(at.sheetId, at.row, at.col, moved);
  const v = Array.isArray(result) ? (result[0]?.[0] ?? null) : result;
  return v === true || (typeof v === 'number' && v !== 0);
}

function isBlank(v: Scalar): boolean {
  return v === null || v === '';
}

/** Lower-case text of a value for text tests; errors show their code. */
function textOf(v: Scalar): string {
  const t = toText(v);
  return (isError(t) ? t.code : t).toLowerCase();
}

/** The top-left cell of a rule's first range: where its formulas are written for. */
export function anchorOf(ranges: Range[]): { row: number; col: number } {
  const first = ranges[0];
  return first ? { row: first.r1, col: first.c1 } : { row: 0, col: 0 };
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/** The rows of `filter` (below its header row) that its columns hide. */
export function filteredRows(host: RuleHost, sheetId: string, filter: SheetFilter, rowCount: number): Set<number> {
  const out = new Set<number>();
  const columns = filter.columns.filter((c) => c.hiddenValues?.length || c.condition);
  if (columns.length === 0) return out;
  const last = Math.min(filter.range.r2, rowCount - 1);
  const hidden = columns.map((c) => new Set(c.hiddenValues ?? []));
  for (let row = filter.range.r1 + 1; row <= last; row++) {
    const fails = columns.some((c, i) => {
      const value = host.cellValue(sheetId, row, c.col);
      if (hidden[i]!.has(valueKey(value))) return true;
      if (!c.condition) return false;
      return !matchesCondition(host, c.condition, value, { sheetId, row, col: c.col }, { row: filter.range.r1 + 1, col: c.col });
    });
    if (fails) out.add(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conditional formatting
// ---------------------------------------------------------------------------

interface ScaleStats {
  min: number;
  max: number;
  sorted: number[];
}

/**
 * Per-render memo for colour scales (the min/max over a rule's ranges). The
 * editor makes a new one whenever the workbook changes.
 */
export type FormatCache = Map<string, ScaleStats | null>;

/**
 * The conditional style of a cell: the first format (in `order`) whose ranges
 * cover it and whose rule matches. `sheet.conditionalFormats` is kept in that order.
 */
export function conditionalStyleAt(host: RuleHost, sheet: Sheet, row: number, col: number, cache: FormatCache): ConditionalStyle | undefined {
  for (const cf of sheet.conditionalFormats) {
    if (!cf.ranges.some((r) => rangeContains(r, row, col))) continue;
    const value = host.cellValue(sheet.id, row, col);
    const style = ruleStyle(host, sheet.id, cf, row, col, value, cache);
    if (style) return style;
  }
  return undefined;
}

function ruleStyle(host: RuleHost, sheetId: string, cf: ConditionalFormat, row: number, col: number, value: Scalar, cache: FormatCache): ConditionalStyle | undefined {
  const { rule } = cf;
  if (rule.type === 'condition') {
    return matchesCondition(host, rule.condition, value, { sheetId, row, col }, anchorOf(cf.ranges)) ? rule.style : undefined;
  }
  if (typeof value !== 'number' || rule.points.length < 2) return undefined;
  let stats = cache.get(cf.id);
  if (stats === undefined) {
    stats = scaleStats(host, sheetId, cf.ranges);
    cache.set(cf.id, stats);
  }
  return stats ? { fill: scaleColor(rule.points, stats, value) } : undefined;
}

function scaleStats(host: RuleHost, sheetId: string, ranges: Range[]): ScaleStats | null {
  const values: number[] = [];
  for (const r of ranges) host.forEachValue(sheetId, r, (_row, _col, v) => typeof v === 'number' && values.push(v));
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return { min: values[0]!, max: values.at(-1)!, sorted: values };
}

function pointValue(p: ColorPoint, stats: ScaleStats): number {
  const v = p.value ?? 0;
  switch (p.kind) {
    case 'min':
      return stats.min;
    case 'max':
      return stats.max;
    case 'number':
      return v;
    case 'percent':
      return stats.min + ((stats.max - stats.min) * v) / 100;
    case 'percentile': {
      const pos = ((stats.sorted.length - 1) * Math.max(0, Math.min(100, v))) / 100;
      const lo = Math.floor(pos);
      const hi = Math.min(lo + 1, stats.sorted.length - 1);
      return stats.sorted[lo]! + (stats.sorted[hi]! - stats.sorted[lo]!) * (pos - lo);
    }
  }
}

/** The colour for `value` on a two- or three-point scale, interpolated in RGB. */
export function scaleColor(points: ColorPoint[], stats: ScaleStats, value: number): string {
  const stops = points.map((p) => ({ at: pointValue(p, stats), color: p.color }));
  if (value <= stops[0]!.at) return stops[0]!.color;
  for (let i = 1; i < stops.length; i++) {
    const lo = stops[i - 1]!;
    const hi = stops[i]!;
    if (value <= hi.at) return mix(lo.color, hi.color, hi.at === lo.at ? 1 : (value - lo.at) / (hi.at - lo.at));
  }
  return stops.at(-1)!.color;
}

function mix(a: string, b: string, t: number): string {
  const ca = rgb(a);
  const cb = rgb(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  const channel = (i: number) => Math.round(ca[i]! + (cb[i]! - ca[i]!) * t).toString(16).padStart(2, '0');
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function rgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------------------
// Data validation
// ---------------------------------------------------------------------------

/** The validation rule a cell follows: the last one in the list that covers it. */
export function validationAt(sheet: Sheet, row: number, col: number): DataValidation | undefined {
  for (let i = sheet.validations.length - 1; i >= 0; i--) {
    const dv = sheet.validations[i]!;
    if (dv.ranges.some((r) => rangeContains(r, row, col))) return dv;
  }
  return undefined;
}

/** The choices of a list rule, as text, in order and without repeats. */
export function listOptions(host: RuleHost, sheetId: string, dv: DataValidation): string[] {
  const c = dv.criteria;
  if (c.type === 'list') return [...new Set(c.values)];
  if (c.type !== 'listRange') return [];
  const anchor = anchorOf(dv.ranges);
  const result = host.evaluateFormula(sheetId, anchor.row, anchor.col, c.source);
  const flat = Array.isArray(result) ? result.flat() : [result];
  const texts = flat.filter((v) => !isBlank(v) && !isError(v)).map((v) => toText(v) as string);
  return [...new Set(texts)];
}

/**
 * Does `value`, about to be in (row, col), pass `dv`? Blank always passes. A
 * list item matches as text (any case), or a number as the item reads when
 * typed in `locale`: "10%" matches 0.1, "1,000" matches 1000.
 */
export function passesValidation(host: RuleHost, at: CellAt, dv: DataValidation, value: Scalar, locale?: FormatLocale): boolean {
  if (isBlank(value)) return true;
  const c = dv.criteria;
  switch (c.type) {
    case 'checkbox':
      return typeof value === 'boolean';
    case 'condition':
      return matchesCondition(host, c.condition, value, at, anchorOf(dv.ranges));
    default: {
      const text = textOf(value);
      const options = listOptions(host, at.sheetId, dv);
      if (options.some((o) => o.toLowerCase() === text)) return true;
      return typeof value === 'number' && options.some((o) => typedNumber(o, locale) === value);
    }
  }
}

/** The number `text` is when typed into a cell, if it is one. */
function typedNumber(text: string, locale: FormatLocale | undefined): number | undefined {
  const parsed = parseInput(text, { locale });
  return parsed.kind === 'value' && typeof parsed.value === 'number' ? parsed.value : undefined;
}
