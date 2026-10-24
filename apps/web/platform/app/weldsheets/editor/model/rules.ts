import {
  rangesIntersect,
  sortRangeOp,
  valueKey,
  type ConditionalFormat,
  type DataValidation,
  type FilterColumn,
  type Range,
  type Scalar,
  type SortKey,
} from '@weldsuite/sheets-engine';
import { clampToGrid, primaryRange } from './selection';
import type { SheetController } from './sheet-controller';

/**
 * Sheet-level commands for filters, sorting, conditional formatting and data
 * validation. Each builds the op and sends it through the controller, so it
 * undoes and co-edits like any other edit.
 */

/** The block of filled cells around (row, col), which a filter or a sort takes when one cell is selected. */
export function currentRegion(ctl: SheetController, row: number, col: number): Range {
  const sheet = ctl.sheet;
  const filled = (r: number, c: number) =>
    r >= 0 && c >= 0 && r < sheet.rowCount && c < sheet.colCount && ctl.engine.getValue(ctl.activeSheetId, r, c) !== null;
  const rowFilled = (r: number, c1: number, c2: number) => {
    for (let c = c1; c <= c2; c++) if (filled(r, c)) return true;
    return false;
  };
  const colFilled = (c: number, r1: number, r2: number) => {
    for (let r = r1; r <= r2; r++) if (filled(r, c)) return true;
    return false;
  };
  const r = { r1: row, c1: col, r2: row, c2: col };
  let grew = true;
  while (grew) {
    grew = false;
    // Neighbours count diagonally too, as in Excel's current region.
    if (rowFilled(r.r1 - 1, r.c1 - 1, r.c2 + 1)) [r.r1, grew] = [r.r1 - 1, true];
    if (rowFilled(r.r2 + 1, r.c1 - 1, r.c2 + 1)) [r.r2, grew] = [r.r2 + 1, true];
    if (colFilled(r.c1 - 1, r.r1, r.r2)) [r.c1, grew] = [r.c1 - 1, true];
    if (colFilled(r.c2 + 1, r.r1, r.r2)) [r.c2, grew] = [r.c2 + 1, true];
  }
  return r;
}

/** The selection, or its current region when it is one cell. */
function targetRange(ctl: SheetController): Range {
  const sheet = ctl.sheet;
  const sel = clampToGrid(primaryRange(ctl.selection), sheet.rowCount, sheet.colCount);
  return sel.r1 === sel.r2 && sel.c1 === sel.c2 ? currentRegion(ctl, sel.r1, sel.c1) : sel;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

/** Creates a filter on the selection (or its current region), or removes the sheet's filter. */
export function toggleFilter(ctl: SheetController): void {
  const filter = ctl.sheet.filter ? null : { range: targetRange(ctl), columns: [] };
  ctl.apply({ type: 'setFilter', sheetId: ctl.activeSheetId, filter });
}

/** Sets (or with null clears) what one column of the filter hides. */
export function setFilterColumn(ctl: SheetController, col: number, column: Omit<FilterColumn, 'col'> | null): void {
  const filter = ctl.sheet.filter;
  if (!filter) return;
  const others = filter.columns.filter((c) => c.col !== col);
  const keep = column && (column.hiddenValues?.length || column.condition);
  const columns = keep ? [...others, { col, ...column }].sort((a, b) => a.col - b.col) : others;
  ctl.apply({ type: 'setFilter', sheetId: ctl.activeSheetId, filter: { ...filter, columns } });
}

export interface FilterValue {
  /** `valueKey` of the value ('' for blanks). */
  key: string;
  /** As the cell shows it. */
  label: string;
  count: number;
}

/** The distinct values in a filter column below its header, numbers first, blanks last. */
export function filterValues(ctl: SheetController, col: number): FilterValue[] {
  const filter = ctl.sheet.filter;
  if (!filter) return [];
  const last = Math.min(filter.range.r2, ctl.sheet.rowCount - 1, ctl.engine.usedRange(ctl.activeSheetId)?.r2 ?? 0);
  const seen = new Map<string, FilterValue & { value: Scalar }>();
  for (let row = filter.range.r1 + 1; row <= last; row++) {
    const value = ctl.engine.getValue(ctl.activeSheetId, row, col);
    const key = valueKey(value);
    const entry = seen.get(key);
    if (entry) entry.count++;
    else seen.set(key, { key, label: key === '' ? '' : ctl.displayText(row, col).text, count: 1, value });
  }
  return [...seen.values()]
    .sort((a, b) => rank(a.value) - rank(b.value) || compareSame(a, b))
    .map(({ key, label, count }) => ({ key, label, count }));
}

function rank(v: Scalar): number {
  if (v === null || v === '') return 4;
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  return typeof v === 'boolean' ? 2 : 3;
}

function compareSame(a: { value: Scalar; label: string }, b: { value: Scalar; label: string }): number {
  if (typeof a.value === 'number' && typeof b.value === 'number') return a.value - b.value;
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

export type SortProblem = 'merged' | 'nothing';

/** Sorts a range by keys; returns why it did not when it did not. */
export function sortRange(ctl: SheetController, range: Range, keys: SortKey[], header: boolean): SortProblem | null {
  const result = sortRangeOp(ctl.engine, ctl.activeSheetId, range, keys, { header });
  if ('error' in result) return result.error;
  ctl.apply(result.op);
  return null;
}

/**
 * Sorts by one column: the filter's range when the column is in it, else the
 * selection (or its current region). Rows frozen at the top, or the filter's
 * first row, are headers and stay put.
 */
export function sortByColumn(ctl: SheetController, col: number, descending: boolean): SortProblem | null {
  const filter = ctl.sheet.filter;
  const inFilter = !!filter && col >= filter.range.c1 && col <= filter.range.c2;
  const range = inFilter ? filter.range : targetRange(ctl);
  const header = inFilter || range.r1 < ctl.sheet.freeze.rows;
  return sortRange(ctl, range, [{ col, descending }], header);
}

// ---------------------------------------------------------------------------
// Conditional formatting and data validation
// ---------------------------------------------------------------------------

export function newRuleId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `r_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The order for a new conditional format: after every existing one. */
export function nextFormatOrder(ctl: SheetController): number {
  return Math.max(0, ...ctl.sheet.conditionalFormats.map((cf) => cf.order)) + 1;
}

export function saveFormat(ctl: SheetController, cf: ConditionalFormat): void {
  ctl.apply({ type: 'patchConditionalFormats', sheetId: ctl.activeSheetId, set: [cf] });
}

export function removeFormat(ctl: SheetController, id: string): void {
  ctl.apply({ type: 'patchConditionalFormats', sheetId: ctl.activeSheetId, remove: [id] });
}

/** Moves a conditional format up or down the list (earlier rules win). */
export function moveFormat(ctl: SheetController, id: string, delta: -1 | 1): void {
  const list = ctl.sheet.conditionalFormats;
  const i = list.findIndex((cf) => cf.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  const a = list[i]!;
  const b = list[j]!;
  const set = a.order === b.order ? [{ ...a, order: b.order + delta * 0.5 }] : [{ ...a, order: b.order }, { ...b, order: a.order }];
  ctl.apply({ type: 'patchConditionalFormats', sheetId: ctl.activeSheetId, set });
}

/**
 * Saves a validation rule. A cell follows one rule, so the rule's ranges are
 * taken out of every other rule that covered them (a rule left empty goes).
 */
export function saveValidation(ctl: SheetController, dv: DataValidation): void {
  const set: DataValidation[] = [];
  const remove: string[] = [];
  for (const other of ctl.sheet.validations) {
    if (other.id === dv.id || !other.ranges.some((r) => dv.ranges.some((x) => rangesIntersect(r, x)))) continue;
    const ranges = dv.ranges.reduce((rest, cut) => rest.flatMap((r) => subtractRange(r, cut)), other.ranges);
    if (ranges.length) set.push({ ...other, ranges });
    else remove.push(other.id);
  }
  set.push(dv);
  ctl.apply({ type: 'patchValidations', sheetId: ctl.activeSheetId, set, remove });
}

export function removeValidation(ctl: SheetController, id: string): void {
  ctl.apply({ type: 'patchValidations', sheetId: ctl.activeSheetId, remove: [id] });
}

/** `a` without the cells of `b`: up to four ranges. */
export function subtractRange(a: Range, b: Range): Range[] {
  if (!rangesIntersect(a, b)) return [a];
  const out: Range[] = [];
  if (a.r1 < b.r1) out.push({ ...a, r2: b.r1 - 1 });
  if (a.r2 > b.r2) out.push({ ...a, r1: b.r2 + 1 });
  const r1 = Math.max(a.r1, b.r1);
  const r2 = Math.min(a.r2, b.r2);
  if (a.c1 < b.c1) out.push({ r1, r2, c1: a.c1, c2: b.c1 - 1 });
  if (a.c2 > b.c2) out.push({ r1, r2, c1: b.c2 + 1, c2: a.c2 });
  return out;
}
