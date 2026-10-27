/**
 * Workbook and sheet model, plus its JSON snapshot form.
 *
 * The model is passive: it stores what ops tell it to. Formula evaluation
 * and reference rewriting live in the Engine, which owns a Workbook.
 */

import type { Range } from '../address';
import type { Scalar } from '../values';
import { AxisDims, type AxisSnapshot } from './axis';
import { CellStore, type Cell } from './cell-store';
import { StyleTable, type CellStyle } from './styles';
import {
  cloneFilter,
  cloneFormat,
  cloneValidation,
  sortFormats,
  type ConditionalFormat,
  type DataValidation,
  type SheetFilter,
} from './rules';
import { cloneComment, cloneDataTable, isCommentEntry, type DataTable, type SheetComment } from './anchors';
import { cloneChart, type Chart } from './charts';

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
  /** The basic filter; rows it hides are derived (`rows.isFiltered`), not stored. */
  filter: SheetFilter | null = null;
  conditionalFormats: ConditionalFormat[] = [];
  validations: DataValidation[] = [];
  /** In drawing order: a later chart is drawn over an earlier one. */
  charts: Chart[] = [];
  /** Comment threads: where each is and whether it is resolved (the discussion is in WeldChat). */
  comments: SheetComment[] = [];
  /** The blocks connected tables of WeldSuite data last filled. */
  dataTables: DataTable[] = [];

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
  if (s.filter) snap.filter = cloneFilter(s.filter);
  if (s.conditionalFormats.length) snap.conditionalFormats = sortFormats(s.conditionalFormats).map(cloneFormat);
  if (s.validations.length) snap.validations = s.validations.map(cloneValidation);
  if (s.charts.length) snap.charts = s.charts.map(cloneChart);
  if (s.comments.length) snap.comments = [...s.comments].sort((a, b) => a.id.localeCompare(b.id)).map(cloneComment);
  if (s.dataTables.length) snap.dataTables = [...s.dataTables].sort((a, b) => a.id.localeCompare(b.id)).map(cloneDataTable);
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
  sheet.filter = s.filter ? cloneFilter(s.filter) : null;
  sheet.conditionalFormats = (s.conditionalFormats ?? []).map(cloneFormat);
  sheet.validations = (s.validations ?? []).map(cloneValidation);
  sheet.charts = (s.charts ?? []).map(cloneChart);
  sheet.comments = (s.comments ?? []).filter(isCommentEntry).map(cloneComment);
  sheet.dataTables = (s.dataTables ?? []).map(cloneDataTable);
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
  filter?: SheetFilter;
  conditionalFormats?: ConditionalFormat[];
  validations?: DataValidation[];
  charts?: Chart[];
  comments?: SheetComment[];
  dataTables?: DataTable[];
  /**
   * The arrays the sheet's formulas spill, as [row, col, values] of each
   * formula that spills: written with `calculated`, so a load need not
   * evaluate every formula to put them back.
   */
  spills?: [number, number, Scalar[][]][];
}

export interface WorkbookSnapshot {
  version: 1;
  sheets: SheetSnapshot[];
  names?: DefinedName[];
  /**
   * Every formula's stored value is its current result and `spills` holds
   * every spilled array (the engine wrote it with no calculation pending).
   * Loading it evaluates only volatile formulas; without it, every formula.
   */
  calculated?: true;
}
