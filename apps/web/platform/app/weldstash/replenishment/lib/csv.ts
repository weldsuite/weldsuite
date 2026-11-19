/**
 * Sales history CSV: parsing in the browser, column mapping and the rows the
 * import endpoint takes. No dependency: the platform has no CSV parser, and
 * the format needed here (quoted fields, a delimiter of `,` `;` or tab) is small.
 *
 * Pure, so it is tested apart from the wizard.
 */

import { IMPORT_CHUNK_SIZE, type SalesHistoryRowInput } from '@weldsuite/app-api-client/schemas/replenishment';

export type Delimiter = ',' | ';' | '\t';

/** The delimiter used most on the first non-empty line, outside quotes. */
export function detectDelimiter(text: string): Delimiter {
  const firstLine = stripBom(text).split(/\r\n|\n|\r/).find((line) => line.trim() !== '') ?? '';
  const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of firstLine) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char in counts) counts[char as Delimiter] += 1;
  }
  const best = (Object.keys(counts) as Delimiter[]).reduce((a, b) => (counts[b] > counts[a] ? b : a), ',' as Delimiter);
  return counts[best] > 0 ? best : ',';
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The parser's state while it walks the text. */
interface CsvState {
  rows: string[][];
  row: string[];
  field: string;
  quoted: boolean;
}

function endField(state: CsvState): void {
  state.row.push(state.field);
  state.field = '';
}

function endRow(state: CsvState): void {
  endField(state);
  if (state.row.some((value) => value.trim() !== '')) state.rows.push(state.row);
  state.row = [];
}

/** One character inside quotes. Returns how many characters after it were used too. */
function readQuoted(state: CsvState, input: string, i: number): number {
  if (input[i] !== '"') {
    state.field += input[i];
    return 0;
  }
  if (input[i + 1] === '"') {
    state.field += '"';
    return 1;
  }
  state.quoted = false;
  return 0;
}

/** One character outside quotes. Returns how many characters after it were used too. */
function readUnquoted(state: CsvState, input: string, i: number, delimiter: Delimiter): number {
  const char = input[i];
  if (char === '"' && state.field === '') {
    state.quoted = true;
    return 0;
  }
  if (char === delimiter) {
    endField(state);
    return 0;
  }
  if (char === '\n' || char === '\r') {
    endRow(state);
    return char === '\r' && input[i + 1] === '\n' ? 1 : 0;
  }
  state.field += char;
  return 0;
}

/** Parses CSV text into rows of fields. Handles quotes, doubled quotes, CRLF, and drops rows with no content. */
export function parseCsv(text: string, delimiter: Delimiter = detectDelimiter(text)): string[][] {
  const input = stripBom(text);
  const state: CsvState = { rows: [], row: [], field: '', quoted: false };
  for (let i = 0; i < input.length; i += 1) {
    i += state.quoted ? readQuoted(state, input, i) : readUnquoted(state, input, i, delimiter);
  }
  if (state.field !== '' || state.row.length > 0) endRow(state);
  return state.rows;
}

// ── Column mapping ──────────────────────────────────────────────────────────

/** Column indexes into a row; -1 means "not in the file". */
export interface ColumnMapping {
  date: number;
  sku: number;
  quantity: number;
  warehouseCode: number;
  reference: number;
}

export const EMPTY_MAPPING: ColumnMapping = { date: -1, sku: -1, quantity: -1, warehouseCode: -1, reference: -1 };

const HEADER_GUESSES: Record<keyof ColumnMapping, string[]> = {
  date: ['date', 'datum', 'order date', 'orderdatum', 'day', 'dag', 'sold on', 'invoice date', 'factuurdatum'],
  sku: ['sku', 'article', 'artikel', 'artikelnummer', 'item', 'product code', 'productcode', 'product', 'internal reference', 'reference code'],
  quantity: ['quantity', 'qty', 'aantal', 'units', 'stuks', 'sold', 'verkocht', 'amount'],
  warehouseCode: ['warehouse', 'warehouse code', 'magazijn', 'magazijncode', 'location', 'locatie'],
  reference: ['reference', 'referentie', 'order', 'order number', 'ordernummer', 'invoice', 'factuur', 'document'],
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replaceAll(/[_\-.]+/g, ' ').replaceAll(/\s+/g, ' ');
}

/** Guesses which column is which from the header row (English and Dutch names). Each column is used once. */
export function guessMapping(headers: readonly string[]): ColumnMapping {
  const normalized = headers.map(normalizeHeader);
  const taken = new Set<number>();
  const mapping: ColumnMapping = { ...EMPTY_MAPPING };
  // Exact names first for every field, then looser matches, so "order date" is not taken as the reference.
  for (const pass of ['exact', 'contains'] as const) {
    for (const field of Object.keys(HEADER_GUESSES) as Array<keyof ColumnMapping>) {
      if (mapping[field] !== -1) continue;
      const index = normalized.findIndex(
        (header, i) =>
          !taken.has(i) &&
          HEADER_GUESSES[field].some((guess) => (pass === 'exact' ? header === guess : header.includes(guess))),
      );
      if (index !== -1) {
        mapping[field] = index;
        taken.add(index);
      }
    }
  }
  return mapping;
}

/** Whether the file can be imported with this mapping: date, SKU and quantity are required. */
export function isMappingComplete(mapping: ColumnMapping): boolean {
  return mapping.date >= 0 && mapping.sku >= 0 && mapping.quantity >= 0;
}

// ── Values ──────────────────────────────────────────────────────────────────

/** How to read `05-03-2026`: day first (the default), month first, or year first. */
export type DateFormat = 'auto' | 'dmy' | 'mdy' | 'ymd';

function validDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A date as `YYYY-MM-DD`, or null. ISO dates are always read as such; `auto` reads a numeric date day-first unless the middle number is above 12. */
export function parseDate(value: string, format: DateFormat = 'auto'): string | null {
  const text = value.trim();
  if (!text) return null;

  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const short = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[T\s].*)?$/.exec(text);
  if (!short) return null;
  const a = Number(short[1]);
  const b = Number(short[2]);
  const year = Number(short[3]);
  if (format === 'mdy') return validDate(year, a, b);
  if (format === 'dmy' || format === 'ymd') return validDate(year, b, a);
  // auto: a number above 12 can only be the day.
  if (b > 12 && a <= 12) return validDate(year, a, b);
  return validDate(year, b, a);
}

/** A whole quantity (`5`, `-2`, `5.0`, `5,00`), or null for anything else. */
export function parseQuantity(value: string): number | null {
  const text = value.replaceAll(/\s/g, '');
  if (!/^[+-]?\d+(?:[.,]0+)?$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) ? n : null;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export type RowErrorCode = 'date' | 'sku' | 'quantity';

export interface RowError {
  /** Line number in the file (the header is line 1). */
  line: number;
  code: RowErrorCode;
  /** The offending text, for the message. */
  value: string;
}

export interface MappedRows {
  rows: SalesHistoryRowInput[];
  errors: RowError[];
  dateFrom: string | null;
  dateTo: string | null;
  distinctSkus: number;
}

function cell(row: readonly string[], index: number): string {
  return index >= 0 ? (row[index] ?? '').trim() : '';
}

/** Turns data rows (header excluded) into import rows. A row with a bad date, SKU or quantity is reported and left out. */
export function mapRows(
  dataRows: readonly (readonly string[])[],
  mapping: ColumnMapping,
  format: DateFormat = 'auto',
  firstLine = 2,
): MappedRows {
  const rows: SalesHistoryRowInput[] = [];
  const errors: RowError[] = [];
  const skus = new Set<string>();
  let dateFrom: string | null = null;
  let dateTo: string | null = null;

  dataRows.forEach((raw, i) => {
    const line = firstLine + i;
    const rawDate = cell(raw, mapping.date);
    const sku = cell(raw, mapping.sku);
    const rawQuantity = cell(raw, mapping.quantity);

    const date = parseDate(rawDate, format);
    if (!date) {
      errors.push({ line, code: 'date', value: rawDate });
      return;
    }
    if (!sku) {
      errors.push({ line, code: 'sku', value: sku });
      return;
    }
    const quantity = parseQuantity(rawQuantity);
    if (quantity === null) {
      errors.push({ line, code: 'quantity', value: rawQuantity });
      return;
    }

    const row: SalesHistoryRowInput = { date, sku, quantity };
    const warehouseCode = cell(raw, mapping.warehouseCode);
    const reference = cell(raw, mapping.reference);
    if (warehouseCode) row.warehouseCode = warehouseCode;
    if (reference) row.reference = reference;
    rows.push(row);

    skus.add(sku);
    if (dateFrom === null || date < dateFrom) dateFrom = date;
    if (dateTo === null || date > dateTo) dateTo = date;
  });

  return { rows, errors, dateFrom, dateTo, distinctSkus: skus.size };
}

/** Splits rows into the chunks the import endpoint takes (1,000 at most). */
export function chunkRows<T>(items: readonly T[], size = IMPORT_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
