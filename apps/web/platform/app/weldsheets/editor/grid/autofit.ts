import { DEFAULT_ROW_HEIGHT, type CellStyle } from '@weldsuite/sheets-engine';
import type { SheetController } from '../model/sheet-controller';
import { measureText, wrapLines } from './renderer';

/** Text width in a cell's font. */
export type Measure = (text: string, style: CellStyle | undefined) => number;

/** Cells read per row or column; past that a fit goes by what it has seen. */
const SCAN_LIMIT = 50_000;
const PADDING = 4;
/** Room for a filter button or a dropdown arrow drawn in the cell. */
const CONTROL_WIDTH = 18;
const MAX_WIDTH = 1000;
const MAX_HEIGHT = 400;

/**
 * Sizes columns or rows to what they hold (a double-click on a header
 * border, "Fit to data"): a column to its widest value that does not wrap, a
 * row to its tallest text. One with nothing to fit goes back to the default
 * size. Hidden rows, merged and wrapped cells (for widths) are left out.
 */
export function fitToData(ctl: SheetController, axis: 'row' | 'col', indices: number[], measure: Measure = measureText): void {
  if (ctl.readOnly || indices.length === 0) return;
  const entries: [number, number | null][] = indices.map((i) => [i, axis === 'col' ? fittedWidth(ctl, i, measure) : fittedHeight(ctl, i, measure)]);
  ctl.apply({ type: 'resizeDims', sheetId: ctl.activeSheetId, axis, entries });
}

/** The width a column's values need, or null (the default) when it has none. */
export function fittedWidth(ctl: SheetController, col: number, measure: Measure): number | null {
  const sheet = ctl.sheet;
  const filter = sheet.filter;
  let widest = 0;
  let seen = 0;
  ctl.engine.forEachValue(ctl.activeSheetId, { r1: 0, c1: col, r2: sheet.rowCount - 1, c2: col }, (row) => {
    if (++seen > SCAN_LIMIT || sheet.rows.isHidden(row)) return;
    const merge = sheet.mergeAt(row, col);
    if (merge && (merge.c1 !== merge.c2 || merge.r1 !== row)) return;
    const style = ctl.cellStyle(row, col);
    if (style?.wrap === 'wrap') return;
    const text = ctl.displayText(row, col).text;
    let width = Math.max(...text.split('\n').map((line) => measure(line, style))) + PADDING * 2 + 2;
    const rule = ctl.validationAt(row, col);
    if (rule?.dropdown || (filter && row === filter.range.r1 && col >= filter.range.c1 && col <= filter.range.c2)) width += CONTROL_WIDTH;
    widest = Math.max(widest, width);
  });
  if (widest === 0) return null;
  return Math.min(MAX_WIDTH, Math.max(20, Math.ceil(widest)));
}

/** The height a row's text needs (wrapped text over its column's width), or null when it fits the default. */
export function fittedHeight(ctl: SheetController, row: number, measure: Measure): number | null {
  const sheet = ctl.sheet;
  let tallest = 0;
  let seen = 0;
  ctl.engine.forEachValue(ctl.activeSheetId, { r1: row, c1: 0, r2: row, c2: sheet.colCount - 1 }, (_row, col) => {
    if (++seen > SCAN_LIMIT || sheet.cols.isHidden(col)) return;
    const merge = sheet.mergeAt(row, col);
    if (merge && (merge.r1 !== merge.r2 || merge.c1 !== col)) return;
    const style = ctl.cellStyle(row, col);
    const text = ctl.displayText(row, col).text;
    const px = ((style?.fontSize ?? 10) * 4) / 3;
    const width = sheet.cols.sizeOf(col) - PADDING * 2;
    const measurer = { measureText: (t: string) => ({ width: measure(t, style) }) };
    const lines = style?.wrap === 'wrap' ? wrapLines(measurer, text, width).length : text.split('\n').length;
    tallest = Math.max(tallest, lines * px * 1.25 + PADDING);
  });
  const height = Math.ceil(tallest);
  return height <= DEFAULT_ROW_HEIGHT ? null : Math.min(MAX_HEIGHT, height);
}
