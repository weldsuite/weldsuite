/**
 * PIVOT(source, rows, columns, values, [filters], [totals]): a pivot table
 * as a spilling formula. The computation is in ../../pivot/pivot.ts; this
 * reads the arguments.
 */

import { computePivot, layoutSpecFromArgs } from '../../pivot/pivot';
import type { EvalContext, FunctionSpec } from '../types';
import { ERR, isError, isMatrix, isRange, matrix, toText, type CellError, type EvalValue, type Scalar } from '../../values';
import { bool, values2d } from './helpers';

const omitted = (v: EvalValue | undefined) => v === undefined || v === null || v === '';

/** A field list: a text, or an array of texts (blanks left out). */
function texts(v: EvalValue | undefined, ctx: EvalContext): string[] | CellError {
  if (omitted(v)) return [];
  const grid = isMatrix(v) || isRange(v) ? values2d(v!, ctx) : [[v as Scalar]];
  if (isError(grid)) return grid;
  const out: string[] = [];
  for (const cell of grid.flat()) {
    if (cell === null || cell === '') continue;
    const t = toText(cell);
    if (isError(t)) return t;
    out.push(t);
  }
  return out;
}

/** Filters: rows of (field, shown value). */
function pairs(v: EvalValue | undefined, ctx: EvalContext): [string, string][] | CellError {
  if (omitted(v)) return [];
  const grid = values2d(v!, ctx);
  if (isError(grid)) return grid;
  const out: [string, string][] = [];
  for (const [field, value] of grid) {
    if (field === null || field === undefined || field === '') continue;
    const f = toText(field);
    const s = value === null || value === undefined ? '' : toText(value);
    if (isError(f)) return f;
    if (isError(s)) return s;
    out.push([f, s]);
  }
  return out;
}

/** The source's cells, a range cut to the cells its sheet uses (A:D holds a million blanks). */
function source(v: EvalValue, ctx: EvalContext): Scalar[][] | CellError {
  if (!isRange(v)) return isMatrix(v) ? v.data : ERR.value;
  const used = ctx.host.usedRange(v.sheetId);
  if (!used) return [];
  const r2 = Math.min(v.r2, used.r2);
  const c2 = Math.min(v.c2, used.c2);
  if (r2 < v.r1 || c2 < v.c1) return [];
  return values2d({ ...v, r2, c2 }, ctx);
}

function pivot(args: EvalValue[], ctx: EvalContext): EvalValue {
  const data = source(args[0]!, ctx);
  if (isError(data)) return data;
  const rows = texts(args[1], ctx);
  if (isError(rows)) return rows;
  const columns = texts(args[2], ctx);
  if (isError(columns)) return columns;
  const values = texts(args[3], ctx);
  if (isError(values)) return values;
  const filters = pairs(args[4], ctx);
  if (isError(filters)) return filters;
  const totals = omitted(args[5]) ? true : bool(args[5]!, ctx);
  if (isError(totals)) return totals;
  const spec = layoutSpecFromArgs(rows, columns, values, filters, totals);
  if (isError(spec)) return spec;
  const result = computePivot(data, spec);
  if (isError(result)) return result;
  return result.cells.length ? matrix(result.cells) : '';
}

export const pivotFunctions: FunctionSpec[] = [{ name: 'PIVOT', minArgs: 4, maxArgs: 6, impl: pivot }];
