/**
 * Workbook and sheet model, plus its JSON snapshot form.
 *
 * The model is passive: it stores what ops tell it to. Formula evaluation
 * and reference rewriting live in the Engine, which owns a Workbook.
 */

import type { Range } from '../address';
import { AxisDims, type AxisSnapshot } from './axis';
import { CellStore, type Cell } from './cell-store';
import { StyleTable, type CellStyle } from './styles';

export const DEFAULT_ROW_HEIGHT = 21;
export const DEFAULT_COL_WIDTH = 100;
export const DEFAULT_ROW_COUNT = 1000;
export const DEFAULT_COL_COUNT = 26;

export interface SheetProps {
  tabColor?: string;
  hidden?: boolean;
  /** Gridlines shown (default true). */
  gridlines?: boolean;
  rtl?: boolean;
}

export class Sheet {
  readonly cells = new CellStore();
  rows = new AxisDims(DEFAULT_ROW_HEIGHT);
  cols = new AxisDims(DEFAULT_COL_WIDTH);
  /** Visible grid extent; grows as data or ops need it. */
  rowCount = DEFAULT_ROW_COUNT;
  colCount = DEFAULT_COL_COUNT;
  merges: Range[] = [];
  freeze = { rows: 0, cols: 0 };
  props: SheetProps = {};

  constructor(
    readonly id: string,
    public name: string,
  ) {}

  /** The merge that covers (row, col), if any. */
  mergeAt(row: number, col: number): Range | undefined {
    return this.merges.find((m) => row >= m.r1 && row <= m.r2 && col >= m.c1 && col <= m.c2);
  }

  /** Effective style key: the cell's own, else its row's, else its column's. */
  styleKeyAt(row: number, col: number): string | undefined {
    return this.cells.get(row, col)?.s ?? this.rows.styles.get(row) ?? this.cols.styles.get(col);
  }
}

export interface DefinedName {
  name: string;
  /** Formula text without '=', usually a reference like Sheet1!$A$1:$A$10. */
  formula: string;
  /** Scope sheet id; omitted for workbook scope. */
  sheetId?: string;
}

export class Workbook {
  sheets: Sheet[] = [];
  readonly styles = new StyleTable();
  names: DefinedName[] = [];

  getSheet(id: string): Sheet | undefined {
    return this.sheets.find((s) => s.id === id);
  }

  getSheetByName(name: string): Sheet | undefined {
    const lower = name.toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === lower);
  }

  requireSheet(id: string): Sheet {
    const sheet = this.getSheet(id);
    if (!sheet) throw new Error(`Unknown sheet ${id}`);
    return sheet;
  }

  style(sheet: Sheet, row: number, col: number): CellStyle | undefined {
    return this.styles.get(sheet.styleKeyAt(row, col));
  }

  toJSON(): WorkbookSnapshot {
    return {
      version: 1,
      sheets: this.sheets.map(sheetToJSON),
      names: this.names.length ? this.names.map((n) => ({ ...n })) : undefined,
    };
  }

  static fromJSON(snap: WorkbookSnapshot): Workbook {
    const wb = new Workbook();
    for (const s of snap.sheets) wb.sheets.push(sheetFromJSON(s));
    wb.names = (snap.names ?? []).map((n) => ({ ...n }));
    return wb;
  }
}

export function sheetToJSON(s: Sheet): SheetSnapshot {
  const cells: SheetSnapshot['cells'] = [];
  s.cells.forEach((row, col, cell) => cells.push([row, col, { ...cell }]));
  cells.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const snap: SheetSnapshot = {
    id: s.id,
    name: s.name,
    rowCount: s.rowCount,
    colCount: s.colCount,
    rows: s.rows.toJSON(),
    cols: s.cols.toJSON(),
    cells,
  };
  if (s.merges.length) snap.merges = s.merges.map((m) => ({ ...m })).sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1);
  if (s.freeze.rows || s.freeze.cols) snap.freeze = { ...s.freeze };
  if (Object.keys(s.props).length) snap.props = { ...s.props };
  return snap;
}

export function sheetFromJSON(s: SheetSnapshot): Sheet {
  const sheet = new Sheet(s.id, s.name);
  sheet.rowCount = s.rowCount;
  sheet.colCount = s.colCount;
  sheet.rows = AxisDims.fromJSON(s.rows);
  sheet.cols = AxisDims.fromJSON(s.cols);
  for (const [row, col, cell] of s.cells) sheet.cells.set(row, col, { ...cell });
  sheet.merges = (s.merges ?? []).map((m) => ({ ...m }));
  sheet.freeze = s.freeze ? { ...s.freeze } : { rows: 0, cols: 0 };
  sheet.props = { ...(s.props ?? {}) };
  return sheet;
}

export interface SheetSnapshot {
  id: string;
  name: string;
  rowCount: number;
  colCount: number;
  rows: AxisSnapshot;
  cols: AxisSnapshot;
  /** [row, col, cell], sorted row-major. */
  cells: [number, number, Cell][];
  merges?: Range[];
  freeze?: { rows: number; cols: number };
  props?: SheetProps;
}

export interface WorkbookSnapshot {
  version: 1;
  sheets: SheetSnapshot[];
  names?: DefinedName[];
}
