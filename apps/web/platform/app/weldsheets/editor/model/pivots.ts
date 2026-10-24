/**
 * Pivot table commands of the editor: create one from a block of cells (on
 * a new sheet or at a cell), and rewrite its PIVOT formula as the pivot
 * editor changes it. A pivot table is that one formula, so each change is
 * one `setCells` op that co-edits and undoes like any other.
 */

import {
  pivotFormula,
  pivotSourceData,
  refText,
  resolveRef,
  toText,
  isError,
  type Op,
  type PivotLayoutSpec,
  type PivotSpec,
  type PivotTable,
  type RangeAt,
  type Scalar,
} from '@weldsuite/sheets-engine';
import { cellSelection } from './selection';
import { newSheetId, type SheetController } from './sheet-controller';

/** Distinct values a filter lists at most; the editor does not add a filter on a field with more. */
export const MAX_FILTER_VALUES = 500;

export interface FieldValues {
  /** As text, in order ('' for blanks). */
  values: string[];
  /** False when the field has more distinct values than a filter lists, and `values` is only the first of them. */
  complete: boolean;
}

/** A cell typed as where the pivot table goes (B3, 'Report'!B3); null when it is not one. */
export function parseTargetCell(ctl: SheetController, text: string): { sheetId: string; row: number; col: number } | null {
  const clean = text.trim().replace(/^=/, '');
  const at = clean ? resolveRef(ctl.engine, clean, ctl.activeSheetId) : null;
  return at ? { sheetId: at.sheetId, row: at.range.r1, col: at.range.c1 } : null;
}

/** The field names a source gives: its first row's texts, blanks and repeats left out. */
export function pivotFields(ctl: SheetController, source: RangeAt): string[] {
  const header = pivotSourceData(ctl.engine, source)[0] ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of header) {
    const name = textOf(v).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** The values a field holds: what a filter can show or hide. */
export function fieldValues(ctl: SheetController, source: RangeAt, field: string): FieldValues {
  const data = pivotSourceData(ctl.engine, source);
  const col = (data[0] ?? []).findIndex((v) => textOf(v).trim().toLowerCase() === field.trim().toLowerCase());
  if (col < 0) return { values: [], complete: true };
  const seen = new Map<string, string>();
  let complete = true;
  for (const row of data.slice(1)) {
    if (!row.some((v) => v !== null && v !== '')) continue;
    const text = textOf(row[col] ?? null);
    if (seen.has(text.toLowerCase())) continue;
    if (seen.size === MAX_FILTER_VALUES) {
      complete = false;
      break;
    }
    seen.set(text.toLowerCase(), text);
  }
  return { values: [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), complete };
}

/** A first layout that shows something: the first text field as rows, the sum of the first number field. */
export function suggestedLayout(data: Scalar[][]): PivotLayoutSpec {
  const header = data[0] ?? [];
  const sample = data.slice(1, 50);
  const kind = (col: number) => {
    const values = sample.map((r) => r[col] ?? null).filter((v) => v !== null && v !== '');
    if (values.length && values.every((v) => typeof v === 'number')) return 'number';
    return values.length ? 'text' : 'empty';
  };
  const named = header.flatMap((v, col) => (textOf(v).trim() ? [{ name: textOf(v).trim(), col }] : []));
  const label = named.find((f) => kind(f.col) === 'text');
  const number = named.find((f) => f !== label && kind(f.col) === 'number');
  return {
    rows: label ? [{ field: label.name }] : [],
    columns: [],
    values: number ? [{ field: number.name, fn: 'SUM' }] : [],
    filters: [],
    totals: true,
  };
}

export type CreatePivotProblem = 'noSource' | 'noFields' | 'noTarget';

/**
 * A pivot table of `source`, on a new sheet (`target` null) named after
 * `sheetName`, or with its corner at `target`. The new table is selected,
 * so its editor opens. Returns what stopped it, if anything.
 */
export function createPivotTable(
  ctl: SheetController,
  source: RangeAt | null,
  target: { sheetId: string; row: number; col: number } | null,
  sheetName: string,
): CreatePivotProblem | null {
  if (ctl.readOnly) return null;
  if (!source) return 'noSource';
  const data = pivotSourceData(ctl.engine, source);
  if (data.length < 2 || pivotFields(ctl, source).length === 0) return 'noFields';
  const spec: PivotSpec = { source: refText(ctl.engine, source), ...suggestedLayout(data) };
  const content = { v: null, f: pivotFormula(spec) };
  if (target) {
    if (!ctl.engine.workbook.getSheet(target.sheetId)) return 'noTarget';
    ctl.apply({ type: 'setCells', sheetId: target.sheetId, cells: [[target.row, target.col, content]] });
    ctl.goTo(target.sheetId, target.row, target.col);
  } else {
    const sheetId = newSheetId();
    const ops: Op[] = [
      { type: 'addSheet', sheetId, name: freeName(ctl, sheetName), index: ctl.engine.workbook.sheets.length },
      { type: 'setCells', sheetId, cells: [[0, 0, content]] },
    ];
    ctl.apply({ type: 'batch', ops });
    ctl.setActiveSheet(sheetId);
    ctl.select(cellSelection(0, 0));
  }
  ctl.openPanel('pivot');
  return null;
}

/** `base 1`, `base 2`, …: the first one no sheet has. */
function freeName(ctl: SheetController, base: string): string {
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`;
    if (!ctl.engine.workbook.getSheetByName(name)) return name;
  }
}

/** Rewrites a pivot table's formula for a changed spec. */
export function savePivot(ctl: SheetController, table: PivotTable, spec: PivotSpec): void {
  ctl.apply({ type: 'setCells', sheetId: ctl.activeSheetId, cells: [[table.row, table.col, { v: null, f: pivotFormula(spec) }]] });
}

function textOf(v: Scalar): string {
  if (v === null) return '';
  const t = toText(v);
  return isError(t) ? '' : t;
}
