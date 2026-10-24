/**
 * Pivot tables as the editor sees them: the cells holding a PIVOT formula,
 * the spec it holds, its source, and the layout of what it shows (which rows
 * are headers and totals, which value each column shows), for styling the
 * output and for the pivot editor.
 */

import type { Engine } from '../calc/engine';
import { resolveRef, type RangeAt } from '../charts/data';
import type { Range } from '../address';
import { computePivot, isPivotFormula, parsePivotFormula, type PivotResult, type PivotSpec } from './pivot';
import { isError, type Scalar } from '../values';

export interface PivotTable {
  /** The cell holding the PIVOT formula. */
  row: number;
  col: number;
  spec: PivotSpec;
  /** The source cells; null when the reference no longer resolves. */
  source: RangeAt | null;
  /** Where its output spilled; absent while it shows a single value or an error. */
  area?: Range;
}

export interface PivotTableLayout extends PivotTable {
  area: Range;
  layout: PivotResult;
}

/** The pivot table a cell holds or shows part of; null for any other cell. */
export function pivotTableAt(engine: Engine, sheetId: string, row: number, col: number): PivotTable | null {
  const anchor = engine.spillAnchorAt(sheetId, row, col) ?? { row, col };
  return pivotTableOf(engine, sheetId, anchor.row, anchor.col);
}

function pivotTableOf(engine: Engine, sheetId: string, row: number, col: number): PivotTable | null {
  const formula = engine.cellFormula(sheetId, row, col);
  if (!formula || !isPivotFormula(formula)) return null;
  const spec = parsePivotFormula(formula);
  if (!spec) return null;
  const area = engine.spillArea(sheetId, row, col);
  const table: PivotTable = { row, col, spec, source: resolveRef(engine, spec.source, sheetId) };
  if (area) table.area = area;
  return table;
}

/** The pivot tables showing output on a sheet, with the layout of each. */
export function pivotTablesOn(engine: Engine, sheetId: string): PivotTableLayout[] {
  const out: PivotTableLayout[] = [];
  for (const spill of engine.spillsOn(sheetId)) {
    const table = pivotTableOf(engine, sheetId, spill.row, spill.col);
    if (!table?.source) continue;
    const layout = computePivot(pivotSourceData(engine, table.source), table.spec);
    if (!isError(layout)) out.push({ ...table, area: spill.area, layout });
  }
  return out;
}

/** A pivot source's cells, cut to what its sheet uses; the first row names the fields. */
export function pivotSourceData(engine: Engine, at: RangeAt): Scalar[][] {
  const used = engine.usedRange(at.sheetId);
  if (!used) return [];
  const r: Range = { ...at.range, r2: Math.min(at.range.r2, used.r2), c2: Math.min(at.range.c2, used.c2) };
  if (r.r2 < r.r1 || r.c2 < r.c1) return [];
  const data: Scalar[][] = Array.from({ length: r.r2 - r.r1 + 1 }, () => new Array<Scalar>(r.c2 - r.c1 + 1).fill(null));
  engine.forEachValue(at.sheetId, r, (row, col, value) => {
    data[row - r.r1]![col - r.c1] = value;
  });
  return data;
}
