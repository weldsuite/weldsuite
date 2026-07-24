// Shared types for spreadsheet components

export interface CellCoord {
  col: number;
  row: number;
}

export interface SelectionRange {
  start: CellCoord;
  end: CellCoord;
}

export interface NormalizedRange {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}

export type CellValue = string | number | boolean | null;

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  textColor?: string;
  fillColor?: string;
  fontFamily?: string;
  fontSize?: number;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  numberFormat?: 'general' | 'number' | 'currency' | 'percent' | 'date' | 'time' | 'scientific' | 'auto' | 'text';
  decimalPlaces?: number;
  currencySymbol?: string;
  border?: 'all' | 'inner' | 'outer' | 'top' | 'bottom' | 'left' | 'right' | 'none';
  merge?: boolean;
  textWrap?: 'overflow' | 'wrap' | 'clip';
  textRotation?: number;
}

export interface RichTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  textColor?: string;
  fontFamily?: string;
  fontSize?: number;
}

export type RichTextValue = RichTextRun[];

// Row `data` is a heterogeneous JSON blob: plain cell values under column ids,
// plus `CellFormat` / `RichTextValue` / string payloads under the special
// `__fmt__` / richtext / `__note__` / `__link__` prefixed keys (see cell-format.ts).
export type CellDataValue = CellValue | CellFormat | RichTextValue;

export interface Command {
  type: string;
  execute: () => Promise<void>;
  undo: () => Promise<void>;
}

export interface ClipboardData {
  cells: Array<{
    relCol: number;
    relRow: number;
    value: string;
    format?: CellFormat;
  }>;
  width: number;
  height: number;
  text: string;
}

export function normRange(r: SelectionRange): NormalizedRange {
  return {
    minCol: Math.min(r.start.col, r.end.col),
    maxCol: Math.max(r.start.col, r.end.col),
    minRow: Math.min(r.start.row, r.end.row),
    maxRow: Math.max(r.start.row, r.end.row),
  };
}

export function colLabel(index: number): string {
  let result = '';
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

export function colIndex(label: string): number {
  let result = 0;
  for (let i = 0; i < label.length; i++) {
    result = result * 26 + (label.charCodeAt(i) - 64);
  }
  return result - 1;
}
