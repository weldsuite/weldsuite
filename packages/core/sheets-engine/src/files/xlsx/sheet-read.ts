/**
 * One worksheet part into a SheetSnapshot. The cells (`sheetData`, nearly
 * all of a large sheet) are streamed; the rest of the part is small and is
 * read as a tree once the cells are known (the filter needs their values).
 */

import { MAX_COLS, MAX_ROWS, cellKey, parseA1, parseRange, rangeContains, type Range } from '../../address';
import type { FormatLocale } from '../../format/number-format';
import { translateFormula } from '../../formula/references';
import type { Cell } from '../../model/cell-store';
import type { CellStyle } from '../../model/styles';
import { DEFAULT_COL_COUNT, DEFAULT_ROW_COUNT, type SheetProps, type SheetSnapshot } from '../../model/workbook';
import type { AxisSnapshot } from '../../model/axis';
import { err, isErrorCode, type Scalar } from '../../values';
import { ImportError, type ImportWarning } from '../types';
import { child, childrenOf, decodeEscapes, parseXml, scanXml, type XmlAttrs, type XmlElement } from '../xml';
import { resolveColor } from './colors';
import { pointsToPx, widthToPx } from './conditions';
import { fromExcelFormula } from './formulas';
import { readConditionalFormats, readFilter, readValidations, type RulesContext } from './rules-read';
import type { StyleSheet } from './styles';

/** Days between 1899-12-30 (serial 0 in the 1900 system, past its fake leap day) and 1970-01-01. */
const UNIX_EPOCH_SERIAL = 25569;
/** The 1904 date system counts from 1904-01-01. */
const DATE_1904_OFFSET = 1462;

export interface SheetContext {
  id: string;
  name: string;
  styles: StyleSheet;
  /** Style key of each `cellXfs` entry. */
  xfKeys: (string | undefined)[];
  /** Whether each `cellXfs` entry shows a date (for 1904-system files). */
  dateXfs: boolean[];
  sharedStrings: string[];
  theme: string[];
  locale: FormatLocale;
  date1904: boolean;
  warnings: Set<ImportWarning>;
  /** Cells the workbook may still take. */
  budget: { cells: number };
}

export function readWorksheet(xml: string, ctx: SheetContext): SheetSnapshot {
  const { head, data } = splitSheetData(xml);
  const root = parseXml(head);
  const defaultRowPt = Number(child(root, 'sheetFormatPr')?.attrs.defaultRowHeight) || 15;
  const cells = new CellReader(ctx, defaultRowPt);
  if (data) cells.read(data);
  cells.clearArrayFollowers();
  return buildSheet(root, cells, ctx);
}

/** The worksheet without its `sheetData`, and the `sheetData` content. */
function splitSheetData(xml: string): { head: string; data: string | null } {
  const open = /<(?:[\w.-]+:)?sheetData\b[^>]*>/.exec(xml);
  if (!open) return { head: xml, data: null };
  const after = open.index + open[0].length;
  if (open[0].endsWith('/>')) return { head: xml.slice(0, open.index) + xml.slice(after), data: null };
  const close = /<\/(?:[\w.-]+:)?sheetData\s*>/g;
  close.lastIndex = after;
  const end = close.exec(xml);
  if (!end) throw new ImportError('A worksheet is cut short', 'corrupt');
  return { head: xml.slice(0, open.index) + xml.slice(end.index + end[0].length), data: xml.slice(after, end.index) };
}

interface PendingCell {
  row: number;
  col: number;
  type: string | undefined;
  xf: number;
  value: string | null;
  formula: string | null;
  formulaAttrs: XmlAttrs;
  inline: string | null;
}

/** Streams `sheetData`: rows, then cells with their values, formulas and styles. */
class CellReader {
  readonly cells = new Map<number, Cell>();
  readonly rowSizes = new Map<number, number>();
  readonly rowHidden = new Set<number>();
  readonly rowStyles = new Map<number, string>();
  lastRow = -1;
  lastCol = -1;
  private readonly shared = new Map<string, { formula: string; row: number; col: number }>();
  private readonly arrays: { range: Range; row: number; col: number }[] = [];
  private row = -1;
  private col = -1;
  private cell: PendingCell | null = null;
  private target: 'v' | 'f' | 't' | null = null;
  private phonetic = 0;

  constructor(
    private readonly ctx: SheetContext,
    private readonly defaultRowPt: number,
  ) {}

  read(xml: string): void {
    scanXml(xml, {
      open: (name, a) => this.open(name, a),
      close: (name) => this.close(name),
      text: (t) => this.text(t),
    });
  }

  private open(name: string, a: XmlAttrs): void {
    if (name === 'row') this.openRow(a);
    else if (name === 'c') this.openCell(a);
    else if (name === 'rPh') this.phonetic++;
    else if (this.cell) this.openInCell(name, a, this.cell);
  }

  /** A tag inside a cell: its value, formula, or inline string (and that string's runs). */
  private openInCell(name: string, a: XmlAttrs, cell: PendingCell): void {
    switch (name) {
      case 'v':
        this.target = 'v';
        break;
      case 'f':
        cell.formula = '';
        cell.formulaAttrs = a;
        this.target = 'f';
        break;
      case 'is':
        cell.inline = '';
        break;
      case 'r':
        if (cell.inline !== null) this.ctx.warnings.add('richText');
        break;
      case 't':
        if (cell.inline !== null && this.phonetic === 0) this.target = 't';
        break;
      default:
    }
  }

  private close(name: string): void {
    if (name === 'c') {
      if (this.cell) this.finish(this.cell);
      this.cell = null;
    } else if (name === 'rPh') {
      this.phonetic--;
    }
    if (name === 'v' || name === 'f' || name === 't') this.target = null;
  }

  private text(t: string): void {
    const cell = this.cell;
    if (!cell || !this.target) return;
    if (this.target === 'v') cell.value = (cell.value ?? '') + t;
    else if (this.target === 'f') cell.formula = (cell.formula ?? '') + t;
    else cell.inline = (cell.inline ?? '') + t;
  }

  private openRow(a: XmlAttrs): void {
    this.row = a.r ? Number(a.r) - 1 : this.row + 1;
    this.col = -1;
    const row = this.row;
    if (!(row >= 0 && row < MAX_ROWS)) throw new ImportError('A row number is out of range', 'corrupt');
    const pt = Number(a.ht);
    if (pt > 0 && (isOn(a.customHeight) || Math.abs(pt - this.defaultRowPt) > 1)) {
      this.rowSizes.set(row, pointsToPx(pt));
      this.lastRow = Math.max(this.lastRow, row);
    }
    if (isOn(a.hidden)) {
      this.rowHidden.add(row);
      this.lastRow = Math.max(this.lastRow, row);
    }
    const style = isOn(a.customFormat) && a.s ? this.ctx.xfKeys[Number(a.s)] : undefined;
    if (style) this.rowStyles.set(row, style);
  }

  private openCell(a: XmlAttrs): void {
    const at = a.r ? parseA1(a.r) : { row: this.row, col: this.col + 1 };
    if (!at || at.row < 0 || at.col < 0 || at.col >= MAX_COLS) {
      this.cell = null;
      return;
    }
    this.row = at.row;
    this.col = at.col;
    this.cell = { row: at.row, col: at.col, type: a.t, xf: Number(a.s ?? 0) || 0, value: null, formula: null, formulaAttrs: {}, inline: null };
  }

  private finish(c: PendingCell): void {
    const formula = c.formula === null ? null : this.formulaOf(c);
    const value = this.valueOf(c);
    const style = this.ctx.xfKeys[c.xf];
    if (value === null && formula === null && style === undefined) return;
    if (--this.ctx.budget.cells < 0) throw new ImportError('The workbook has more cells than WeldSheets can open yet', 'too_large');
    const cell: Cell = { v: value };
    if (formula !== null) cell.f = formula;
    if (style !== undefined) cell.s = style;
    this.cells.set(cellKey(c.row, c.col), cell);
    this.lastRow = Math.max(this.lastRow, c.row);
    this.lastCol = Math.max(this.lastCol, c.col);
  }

  private valueOf(c: PendingCell): Scalar {
    if (c.type === 'inlineStr') return c.inline === null ? null : decodeEscapes(c.inline);
    const v = c.value?.trim();
    if (v === undefined || v === '') return c.type === 'str' && c.value !== null ? c.value : null;
    switch (c.type) {
      case 's':
        return this.ctx.sharedStrings[Number(v)] ?? '';
      case 'str':
        return decodeEscapes(c.value ?? '');
      case 'b':
        return v === '1' || v.toLowerCase() === 'true';
      case 'e':
        return errorValue(v);
      case 'd':
        return isoToSerial(v);
      default: {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        return this.ctx.date1904 && this.ctx.dateXfs[c.xf] ? n + DATE_1904_OFFSET : n;
      }
    }
  }

  /** The cell's formula as WeldSheets text; null for none, and (with a warning) for one it cannot read. */
  private formulaOf(c: PendingCell): string | null {
    const a = c.formulaAttrs;
    if (a.t === 'dataTable') return null;
    let text = c.formula ?? '';
    if (a.t === 'shared' && a.si !== undefined) {
      if (text.trim()) {
        this.shared.set(a.si, { formula: text, row: c.row, col: c.col });
      } else {
        const master = this.shared.get(a.si);
        if (!master) return null;
        text = this.translate(master.formula, c.row - master.row, c.col - master.col);
      }
    }
    if (a.t === 'array' && a.ref) {
      const range = parseRange(a.ref);
      if (range) this.arrays.push({ range, row: c.row, col: c.col });
    }
    if (!text.trim()) return null;
    const formula = fromExcelFormula(text);
    if (formula === null) this.ctx.warnings.add('formulas');
    return formula;
  }

  private translate(formula: string, dRow: number, dCol: number): string {
    try {
      return translateFormula(formula, dRow, dCol);
    } catch {
      return '';
    }
  }

  /**
   * An array formula is written once, in its top-left cell; the file repeats
   * its results in the cells it fills. WeldSheets spills those itself, so the
   * copies go (a cell's own style stays).
   */
  clearArrayFollowers(): void {
    for (const { range, row, col } of this.arrays) {
      const master = cellKey(row, col);
      for (const key of this.keysIn(range)) {
        const cell = this.cells.get(key);
        if (key === master || !cell || cell.f !== undefined) continue;
        if (cell.s === undefined) this.cells.delete(key);
        else this.cells.set(key, { v: null, s: cell.s });
      }
    }
  }

  /** Keys of the stored cells in `range`, walking whichever is smaller: the range or the cells. */
  private keysIn(range: Range): number[] {
    const area = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    if (area > this.cells.size) {
      return [...this.cells.keys()].filter((key) => rangeContains(range, Math.floor(key / MAX_COLS), key % MAX_COLS));
    }
    const keys: number[] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) keys.push(cellKey(r, c));
    }
    return keys;
  }
}

function isOn(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

function errorValue(code: string): Scalar {
  return isErrorCode(code) ? err(code) : err('#VALUE!');
}

/** An ISO 8601 date-time (`t="d"` cells) as a date serial. */
function isoToSerial(text: string): Scalar {
  // A time without a zone is taken as written: read it as UTC.
  const zoned = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(text) || !text.includes('T');
  const ms = Date.parse(zoned ? text : `${text}Z`);
  return Number.isFinite(ms) ? ms / 86_400_000 + UNIX_EPOCH_SERIAL : null;
}

// ---------------------------------------------------------------------------
// Everything around the cells
// ---------------------------------------------------------------------------

function buildSheet(root: XmlElement, cells: CellReader, ctx: SheetContext): SheetSnapshot {
  const styleByKey = new Map<string, CellStyle>();
  ctx.xfKeys.forEach((key, i) => key && styleByKey.set(key, ctx.styles.xfs[i]!));
  const rulesCtx: RulesContext = {
    styles: ctx.styles,
    theme: ctx.theme,
    locale: ctx.locale,
    warnings: ctx.warnings,
    lastRow: cells.lastRow,
    cellAt: (row, col) => {
      const cell = cells.cells.get(cellKey(row, col));
      return cell ? { cell, style: cell.s ? styleByKey.get(cell.s) : undefined } : undefined;
    },
  };
  const merges = childrenOf(child(root, 'mergeCells'), 'mergeCell')
    .map((m) => parseRange(m.attrs.ref ?? ''))
    .filter((r): r is Range => r !== null && (r.r1 !== r.r2 || r.c1 !== r.c2));
  const filter = readFilter(root, rulesCtx);

  let lastRow = cells.lastRow;
  let lastCol = cells.lastCol;
  for (const m of merges) {
    lastRow = Math.max(lastRow, m.r2);
    lastCol = Math.max(lastCol, m.c2);
  }
  const rowCount = Math.min(MAX_ROWS, Math.max(DEFAULT_ROW_COUNT, lastRow + 1));
  const colCount = Math.min(MAX_COLS, Math.max(DEFAULT_COL_COUNT, lastCol + 1));

  // Rows the filter hides are saved hidden; WeldSheets works them out again from the filter.
  const filterBody = filter?.columns.length ? { ...filter.range, r1: filter.range.r1 + 1 } : null;
  const rows: AxisSnapshot = axis(defaultRowSize(root), cells.rowSizes, cells.rowHidden, cells.rowStyles, rowCount, (i) => !!filterBody && i >= filterBody.r1 && i <= filterBody.r2);
  const cols = columns(root, colCount, ctx);

  const snap: SheetSnapshot = {
    id: ctx.id,
    name: ctx.name,
    rowCount,
    colCount,
    rows,
    cols,
    cells: [...cells.cells].sort((a, b) => a[0] - b[0]).map(([key, cell]) => [Math.floor(key / MAX_COLS), key % MAX_COLS, cell]),
  };
  if (merges.length) snap.merges = merges;
  const freeze = freezeOf(root);
  if (freeze) snap.freeze = freeze;
  const props = propsOf(root, ctx);
  if (Object.keys(props).length) snap.props = props;
  if (filter) snap.filter = filter;
  const formats = readConditionalFormats(root, rulesCtx);
  if (formats.length) snap.conditionalFormats = formats;
  const validations = readValidations(root, rulesCtx);
  if (validations.length) snap.validations = validations;
  noteParts(root, ctx);
  return snap;
}

function axis(
  defaultSize: number,
  sizes: Map<number, number>,
  hidden: Set<number>,
  styles: Map<number, string>,
  count: number,
  filtered: (i: number) => boolean,
): AxisSnapshot {
  const snap: AxisSnapshot = { defaultSize };
  const sized = [...sizes].filter(([i, px]) => i < count && px !== defaultSize).sort((a, b) => a[0] - b[0]);
  if (sized.length) snap.sizes = sized;
  const shut = [...hidden].filter((i) => i < count && !filtered(i)).sort((a, b) => a - b);
  if (shut.length) snap.hidden = shut;
  const styled = [...styles].filter(([i]) => i < count).sort((a, b) => a[0] - b[0]);
  if (styled.length) snap.styles = styled;
  return snap;
}

function defaultRowSize(root: XmlElement): number {
  const pt = Number(child(root, 'sheetFormatPr')?.attrs.defaultRowHeight);
  return pt > 0 ? pointsToPx(pt) : 20;
}

function columns(root: XmlElement, count: number, ctx: SheetContext): AxisSnapshot {
  const format = child(root, 'sheetFormatPr')?.attrs;
  const defaultWidth = Number(format?.defaultColWidth);
  const base = Number(format?.baseColWidth) || 8;
  // Without a stored default, Excel's columns are baseColWidth digits plus padding, rounded up to 8 pixels.
  const defaultSize = defaultWidth > 0 ? widthToPx(defaultWidth) : Math.ceil((base * 7 + 5) / 8) * 8;
  const out = { sizes: new Map<number, number>(), hidden: new Set<number>(), styles: new Map<number, string>() };
  for (const col of childrenOf(child(root, 'cols'), 'col')) readCol(col.attrs, count, ctx, out);
  return axis(defaultSize, out.sizes, out.hidden, out.styles, count, () => false);
}

/** One `col` run (1-based min..max) into per-column sizes, hidden flags and styles, up to `count` columns. */
function readCol(a: XmlAttrs, count: number, ctx: SheetContext, out: { sizes: Map<number, number>; hidden: Set<number>; styles: Map<number, string> }): void {
  const from = Number(a.min) - 1;
  const to = Math.min(Number(a.max) - 1, count - 1);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return;
  const width = Number(a.width);
  const px = width > 0 ? widthToPx(width) : undefined;
  const hidden = isOn(a.hidden);
  const style = a.style ? ctx.xfKeys[Number(a.style)] : undefined;
  for (let i = from; i <= to; i++) {
    if (px !== undefined) out.sizes.set(i, px);
    if (hidden) out.hidden.add(i);
    if (style) out.styles.set(i, style);
  }
}

function freezeOf(root: XmlElement): { rows: number; cols: number } | null {
  const pane = child(child(child(root, 'sheetViews'), 'sheetView'), 'pane');
  if (!pane || (pane.attrs.state !== 'frozen' && pane.attrs.state !== 'frozenSplit')) return null;
  const rows = Math.trunc(Number(pane.attrs.ySplit) || 0);
  const cols = Math.trunc(Number(pane.attrs.xSplit) || 0);
  return rows > 0 || cols > 0 ? { rows: Math.max(0, rows), cols: Math.max(0, cols) } : null;
}

function propsOf(root: XmlElement, ctx: SheetContext): SheetProps {
  const props: SheetProps = {};
  const tab = resolveColor(child(child(root, 'sheetPr'), 'tabColor'), ctx.theme);
  if (tab) props.tabColor = tab;
  const view = child(child(root, 'sheetViews'), 'sheetView')?.attrs;
  if (view?.showGridLines === '0' || view?.showGridLines === 'false') props.gridlines = false;
  if (isOn(view?.rightToLeft)) props.rtl = true;
  return props;
}

/** Parts of the sheet WeldSheets leaves out, for the warnings. */
function noteParts(root: XmlElement, ctx: SheetContext): void {
  if (child(root, 'drawing')) ctx.warnings.add('drawings');
  if (child(root, 'tableParts')) ctx.warnings.add('tables');
}
