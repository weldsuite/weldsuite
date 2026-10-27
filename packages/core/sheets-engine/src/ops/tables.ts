/**
 * Blocks of values in and out of a workbook, for writers that are not a
 * person at the grid: a connected table's refresh (sheets-api writes WeldSuite
 * records into its block) and agent tools that read and write ranges. Each
 * write is an op, committed by the room like anyone's edit, so it co-edits
 * and undoes.
 */

import { MAX_COLS, MAX_ROWS, type Range } from '../address';
import type { Engine } from '../calc/engine';
import type { SheetFilter } from '../model/rules';
import type { StylePatch } from '../model/styles';
import { DEFAULT_COL_COUNT, DEFAULT_ROW_COUNT } from '../model/workbook';
import { isError, type Scalar } from '../values';
import type { CellPatch, Op } from './types';

/**
 * Where a connected table not yet in the workbook goes: its top-left cell on
 * a tab, or a new tab of its own (named after `name`, numbered when taken).
 */
export type DataTablePlace = { sheetId: string; row: number; col: number } | { newSheet: { id: string; name: string } };

/** What a connected table's refresh writes. */
export interface DataTableWrite {
  /** The data source's id (the table's id in the sheet's `dataTables`). */
  id: string;
  /** Where a table not yet in the workbook goes. Ignored once it has a block. */
  at?: DataTablePlace;
  /** Column titles, written bold in the block's first row. */
  header: string[];
  /** Records, one array per row, as wide as `header`. */
  rows: Scalar[][];
  /** Per column, a number format for its values (dates show as dates). */
  formats?: (string | undefined)[];
}

/**
 * The op that writes a connected table: its header and records from the
 * block's top-left cell, what the old block held beyond the new one cleared,
 * and the block recorded. The sheet grows to hold the block, and a filter on
 * the table's header follows it. A table placed on a new tab gets that tab,
 * with its header row frozen and filtered. A string says why it cannot be written.
 */
export function dataTableOp(engine: Engine, write: DataTableWrite): Op | string {
  const placed = findDataTable(engine, write.id);
  const fresh = !placed && write.at && 'newSheet' in write.at ? write.at.newSheet : null;
  const cell = !placed && write.at && 'sheetId' in write.at ? write.at : null;
  const sheetId = placed?.sheetId ?? fresh?.id ?? cell?.sheetId;
  const sheet = sheetId ? engine.workbook.getSheet(sheetId) : undefined;
  if (!sheetId || (!sheet && !fresh) || (sheet && fresh)) return 'The table has no place in the workbook';
  const top = placed ? placed.range.r1 : (cell?.row ?? 0);
  const left = placed ? placed.range.c1 : (cell?.col ?? 0);
  const width = Math.max(1, write.header.length);
  if (top + write.rows.length >= MAX_ROWS || left + width > MAX_COLS) return 'The table does not fit on the sheet';
  const range: Range = { r1: top, c1: left, r2: top + write.rows.length, c2: left + width - 1 };

  const ops: Op[] = [];
  if (fresh) {
    ops.push(
      { type: 'addSheet', sheetId, name: tableSheetName(engine, fresh.name), index: engine.workbook.sheets.length },
      { type: 'setFreeze', sheetId, rows: 1, cols: 0 },
    );
  }
  const rowCount = sheet?.rowCount ?? DEFAULT_ROW_COUNT;
  const colCount = sheet?.colCount ?? DEFAULT_COL_COUNT;
  if (range.r2 >= rowCount || range.c2 >= colCount) {
    ops.push({ type: 'setGridSize', sheetId, rowCount: Math.max(rowCount, range.r2 + 1), colCount: Math.max(colCount, range.c2 + 1) });
  }

  const cells: CellPatch[] = [];
  write.header.forEach((title, j) => cells.push([top, left + j, title ? { v: title } : null]));
  write.rows.forEach((row, i) => {
    for (let j = 0; j < width; j++) {
      const v = row[j] ?? null;
      cells.push([top + 1 + i, left + j, v === null || v === '' ? null : { v }]);
    }
  });
  // What the previous refresh wrote outside the new block.
  if (placed) {
    const old = placed.range;
    for (let r = old.r1; r <= old.r2; r++) {
      for (let c = old.c1; c <= old.c2; c++) {
        if (r > range.r2 || c > range.c2) cells.push([r, c, null]);
      }
    }
  }

  ops.push({ type: 'setCells', sheetId, cells });
  ops.push({ type: 'formatRanges', sheetId, ranges: [{ r1: top, c1: left, r2: top, c2: range.c2 }], patch: { bold: true } satisfies StylePatch });
  (write.formats ?? []).forEach((numFmt, j) => {
    if (!numFmt || write.rows.length === 0 || j >= width) return;
    ops.push({ type: 'formatRanges', sheetId, ranges: [{ r1: top + 1, c1: left + j, r2: range.r2, c2: left + j }], patch: { numFmt } });
  });
  const filter = fresh ? { range, columns: [] } : followingFilter(sheet!.filter, placed?.range, range);
  if (filter) ops.push({ type: 'setFilter', sheetId, filter });
  ops.push({ type: 'patchDataTables', sheetId, set: [{ id: write.id, range }] });
  return { type: 'batch', ops };
}

/** A filter on the old block's header row, moved to the new block (columns past its width dropped); null when there is none. */
function followingFilter(filter: SheetFilter | null, old: Range | undefined, range: Range): SheetFilter | null {
  if (!filter || !old || filter.range.r1 !== old.r1 || filter.range.c1 !== old.c1 || filter.range.c2 !== old.c2) return null;
  if (filter.range.r2 === range.r2 && filter.range.c2 === range.c2) return null;
  return { range: { ...range }, columns: filter.columns.filter((c) => c.col <= range.c2) };
}

/** The name of a connected table's own tab: `base` without the characters a tab name cannot hold, numbered when taken. */
function tableSheetName(engine: Engine, base: string): string {
  const name = base.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 90) || 'Table';
  const taken = (n: string) => !!engine.workbook.getSheetByName(n);
  if (!taken(name)) return name;
  for (let i = 2; ; i++) if (!taken(`${name} ${i}`)) return `${name} ${i}`;
}

/** Where a connected table is: its sheet and the block it last filled. */
export function findDataTable(engine: Engine, id: string): { sheetId: string; range: Range } | null {
  for (const sheet of engine.workbook.sheets) {
    const table = sheet.dataTables.find((t) => t.id === id);
    if (table) return { sheetId: sheet.id, range: { ...table.range } };
  }
  return null;
}

/** A value to write: a number, text, a boolean, a formula (text starting with '='), or null to clear. */
export type CellInput = string | number | boolean | null;

/**
 * The op that writes `values` from `start` down and right. Text starting
 * with '=' is a formula in canonical syntax (English function names, ','
 * between arguments, '.' decimals).
 */
export function valuesOp(sheetId: string, start: { row: number; col: number }, values: CellInput[][]): Op {
  const cells: CellPatch[] = [];
  values.forEach((row, i) => {
    row.forEach((v, j) => {
      const at: [number, number] = [start.row + i, start.col + j];
      if (v === null || v === '') cells.push([...at, null]);
      else if (typeof v === 'string' && v.startsWith('=') && v.length > 1) cells.push([...at, { v: null, f: v.slice(1) }]);
      else cells.push([...at, { v }]);
    });
  });
  return { type: 'setCells', sheetId, cells };
}

export interface ReadValues {
  /** The range read, cut to `maxCells` (whole rows). */
  range: Range;
  /** Displayed values, row by row; errors as their code (`#DIV/0!`). */
  values: (string | number | boolean | null)[][];
  /** Formulas (with '='), where the cell has one. */
  formulas: (string | null)[][];
  /** Rows were left out to stay under `maxCells`. */
  truncated: boolean;
}

/** The values (and formulas) of `range` on a sheet, at most `maxCells` of them. */
export function readValues(engine: Engine, sheetId: string, range: Range, maxCells: number): ReadValues {
  const width = range.c2 - range.c1 + 1;
  const maxRows = Math.max(1, Math.floor(maxCells / Math.max(1, width)));
  const r2 = Math.min(range.r2, range.r1 + maxRows - 1);
  const values: ReadValues['values'] = [];
  const formulas: ReadValues['formulas'] = [];
  for (let r = range.r1; r <= r2; r++) {
    const row: ReadValues['values'][number] = [];
    const frow: ReadValues['formulas'][number] = [];
    for (let c = range.c1; c <= range.c2; c++) {
      row.push(plain(engine.getValue(sheetId, r, c)));
      const f = engine.cellFormula(sheetId, r, c);
      frow.push(f === undefined ? null : `=${f}`);
    }
    values.push(row);
    formulas.push(frow);
  }
  return { range: { ...range, r2 }, values, formulas, truncated: r2 < range.r2 };
}

function plain(v: Scalar): string | number | boolean | null {
  return isError(v) ? v.code : v;
}
