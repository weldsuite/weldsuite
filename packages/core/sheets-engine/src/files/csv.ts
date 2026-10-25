/**
 * CSV and other delimited text (RFC 4180 quoting): reading a file into a
 * one-sheet workbook, and writing one sheet.
 *
 * Reading treats every field like typed input (numbers, dates and
 * percentages in the reader's locale, with the number format typing would
 * give them). Writing gives each cell's displayed text, as Excel and Google
 * Sheets do; locales with a decimal comma separate fields with ';'.
 */

import type { Engine } from '../calc/engine';
import { parseInput } from '../format/input';
import { EN_LOCALE, formatValue, type FormatLocale } from '../format/number-format';
import { parseFormula } from '../formula/parser';
import type { Cell } from '../model/cell-store';
import { styleKey } from '../model/styles';
import { DEFAULT_COL_COUNT, DEFAULT_COL_WIDTH, DEFAULT_ROW_COUNT, DEFAULT_ROW_HEIGHT } from '../model/workbook';
import { MAX_COLS, MAX_ROWS } from '../address';
import { ImportError, type ImportResult, type ReadOptions } from './types';

export interface ReadCsvOptions extends ReadOptions {
  /** Field separator; found from the text when left out. */
  delimiter?: string;
  sheetName?: string;
}

const DEFAULT_MAX_CELLS = 5_000_000;
const CANDIDATES = [',', ';', '\t', '|'];

export function readCsv(text: string, options: ReadCsvOptions = {}): ImportResult {
  const locale = options.locale ?? EN_LOCALE;
  const body = text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = options.delimiter ?? detectDelimiter(body);
  const rows = parseCsv(body, delimiter);
  if (rows.length > MAX_ROWS) throw new ImportError('The file has more rows than a sheet can hold', 'too_large');
  let budget = options.maxCells ?? DEFAULT_MAX_CELLS;
  const cells: [number, number, Cell][] = [];
  let lastCol = -1;
  rows.forEach((fields, row) => {
    if (fields.length > MAX_COLS) throw new ImportError('The file has more columns than a sheet can hold', 'too_large');
    fields.forEach((field, col) => {
      const cell = cellFor(field, locale);
      if (!cell) return;
      if (--budget < 0) throw new ImportError('The file has more cells than WeldSheets can open yet', 'too_large');
      cells.push([row, col, cell]);
      lastCol = Math.max(lastCol, col);
    });
  });
  const sheet = {
    id: options.sheetId?.(0) ?? 'sheet1',
    name: options.sheetName?.slice(0, 100) || 'Sheet1',
    rowCount: Math.max(DEFAULT_ROW_COUNT, rows.length),
    colCount: Math.max(DEFAULT_COL_COUNT, lastCol + 1),
    rows: { defaultSize: DEFAULT_ROW_HEIGHT },
    cols: { defaultSize: DEFAULT_COL_WIDTH },
    cells,
  };
  return { workbook: { version: 1, sheets: [sheet] }, warnings: [] };
}

/** A field as a cell, read like typed input; null for an empty field. */
function cellFor(field: string, locale: FormatLocale): Cell | null {
  if (field === '') return null;
  const parsed = parseInput(field, { locale });
  if (parsed.kind === 'formula') {
    // Only formulas WeldSheets can read; anything else stays the text it is.
    try {
      parseFormula(parsed.formula);
      return { v: null, f: parsed.formula };
    } catch {
      return { v: field };
    }
  }
  if (parsed.value === null) return null;
  const s = parsed.numFmt ? styleKey({ numFmt: parsed.numFmt }) : undefined;
  return s ? { v: parsed.value, s } : { v: parsed.value };
}

/** The candidate separator that splits the first lines most evenly, preferring ',' then ';', tab, '|'. */
export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  const cut = sample.length < text.length;
  let best = ',';
  let bestScore = 0;
  for (const d of CANDIDATES) {
    let rows = parseCsv(sample, d, 10).filter((r) => r.length > 1 || r[0] !== '');
    // A sample cut mid-row would undercount its last row.
    if (cut && rows.length > 1) rows = rows.slice(0, -1);
    const counts = rows.map((r) => r.length);
    if (counts.length === 0) continue;
    const min = Math.min(...counts);
    if (min < 2) continue;
    // Splitting every line into the same number of fields beats splitting some into more.
    const score = counts.every((n) => n === counts[0]) ? min + 1000 : min;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Rows of fields. Quoted fields may hold separators, quotes ("") and line breaks. */
export function parseCsv(text: string, delimiter: string, maxRows = Infinity): string[][] {
  const parser = new CsvParser(text, delimiter);
  const rows: string[][] = [];
  while (rows.length < maxRows) {
    const row = parser.nextRow();
    if (!row) break;
    rows.push(row);
  }
  return rows;
}

class CsvParser {
  private i = 0;

  constructor(
    private readonly text: string,
    private readonly delimiter: string,
  ) {}

  /** The next row, or null past the end of the text. */
  nextRow(): string[] | null {
    if (this.i >= this.text.length) return null;
    const row: string[] = [this.field()];
    while (this.text[this.i] === this.delimiter) {
      this.i++;
      row.push(this.field());
    }
    // Past the line break (\r\n, \n or \r) that ends the row.
    if (this.text[this.i] === '\r' && this.text[this.i + 1] === '\n') this.i += 2;
    else if (this.i < this.text.length) this.i++;
    return row;
  }

  /** One field, up to the separator or line break after it. */
  private field(): string {
    if (this.text[this.i] === '"') return this.quoted();
    const start = this.i;
    while (this.i < this.text.length && !this.endsField(this.text[this.i]!)) this.i++;
    return this.text.slice(start, this.i);
  }

  private endsField(ch: string): boolean {
    return ch === this.delimiter || ch === '\r' || ch === '\n';
  }

  /** A quoted field: separators and line breaks inside are text, and "" is a quote. */
  private quoted(): string {
    let out = '';
    this.i++;
    for (;;) {
      const close = this.text.indexOf('"', this.i);
      if (close < 0) {
        out += this.text.slice(this.i);
        this.i = this.text.length;
        return out;
      }
      out += this.text.slice(this.i, close);
      this.i = close + 1;
      if (this.text[this.i] !== '"') break;
      out += '"';
      this.i++;
    }
    // Text after the closing quote belongs to the field too, as spreadsheets read it.
    return out + this.field();
  }
}

export interface WriteCsvOptions {
  /** How values are shown (default English). */
  locale?: FormatLocale;
  /** Default ';' for locales with a decimal comma, else ','. */
  delimiter?: string;
}

/** One sheet as CSV, from A1 to its last filled cell, each cell as it is displayed. */
export function writeCsv(engine: Engine, sheetId: string, options: WriteCsvOptions = {}): string {
  const locale = options.locale ?? EN_LOCALE;
  const delimiter = options.delimiter ?? (locale.decimal === ',' ? ';' : ',');
  const sheet = engine.workbook.requireSheet(sheetId);
  const used = engine.usedRange(sheetId);
  if (!used) return '';
  const lines: string[] = [];
  for (let row = 0; row <= used.r2; row++) {
    const fields: string[] = [];
    for (let col = 0; col <= used.c2; col++) {
      const value = engine.getValue(sheetId, row, col);
      const text = formatValue(value, engine.workbook.style(sheet, row, col)?.numFmt, locale).text;
      fields.push(csvField(text, delimiter));
    }
    lines.push(fields.join(delimiter));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function csvField(text: string, delimiter: string): string {
  const needsQuotes = text.includes(delimiter) || /["\r\n]/.test(text) || text !== text.trim();
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}
