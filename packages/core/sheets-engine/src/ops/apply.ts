/**
 * Applies ops to an Engine. `applyOp` returns the op's exact inverse,
 * captured from the state it changed, which is what undo replays.
 */

import { MAX_COLS, MAX_ROWS, rangesIntersect, type Range } from '../address';
import { Engine, mapRangeDelete, mapRangeInsert, type CellContent, type RewrittenFormula } from '../calc/engine';
import { moveIndexMapper, type Axis } from '../formula/references';
import type { Cell } from '../model/cell-store';
import type { StylePatch } from '../model/styles';
import { sheetFromJSON, sheetToJSON, type Sheet, type SheetProps } from '../model/workbook';
import { normalize, type AxisEntry, type CellPatch, type Op } from './types';

/** Applies `op`, recalculates, and returns its inverse. */
export function applyOp(engine: Engine, op: Op): Op {
  const inverse = applyInner(engine, op);
  engine.recalc();
  return normalize(inverse);
}

function contentOf(cell: Cell | undefined): CellContent | null {
  if (!cell) return null;
  if (cell.f !== undefined) return { f: cell.f };
  return cell.v === null ? null : { v: cell.v };
}

function applyInner(engine: Engine, op: Op): Op {
  switch (op.type) {
    case 'batch': {
      const inverses: Op[] = [];
      for (const o of op.ops) inverses.push(applyInner(engine, o));
      return { type: 'batch', ops: inverses.reverse() };
    }

    case 'setCells': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const prev: CellPatch[] = [];
      for (const [row, col, content] of op.cells) {
        prev.push([row, col, contentOf(sheet.cells.get(row, col))]);
        engine.setContent(op.sheetId, row, col, content);
      }
      return { type: 'setCells', sheetId: op.sheetId, cells: prev.reverse() };
    }

    case 'formatRanges':
      return formatRanges(engine, op.sheetId, op.ranges, op.patch);

    case 'setStyles': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const prevCells: [number, number, string | null][] = [];
      for (const [row, col, key] of op.cells) {
        prevCells.push([row, col, sheet.cells.get(row, col)?.s ?? null]);
        engine.setStyleKey(op.sheetId, row, col, key ?? undefined);
      }
      const prevRows = setAxisStyles(sheet, 'row', op.rows);
      const prevCols = setAxisStyles(sheet, 'col', op.cols);
      const inverse: Op = { type: 'setStyles', sheetId: op.sheetId, cells: prevCells.reverse() };
      if (prevRows) inverse.rows = prevRows;
      if (prevCols) inverse.cols = prevCols;
      return inverse;
    }

    case 'insertDims': {
      const rewritten = engine.insertDims(op.sheetId, op.axis, op.at, op.count);
      const back = (i: number) => (i >= op.at + op.count ? i - op.count : i);
      return {
        type: 'batch',
        ops: [
          { type: 'deleteDims', sheetId: op.sheetId, sheetName: currentName(engine, op.sheetId), axis: op.axis, at: op.at, count: op.count },
          ...restoreFormulas(rewritten, op.sheetId, op.axis, back),
        ],
      };
    }

    case 'deleteDims':
      return deleteDims(engine, op.sheetId, op.axis, op.at, op.count);

    case 'moveDims': {
      const rewritten = engine.moveDims(op.sheetId, op.axis, op.from, op.count, op.to);
      const p = op.to < op.from ? op.to : op.to - op.count;
      const backTo = p < op.from ? op.from + op.count : op.from;
      const back = moveIndexMapper(p, op.count, backTo);
      return {
        type: 'batch',
        ops: [
          { type: 'moveDims', sheetId: op.sheetId, sheetName: currentName(engine, op.sheetId), axis: op.axis, from: p, count: op.count, to: backTo },
          ...restoreFormulas(rewritten, op.sheetId, op.axis, back),
        ],
      };
    }

    case 'resizeDims': {
      const axis = axisOf(engine.workbook.requireSheet(op.sheetId), op.axis);
      const prev: AxisEntry<number>[] = [];
      for (const [i, size] of op.entries) {
        prev.push([i, axis.storedSize(i) ?? null]);
        axis.setSize(i, size ?? undefined);
      }
      return { type: 'resizeDims', sheetId: op.sheetId, axis: op.axis, entries: prev.reverse() };
    }

    case 'hideDims': {
      const axis = axisOf(engine.workbook.requireSheet(op.sheetId), op.axis);
      const changed = op.indices.filter((i) => axis.isHidden(i) !== op.hidden);
      for (const i of changed) axis.setHidden(i, op.hidden);
      return { type: 'hideDims', sheetId: op.sheetId, axis: op.axis, indices: changed, hidden: !op.hidden };
    }

    case 'addSheet': {
      const sheet = op.snapshot ? sheetFromJSON({ ...op.snapshot, id: op.sheetId, name: op.name }) : undefined;
      engine.addSheet(op.sheetId, op.name, op.index, sheet);
      return { type: 'deleteSheet', sheetId: op.sheetId, sheetName: op.name };
    }

    case 'deleteSheet': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const snapshot = sheetToJSON(sheet);
      const names = engine.workbook.names.map((n) => ({ ...n }));
      const { index, rewritten } = engine.removeSheet(op.sheetId);
      return {
        type: 'batch',
        ops: [
          { type: 'addSheet', sheetId: op.sheetId, name: snapshot.name, index, snapshot },
          ...restoreFormulas(rewritten, null, 'row', (i) => i),
          { type: 'setNames', names },
        ],
      };
    }

    case 'renameSheet': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const old = sheet.name;
      engine.renameSheet(op.sheetId, op.name);
      return { type: 'renameSheet', sheetId: op.sheetId, oldName: op.name, name: old };
    }

    case 'moveSheet': {
      const prev = engine.workbook.sheets.findIndex((s) => s.id === op.sheetId);
      engine.moveSheet(op.sheetId, op.index);
      return { type: 'moveSheet', sheetId: op.sheetId, index: prev };
    }

    case 'setSheetProps': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const prev: { [K in keyof SheetProps]?: SheetProps[K] | null } = {};
      const props = sheet.props as Record<string, unknown>;
      for (const [k, v] of Object.entries(op.props)) {
        (prev as Record<string, unknown>)[k] = props[k] ?? null;
        if (v === null || v === undefined) delete props[k];
        else props[k] = v;
      }
      return { type: 'setSheetProps', sheetId: op.sheetId, props: prev };
    }

    case 'setGridSize': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const prev = { rowCount: sheet.rowCount, colCount: sheet.colCount };
      if (op.rowCount !== undefined) sheet.rowCount = clamp(op.rowCount, 1, MAX_ROWS);
      if (op.colCount !== undefined) sheet.colCount = clamp(op.colCount, 1, MAX_COLS);
      return { type: 'setGridSize', sheetId: op.sheetId, ...prev };
    }

    case 'merge': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const removed = sheet.merges.filter((m) => op.ranges.some((r) => rangesIntersect(m, r)));
      sheet.merges = sheet.merges.filter((m) => !removed.includes(m));
      const added = op.ranges.filter((r) => r.r1 !== r.r2 || r.c1 !== r.c2).map((r) => ({ ...r }));
      sheet.merges.push(...added);
      return {
        type: 'batch',
        ops: [
          { type: 'unmerge', sheetId: op.sheetId, ranges: added },
          { type: 'merge', sheetId: op.sheetId, ranges: removed },
        ],
      };
    }

    case 'unmerge': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const removed = sheet.merges.filter((m) => op.ranges.some((r) => rangesIntersect(m, r)));
      sheet.merges = sheet.merges.filter((m) => !removed.includes(m));
      return { type: 'merge', sheetId: op.sheetId, ranges: removed };
    }

    case 'setFreeze': {
      const sheet = engine.workbook.requireSheet(op.sheetId);
      const prev = { ...sheet.freeze };
      sheet.freeze = { rows: Math.max(0, op.rows), cols: Math.max(0, op.cols) };
      return { type: 'setFreeze', sheetId: op.sheetId, ...prev };
    }

    case 'setNames': {
      const prev = engine.workbook.names.map((n) => ({ ...n }));
      engine.setNames(op.names);
      return { type: 'setNames', names: prev };
    }
  }
}

function currentName(engine: Engine, sheetId: string): string {
  return engine.workbook.getSheet(sheetId)?.name ?? '';
}

function axisOf(sheet: Sheet, axis: Axis) {
  return axis === 'row' ? sheet.rows : sheet.cols;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function setAxisStyles(sheet: Sheet, axis: Axis, entries: AxisEntry<string>[] | undefined): AxisEntry<string>[] | undefined {
  if (!entries?.length) return undefined;
  const styles = axisOf(sheet, axis).styles;
  const prev: AxisEntry<string>[] = [];
  for (const [i, key] of entries) {
    prev.push([i, styles.get(i) ?? null]);
    if (key === null) styles.delete(i);
    else styles.set(i, key);
  }
  return prev.reverse();
}

/**
 * setCells ops that put back formula text a structural change rewrote.
 * `map` takes an index on `axis` from where the formula is now to where it
 * will be once the inverse's own structural op has run.
 */
function restoreFormulas(
  rewritten: RewrittenFormula[],
  sheetId: string | null,
  axis: Axis,
  map: (i: number) => number,
): Op[] {
  const bySheet = new Map<string, CellPatch[]>();
  for (const r of rewritten) {
    let row = r.row;
    let col = r.col;
    if (r.sheetId === sheetId) {
      if (axis === 'row') row = map(row);
      else col = map(col);
    }
    let list = bySheet.get(r.sheetId);
    if (!list) {
      list = [];
      bySheet.set(r.sheetId, list);
    }
    list.push([row, col, { f: r.before }]);
  }
  return [...bySheet].map(([id, cells]) => ({ type: 'setCells', sheetId: id, cells }));
}

function formatRanges(engine: Engine, sheetId: string, ranges: Range[], patch: StylePatch): Op {
  const sheet = engine.workbook.requireSheet(sheetId);
  const styles = engine.workbook.styles;
  const prevCells: [number, number, string | null][] = [];
  const prevRows: AxisEntry<string>[] = [];
  const prevCols: AxisEntry<string>[] = [];
  const seen = new Set<number>();

  const patchCell = (row: number, col: number) => {
    const k = row * MAX_COLS + col;
    if (seen.has(k)) return;
    seen.add(k);
    const own = sheet.cells.get(row, col)?.s;
    prevCells.push([row, col, own ?? null]);
    engine.setStyleKey(sheetId, row, col, styles.patch(sheet.styleKeyAt(row, col), patch));
  };

  for (const r of ranges) {
    const wholeCols = r.r1 === 0 && r.r2 === MAX_ROWS - 1;
    const wholeRows = r.c1 === 0 && r.c2 === MAX_COLS - 1;
    if (wholeCols || wholeRows) {
      const axis = wholeCols ? sheet.cols : sheet.rows;
      const [lo, hi] = wholeCols ? [r.c1, r.c2] : [r.r1, r.r2];
      for (let i = lo; i <= hi; i++) {
        (wholeCols ? prevCols : prevRows).push([i, axis.styles.get(i) ?? null]);
        const next = styles.patch(axis.styles.get(i), patch);
        if (next === undefined) axis.styles.delete(i);
        else axis.styles.set(i, next);
      }
      // Cells with their own style don't inherit the row/column style: patch them too.
      sheet.cells.forEachInRange(r, (row, col, cell) => {
        if (cell.s !== undefined) patchCell(row, col);
      });
      if (wholeCols) {
        // Rows with their own style would win over the new column style.
        for (const row of sheet.rows.styles.keys()) for (let c = r.c1; c <= r.c2; c++) patchCell(row, c);
      }
    } else {
      for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) patchCell(row, col);
    }
  }

  const inverse: Op = { type: 'setStyles', sheetId, cells: prevCells.reverse() };
  if (prevRows.length) inverse.rows = prevRows.reverse();
  if (prevCols.length) inverse.cols = prevCols.reverse();
  return inverse;
}

function deleteDims(engine: Engine, sheetId: string, axis: Axis, at: number, count: number): Op {
  const sheet = engine.workbook.requireSheet(sheetId);
  const end = at + count;
  const band: Range =
    axis === 'row' ? { r1: at, c1: 0, r2: end - 1, c2: MAX_COLS - 1 } : { r1: 0, c1: at, r2: MAX_ROWS - 1, c2: end - 1 };

  const contents: CellPatch[] = [];
  const cellStyles: [number, number, string | null][] = [];
  sheet.cells.forEachInRange(band, (row, col, cell) => {
    const content = contentOf(cell);
    if (content) contents.push([row, col, content]);
    if (cell.s !== undefined) cellStyles.push([row, col, cell.s]);
  });
  const dims = axisOf(sheet, axis);
  const sizes: AxisEntry<number>[] = [];
  const hidden: number[] = [];
  const axisStyles: AxisEntry<string>[] = [];
  for (let i = at; i < end; i++) {
    const size = dims.storedSize(i);
    if (size !== undefined) sizes.push([i, size]);
    if (dims.isHidden(i)) hidden.push(i);
    const s = dims.styles.get(i);
    if (s !== undefined) axisStyles.push([i, s]);
  }
  const merges = sheet.merges.filter((m) => rangesIntersect(m, band)).map((m) => ({ ...m }));
  const freeze = { ...sheet.freeze };
  const grid = { rowCount: sheet.rowCount, colCount: sheet.colCount };
  const sheetName = sheet.name;

  const rewritten = engine.deleteDims(sheetId, axis, at, count);

  // Merges that survive shrunk come back shrunk after re-insertion; swap them for the originals.
  const shrunk = merges.flatMap((m) => {
    const after = mapRangeDelete(m, axis, at, count);
    if (!after || (after.r1 === after.r2 && after.c1 === after.c2)) return [];
    const back = mapRangeInsert(after, axis, at, count);
    return back.r1 === m.r1 && back.r2 === m.r2 && back.c1 === m.c1 && back.c2 === m.c2 ? [] : [back];
  });

  const back = (i: number) => (i >= at ? i + count : i);
  const styleOp: Op = { type: 'setStyles', sheetId, cells: cellStyles };
  if (axisStyles.length) {
    if (axis === 'row') styleOp.rows = axisStyles;
    else styleOp.cols = axisStyles;
  }
  return {
    type: 'batch',
    ops: [
      { type: 'insertDims', sheetId, sheetName, axis, at, count },
      { type: 'resizeDims', sheetId, axis, entries: sizes },
      { type: 'hideDims', sheetId, axis, indices: hidden, hidden: true },
      styleOp,
      { type: 'setCells', sheetId, cells: contents },
      ...restoreFormulas(rewritten, sheetId, axis, back),
      { type: 'unmerge', sheetId, ranges: shrunk },
      { type: 'merge', sheetId, ranges: merges },
      { type: 'setFreeze', sheetId, ...freeze },
      { type: 'setGridSize', sheetId, ...grid },
    ],
  };
}
