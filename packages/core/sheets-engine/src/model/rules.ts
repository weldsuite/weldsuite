/**
 * Sheet rules: the basic filter, conditional formats and data validation.
 *
 * All three are plain data on the sheet, travel in ops and snapshots, and
 * share one `Condition` type. Their ranges move with row and column inserts,
 * deletes and moves, and their formulas are rewritten like cell formulas.
 * Evaluating them against cell values is in `rules/evaluate.ts`.
 */

import type { Range } from '../address';
import type { CellStyle } from './styles';
import { isError, type Scalar } from '../values';

/**
 * A test on one cell. Text tests ignore case. Number tests are false for
 * anything that is not a number (dates are numbers). A `formula` is written
 * for the top-left cell of the rule's first range and moves with each cell
 * like a copied formula; the cell passes when it gives TRUE or a non-zero number.
 */
export type Condition =
  | { type: 'empty' }
  | { type: 'notEmpty' }
  | { type: 'textContains' | 'textNotContains' | 'textStartsWith' | 'textEndsWith' | 'textIs'; value: string }
  | { type: 'greater' | 'greaterOrEqual' | 'less' | 'lessOrEqual' | 'equal' | 'notEqual'; value: number }
  | { type: 'between' | 'notBetween'; min: number; max: number }
  | { type: 'formula'; formula: string };

export type ConditionType = Condition['type'];

/** One filtered column of a basic filter. */
export interface FilterColumn {
  col: number;
  /** Value keys (`valueKey`) whose rows are hidden; values not listed stay visible. */
  hiddenValues?: string[];
  condition?: Condition;
}

/**
 * The sheet's basic filter (one per sheet, shared by everyone in it). The
 * first row of `range` is the header; the rows below it that fail a column's
 * test are hidden. It is re-applied as values change.
 */
export interface SheetFilter {
  range: Range;
  columns: FilterColumn[];
}

/** What a conditional format can change. */
export type ConditionalStyle = Pick<CellStyle, 'bold' | 'italic' | 'underline' | 'strike' | 'color' | 'fill'>;

/** A point of a colour scale: the lowest or highest value, or a number, percent or percentile. */
export interface ColorPoint {
  kind: 'min' | 'max' | 'number' | 'percent' | 'percentile';
  value?: number;
  color: string;
}

export type ConditionalRule =
  | { type: 'condition'; condition: Condition; style: ConditionalStyle }
  /** Two or three points (low, optional middle, high); colours the fill of number cells. */
  | { type: 'colorScale'; points: ColorPoint[] };

/** A conditional format. The first rule (lowest `order`) that matches a cell styles it. */
export interface ConditionalFormat {
  id: string;
  order: number;
  ranges: Range[];
  rule: ConditionalRule;
}

export type ValidationCriteria =
  /** One of these texts. */
  | { type: 'list'; values: string[] }
  /** One of the values in this reference (e.g. Lists!$A$1:$A$20). */
  | { type: 'listRange'; source: string }
  | { type: 'condition'; condition: Condition }
  /** TRUE or FALSE, shown as a checkbox. */
  | { type: 'checkbox' };

/** A data validation rule. A cell covered by several follows the last one in the list. */
export interface DataValidation {
  id: string;
  ranges: Range[];
  criteria: ValidationCriteria;
  /** Refuse invalid input; otherwise accept it and mark the cell. */
  strict: boolean;
  /** Show the list's dropdown arrow in the cell (lists only). */
  dropdown?: boolean;
  /** Shown when the cell is selected. */
  help?: string;
}

/**
 * Identifies a value for "filter by values": same value, same key, whatever
 * the number format or the viewer's locale (so every replica hides the same rows).
 */
export function valueKey(v: Scalar): string {
  if (v === null || v === '') return '';
  if (typeof v === 'number') return `n:${v}`;
  if (typeof v === 'string') return `s:${v}`;
  if (typeof v === 'boolean') return `b:${v}`;
  return isError(v) ? `e:${v.code}` : '';
}

/** Applies `fn` to every formula a condition holds. */
export function mapConditionFormula(c: Condition, fn: (f: string) => string): Condition {
  return c.type === 'formula' ? { ...c, formula: fn(c.formula) } : c;
}

export function mapFilterFormulas(f: SheetFilter, fn: (formula: string) => string): SheetFilter {
  return {
    ...f,
    columns: f.columns.map((c) => (c.condition ? { ...c, condition: mapConditionFormula(c.condition, fn) } : c)),
  };
}

export function mapFormatFormulas(cf: ConditionalFormat, fn: (formula: string) => string): ConditionalFormat {
  return cf.rule.type === 'condition' ? { ...cf, rule: { ...cf.rule, condition: mapConditionFormula(cf.rule.condition, fn) } } : cf;
}

export function mapValidationFormulas(dv: DataValidation, fn: (formula: string) => string): DataValidation {
  const c = dv.criteria;
  if (c.type === 'listRange') return { ...dv, criteria: { ...c, source: fn(c.source) } };
  if (c.type === 'condition') return { ...dv, criteria: { ...c, condition: mapConditionFormula(c.condition, fn) } };
  return dv;
}

/** Conditional formats in the order they apply (then by id, so equal states serialise identically). */
export function sortFormats(list: ConditionalFormat[]): ConditionalFormat[] {
  return [...list].sort((a, b) => a.order - b.order || compareIds(a.id, b.id));
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function cloneFilter(f: SheetFilter): SheetFilter {
  return JSON.parse(JSON.stringify(f)) as SheetFilter;
}

export function cloneFormat(cf: ConditionalFormat): ConditionalFormat {
  return JSON.parse(JSON.stringify(cf)) as ConditionalFormat;
}

export function cloneValidation(dv: DataValidation): DataValidation {
  return JSON.parse(JSON.stringify(dv)) as DataValidation;
}

/** Same JSON, so equal rules compare equal (rule objects only ever hold plain data). */
export function sameRule(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
