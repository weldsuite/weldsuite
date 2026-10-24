/**
 * Structural checks on an op before a room applies it: every sheet it names
 * exists at that point (following adds and deletes inside a batch), indices
 * and counts are within the sheet's limits, and sizes are sane. Returns a
 * reason, or null when the op is safe to apply. A room never applies an op
 * this rejects, so a bad client cannot leave the shared workbook half-changed.
 */

import { MAX_COLS, MAX_ROWS, type Range } from '../address';
import type { Workbook } from '../model/workbook';
import type { Op } from './types';

/** Cells one op may write; a paste larger than this is split by the client. */
export const MAX_CELLS_PER_OP = 2_000_000;

const MAX_SIZE = 5000;

type SheetOp = Exclude<Op, { type: 'batch' | 'addSheet' | 'deleteSheet' | 'renameSheet' | 'setNames' | 'patchNames' }>;

export function validateOp(workbook: Workbook, op: Op): string | null {
  return check(op, new Set(workbook.sheets.map((s) => s.id)));
}

/** `sheets` is the set of sheet ids at this point of the op; a batch updates it as it goes. */
function check(op: Op, sheets: Set<string>): string | null {
  switch (op.type) {
    case 'batch':
      return checkBatch(op.ops, sheets);
    case 'addSheet':
      if (sheets.has(op.sheetId)) return `sheet ${op.sheetId} exists`;
      sheets.add(op.sheetId);
      return fail(validSheetName(op.name), 'invalid sheet name');
    case 'deleteSheet':
      if (!sheets.has(op.sheetId)) return unknownSheet(op.sheetId);
      if (sheets.size <= 1) return 'cannot delete the last sheet';
      sheets.delete(op.sheetId);
      return null;
    case 'renameSheet':
      return sheets.has(op.sheetId) ? fail(validSheetName(op.name), 'invalid sheet name') : unknownSheet(op.sheetId);
    case 'setNames':
    case 'patchNames':
      return null;
    default:
      return sheets.has(op.sheetId) ? checkSheetOp(op) : unknownSheet(op.sheetId);
  }
}

function checkBatch(ops: Op[], sheets: Set<string>): string | null {
  for (const o of ops) {
    const problem = check(o, sheets);
    if (problem) return problem;
  }
  return null;
}

function checkSheetOp(op: SheetOp): string | null {
  switch (op.type) {
    case 'setCells':
      return checkCells(op.cells);
    case 'setStyles':
      return checkCells(op.cells) ?? fail(indicesOk(op.rows, MAX_ROWS) && indicesOk(op.cols, MAX_COLS), 'out of range');
    case 'formatRanges':
    case 'merge':
    case 'unmerge':
      return fail(op.ranges.every(validRange), 'range out of bounds');
    case 'insertDims':
    case 'deleteDims':
      return fail(countOk(op.at, op.count, axisMax(op.axis)), 'out of range');
    case 'moveDims':
      return fail(countOk(op.from, op.count, axisMax(op.axis)) && inAxis(op.to, axisMax(op.axis) + 1), 'out of range');
    case 'resizeDims':
      return fail(op.entries.every(([i, size]) => inAxis(i, axisMax(op.axis)) && validSize(size)), 'out of range');
    case 'hideDims':
      return fail(op.indices.every((i) => inAxis(i, axisMax(op.axis))), 'out of range');
    case 'setFreeze':
      return fail(inAxis(op.rows, MAX_ROWS) && inAxis(op.cols, MAX_COLS), 'out of range');
    case 'setGridSize':
      return fail(optionalCount(op.rowCount, MAX_ROWS) && optionalCount(op.colCount, MAX_COLS), 'out of range');
    case 'moveSheet':
      return fail(Number.isInteger(op.index) && op.index >= 0, 'out of range');
    case 'setSheetProps':
      return null;
  }
}

function checkCells(cells: readonly (readonly [number, number, ...unknown[]])[]): string | null {
  if (cells.length > MAX_CELLS_PER_OP) return 'too many cells';
  return fail(
    cells.every(([r, c]) => inCell(r, c)),
    'cell out of range',
  );
}

function fail(ok: boolean, reason: string): string | null {
  return ok ? null : reason;
}

function unknownSheet(sheetId: string): string {
  return `unknown sheet ${sheetId}`;
}

function axisMax(axis: 'row' | 'col'): number {
  return axis === 'row' ? MAX_ROWS : MAX_COLS;
}

function inAxis(i: number, max: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < max;
}

function indicesOk(entries: readonly (readonly [number, ...unknown[]])[] | undefined, max: number): boolean {
  return (entries ?? []).every(([i]) => inAxis(i, max));
}

function inCell(r: number, c: number): boolean {
  return inAxis(r, MAX_ROWS) && inAxis(c, MAX_COLS);
}

function validRange(r: Range): boolean {
  return inCell(r.r1, r.c1) && inCell(r.r2, r.c2) && r.r1 <= r.r2 && r.c1 <= r.c2;
}

function validSize(size: number | null): boolean {
  return size === null || (size >= 0 && size <= MAX_SIZE);
}

function countOk(at: number, count: number, max: number): boolean {
  return inAxis(at, max + 1) && Number.isInteger(count) && count > 0 && at + count <= max;
}

function optionalCount(count: number | undefined, max: number): boolean {
  return count === undefined || inAxis(count - 1, max);
}

function validSheetName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 100 && !/[\\/?*[\]:]/.test(trimmed);
}
