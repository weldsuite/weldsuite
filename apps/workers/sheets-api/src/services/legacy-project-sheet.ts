/**
 * WeldFlow project sheets from before WeldSheets, converted to workbooks.
 *
 * The old project grid saved an .xlsx whose real content was a JSON model in
 * cell A1 of a hidden `_weldsuite` worksheet (the visible worksheets were a
 * plain copy without formats or formulas, never read back). This reads that
 * model and makes the same tabs as a WeldSheets workbook:
 *
 *   - each old sheet is a tab, its column names a bold, frozen first row and
 *     its rows below (old formulas, which counted rows from the first data
 *     row, move down with them: they are written first, then the header row
 *     is inserted above, so the engine rewrites their references);
 *   - cell formats (bold, italic, strikethrough, colours, font, alignment,
 *     wrapping, borders, number formats), column widths;
 *   - a dropdown column becomes a list rule over its cells;
 *   - a cell link becomes a HYPERLINK formula, rich text its plain text, and
 *     a cell note a comment thread by the file's owner.
 *
 * Text rotation and merged cells of the old grid are not kept.
 */

import {
  EN_LOCALE,
  Engine,
  Sheet,
  Workbook,
  applyOp,
  readSpreadsheet,
  type BorderSide,
  type CellPatch,
  type CellStyle,
  type DataValidation,
  type Scalar,
  type SheetComment,
  type WorkbookSnapshot,
} from '@weldsuite/sheets-engine';

export const META_SHEET = '_weldsuite';

/** The old model, as the project grid saved it (`use-spreadsheet.ts`). */
export interface LegacyModel {
  sheets: { id: string; name: string; position: number }[];
  columnsBySheet: Record<string, { id: string; name: string; fieldType?: string; position: number; width?: number | null; options?: string[] | null }[]>;
  rowsBySheet: Record<string, { id: string; position: number; data?: Record<string, unknown> }[]>;
}

interface LegacyFormat {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  textColor?: string;
  fillColor?: string;
  fontFamily?: string;
  fontSize?: number;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  numberFormat?: string;
  decimalPlaces?: number;
  currencySymbol?: string;
  border?: string;
  textWrap?: 'overflow' | 'wrap' | 'clip';
}

/** The model inside an old project sheet file, or null when the file has none (never saved, or not one of these). */
export async function readLegacyModel(fileName: string, bytes: Uint8Array): Promise<LegacyModel | null> {
  const { workbook } = await readSpreadsheet(fileName, bytes, { locale: EN_LOCALE, maxCells: 1_000_000 });
  const meta = workbook.sheets.find((s) => s.name === META_SHEET);
  const cell = meta?.cells.find(([r, c]) => r === 0 && c === 0)?.[2];
  if (typeof cell?.v !== 'string') return null;
  try {
    const parsed = JSON.parse(cell.v) as { model?: LegacyModel };
    return isModel(parsed.model) ? parsed.model : null;
  } catch {
    return null;
  }
}

function isModel(m: unknown): m is LegacyModel {
  const model = m as LegacyModel | undefined;
  return !!model && Array.isArray(model.sheets) && typeof model.columnsBySheet === 'object' && typeof model.rowsBySheet === 'object';
}

/**
 * The workbook an old model holds. `newTabId` names the tabs; notes become
 * comments by `owner`, dated `now`.
 */
export function convertLegacyModel(
  model: LegacyModel,
  opts: { newTabId: () => string; owner: { id: string; name: string }; now: number; firstTabName: string },
): WorkbookSnapshot {
  const sheets = [...model.sheets].sort((a, b) => a.position - b.position);
  const used = new Set<string>();
  const workbook = new Workbook();
  workbook.sheets.push(new Sheet(opts.newTabId(), sheets.length ? uniqueTabName(sheets[0]!.name, used) : opts.firstTabName));
  const engine = new Engine(workbook, { now: () => opts.now, random: () => 0.5, timezoneOffset: () => 0 });
  sheets.forEach((old, i) => {
    if (i > 0) applyOp(engine, { type: 'addSheet', sheetId: opts.newTabId(), name: uniqueTabName(old.name, used), index: i });
    fillTab(engine, engine.workbook.sheets[i]!, model, old.id, opts);
  });
  return engine.toSnapshot();
}

function uniqueTabName(name: string, used: Set<string>): string {
  const base = (name || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 90) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${n})`;
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function fillTab(
  engine: Engine,
  tab: Sheet,
  model: LegacyModel,
  oldId: string,
  opts: { owner: { id: string; name: string }; now: number },
): void {
  const columns = [...(model.columnsBySheet[oldId] ?? [])].sort((a, b) => a.position - b.position);
  const rows = [...(model.rowsBySheet[oldId] ?? [])].sort((a, b) => a.position - b.position);
  const cells: CellPatch[] = [];
  const notes: { row: number; col: number; text: string }[] = [];
  const styled: { row: number; col: number; style: CellStyle }[] = [];

  rows.forEach((row, r) => {
    const data = row.data ?? {};
    columns.forEach((column, c) => {
      const format = data[`__fmt__${column.id}`] as LegacyFormat | undefined;
      const content = cellContent(data, column.id, format);
      if (content) cells.push([r, c, content]);
      const style = format && typeof format === 'object' ? styleOf(format) : null;
      if (style) styled.push({ row: r, col: c, style });
      const note = data[`__note__${column.id}`];
      if (typeof note === 'string' && note.trim()) notes.push({ row: r, col: c, text: note.trim() });
    });
  });

  // The data goes in first, as the old grid numbered it; the header row then
  // pushes it (and every formula's references) down one row.
  if (cells.length) applyOp(engine, { type: 'setCells', sheetId: tab.id, cells });
  if (columns.length === 0) return;
  applyOp(engine, { type: 'insertDims', sheetId: tab.id, sheetName: tab.name, axis: 'row', at: 0, count: 1 });
  applyOp(engine, { type: 'setCells', sheetId: tab.id, cells: columns.map((col, c): CellPatch => [0, c, col.name ? { v: col.name } : null]) });
  applyOp(engine, { type: 'formatRanges', sheetId: tab.id, ranges: [{ r1: 0, c1: 0, r2: 0, c2: columns.length - 1 }], patch: { bold: true } });
  applyOp(engine, { type: 'setFreeze', sheetId: tab.id, rows: 1, cols: 0 });

  for (const { row, col, style } of styled) {
    applyOp(engine, { type: 'formatRanges', sheetId: tab.id, ranges: [{ r1: row + 1, c1: col, r2: row + 1, c2: col }], patch: style });
  }
  const widths = columns.flatMap((col, c): [number, number][] => (col.width && col.width > 0 ? [[c, Math.round(col.width)]] : []));
  if (widths.length) applyOp(engine, { type: 'resizeDims', sheetId: tab.id, axis: 'col', entries: widths });

  const lists: DataValidation[] = columns.flatMap((col, c) => {
    const options = (col.options ?? []).filter((o) => typeof o === 'string' && o);
    if (col.fieldType !== 'select' || options.length === 0) return [];
    const range = { r1: 1, c1: c, r2: Math.max(1, rows.length + 100), c2: c };
    return [{ id: `dv_${tab.id}_${c}`, ranges: [range], criteria: { type: 'list', values: options }, strict: false, dropdown: true }];
  });
  if (lists.length) applyOp(engine, { type: 'patchValidations', sheetId: tab.id, set: lists });

  const comments: SheetComment[] = notes.map((n, i) => ({
    id: `cm_${tab.id}_${i}`,
    thread: `cm_${tab.id}_${i}`,
    author: { ...opts.owner },
    createdAt: opts.now,
    body: n.text.slice(0, 10_000),
    cell: { row: n.row + 1, col: n.col },
  }));
  if (comments.length) applyOp(engine, { type: 'patchComments', sheetId: tab.id, set: comments });
}

/** A cell's content: its rich text's plain text, a link as HYPERLINK, a formula, or its value. */
function cellContent(data: Record<string, unknown>, colId: string, format: LegacyFormat | undefined): { v: Scalar; f?: string } | null {
  const runs = data[`__rt__${colId}`];
  let value = data[colId];
  if (Array.isArray(runs)) value = runs.map((r) => (typeof r?.text === 'string' ? r.text : '')).join('');
  if (value === undefined || value === null || value === '') return null;
  const link = data[`__link__${colId}`];
  if (typeof link === 'string' && /^https?:\/\//i.test(link)) {
    return { v: null, f: `HYPERLINK(${quote(link)},${quote(String(value))})` };
  }
  if (typeof value === 'string' && value.startsWith('=') && value.length > 1) return { v: null, f: value.slice(1) };
  if (typeof value === 'boolean') return { v: value };
  if (typeof value === 'number') return { v: dateLike(format) ? excelSerial(value) : value };
  if (typeof value !== 'string') return null;
  // The old grid kept typed numbers as text; numbers read as numbers again.
  if (isPlainNumber(value.trim())) {
    const n = Number(value);
    return { v: dateLike(format) ? excelSerial(n) : n };
  }
  return { v: value };
}

/** Digits with an optional sign, one decimal point and an exponent: what the old grid saved typed numbers as. */
export function isPlainNumber(text: string): boolean {
  if (!text || !Number.isFinite(Number(text))) return false;
  const [mantissa = '', exponent, extra] = text.toLowerCase().split('e');
  if (extra !== undefined) return false;
  const digits = (t: string) => t.length > 0 && [...t].every((ch) => ch >= '0' && ch <= '9');
  const [whole = '', fraction, more] = mantissa.replace(/^[-+]/, '').split('.');
  if (more !== undefined || (!whole && !fraction)) return false;
  if ((whole && !digits(whole)) || (fraction && !digits(fraction))) return false;
  return exponent === undefined || digits(exponent.replace(/^[-+]/, ''));
}

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

const dateLike = (f: LegacyFormat | undefined) => f?.numberFormat === 'date' || f?.numberFormat === 'time';

/** Old date cells held epoch milliseconds; a workbook holds days since 1899-12-30. */
function excelSerial(ms: number): number {
  return ms / 86_400_000 + 25_569;
}

function styleOf(f: LegacyFormat): CellStyle | null {
  const style: CellStyle = {};
  if (f.bold) style.bold = true;
  if (f.italic) style.italic = true;
  if (f.strikethrough) style.strike = true;
  if (isColor(f.textColor)) style.color = f.textColor;
  if (isColor(f.fillColor)) style.fill = f.fillColor;
  if (f.fontFamily) style.fontFamily = f.fontFamily.slice(0, 100);
  if (f.fontSize && f.fontSize > 0) style.fontSize = Math.round(f.fontSize * 0.75 * 2) / 2;
  if (f.textAlign) style.hAlign = f.textAlign;
  if (f.verticalAlign) style.vAlign = f.verticalAlign;
  if (f.textWrap === 'wrap' || f.textWrap === 'clip') style.wrap = f.textWrap;
  const numFmt = numberFormatOf(f);
  if (numFmt) style.numFmt = numFmt;
  Object.assign(style, bordersOf(f.border));
  return Object.keys(style).length ? style : null;
}

function isColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

function numberFormatOf(f: LegacyFormat): string | null {
  const places = Math.max(0, Math.min(10, f.decimalPlaces ?? 2));
  const decimals = places ? `.${'0'.repeat(places)}` : '';
  switch (f.numberFormat) {
    case 'number':
      return `#,##0${decimals}`;
    case 'currency':
      return `${quote(f.currencySymbol ?? '$')}#,##0${decimals}`;
    case 'percent':
      return `0${decimals}%`;
    case 'date':
      return 'yyyy-mm-dd';
    case 'time':
      return 'hh:mm:ss';
    case 'scientific':
      return `0${decimals}E+00`;
    case 'text':
      return '@';
    default:
      return null;
  }
}

function bordersOf(border: string | undefined): Partial<CellStyle> {
  const thin: BorderSide = { style: 'thin' };
  switch (border) {
    case 'all':
    case 'outer':
      return { borderTop: thin, borderBottom: thin, borderLeft: thin, borderRight: thin };
    case 'top':
      return { borderTop: thin };
    case 'bottom':
      return { borderBottom: thin };
    case 'left':
      return { borderLeft: thin };
    case 'right':
      return { borderRight: thin };
    default:
      return {};
  }
}
