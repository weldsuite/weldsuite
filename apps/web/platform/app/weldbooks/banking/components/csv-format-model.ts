/**
 * The CSV format editor's model. A CSV layout is edited as a draft that points
 * at columns by index (what a dropdown can hold); `formatFromDraft` turns it
 * into the `CsvFormat` the import endpoints take, naming a column by its header
 * text when the file has a unique one so a remembered format survives a bank
 * moving a column. `readCsvTable` reads the head of the file the way the server
 * does, so the dropdowns and sample rows always match what will be parsed.
 */
import type {
  CsvColumnRef,
  CsvDateFormat,
  CsvDelimiter,
  CsvFormat,
  CsvNegativeStyle,
} from '@/lib/api/domains/weldbooks-banking';

export const CSV_COLUMN_KEYS = ['date', 'description', 'amount', 'debit', 'credit', 'checkNumber', 'payee', 'reference'] as const;
export type CsvColumnKey = (typeof CSV_COLUMN_KEYS)[number];

export const CSV_DATE_FORMATS: readonly CsvDateFormat[] = ['MDY', 'DMY', 'YMD'];
export const CSV_NEGATIVE_STYLES: readonly CsvNegativeStyle[] = ['minus', 'parentheses', 'debit_credit_columns', 'trailing_minus'];
export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|'];

/** A CSV layout being edited. Columns are zero-based indexes, `null` for "none". */
export interface CsvFormatDraft {
  dateFormat: CsvDateFormat;
  decimalSeparator: CsvFormat['decimalSeparator'];
  thousandsSeparator: CsvFormat['thousandsSeparator'];
  negativeStyle: CsvNegativeStyle;
  columns: Record<CsvColumnKey, number | null>;
  hasHeader: boolean;
  skipRows: number;
  /** `null` reads the delimiter from the file. */
  delimiter: CsvDelimiter | null;
}

/** The US defaults: month first, "." decimals, "," thousands, signed amounts. */
export const EMPTY_CSV_DRAFT: CsvFormatDraft = {
  dateFormat: 'MDY',
  decimalSeparator: '.',
  thousandsSeparator: ',',
  negativeStyle: 'minus',
  columns: { date: null, description: null, amount: null, debit: null, credit: null, checkNumber: null, payee: null, reference: null },
  hasHeader: true,
  skipRows: 0,
  delimiter: null,
};

// ── Reading the file ────────────────────────────────────────────────────────

const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

/** The text without a leading byte-order mark, which Excel and some banks put in front of a CSV. */
function stripBom(content: string): string {
  return content.startsWith(BYTE_ORDER_MARK) ? content.slice(1) : content;
}

/** Split CSV text into records of cells, honouring quotes; blank records are dropped. */
function readRecords(content: string, delimiter: string, limit: number): string[][] {
  const text = stripBom(content);
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let touched = false;

  const endRecord = () => {
    cells.push(cell);
    cell = '';
    if (cells.some((c) => c.trim() !== '')) records.push(cells);
    cells = [];
    touched = false;
  };

  for (let i = 0; i < text.length && records.length < limit; i++) {
    const ch = text[i];
    touched = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else {
      cell += ch;
    }
  }
  if (records.length < limit && (touched || cell !== '' || cells.length > 0)) endRecord();
  return records;
}

/** The delimiter that splits the first lines into the most consistent number of cells. */
export function detectCsvDelimiter(content: string): CsvDelimiter {
  const head = stripBom(content).split(/\r?\n/).filter((l) => l.trim()).slice(0, 12).join('\n');
  let best: CsvDelimiter = ',';
  let bestScore = 0;
  for (const delimiter of CSV_DELIMITERS) {
    const counts = readRecords(head, delimiter, 12).map((r) => r.length);
    const tally = new Map<number, number>();
    for (const c of counts) tally.set(c, (tally.get(c) ?? 0) + 1);
    const [modal, agreeing] = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [1, 0];
    const score = modal > 1 ? agreeing * 100 + modal : 0;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

export interface CsvTable {
  delimiter: CsvDelimiter;
  /** Header cells, or `Column 1…` when the file has no header row. */
  headers: string[];
  /** The first data rows. */
  rows: string[][];
}

/** The head of a CSV file under the draft's delimiter, skipped rows and header setting. */
export function readCsvTable(
  content: string,
  options: { delimiter: CsvDelimiter | null; skipRows: number; hasHeader: boolean },
  maxRows = 8,
): CsvTable {
  const delimiter = options.delimiter ?? detectCsvDelimiter(content);
  const skip = Math.max(0, Math.floor(options.skipRows) || 0);
  const records = readRecords(content, delimiter, skip + maxRows + 2);
  const body = records.slice(skip);
  const width = Math.max(0, ...body.slice(0, maxRows + 1).map((r) => r.length));
  const headerRow = options.hasHeader ? body[0]?.map((c) => c.trim()) : undefined;
  const headers = headerRow ?? Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  const rows = (options.hasHeader ? body.slice(1) : body).slice(0, maxRows);
  return { delimiter, headers, rows };
}

// ── Draft <-> format ────────────────────────────────────────────────────────

function normalizeHeader(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9#]+/g, ' ').trim();
}

/** The index a column reference points at in this file, or null when it is not there. */
function indexOfRef(ref: CsvColumnRef | undefined, headers: string[], hasHeader: boolean): number | null {
  if (ref === undefined || ref === '') return null;
  if (typeof ref === 'number') return ref;
  if (hasHeader) {
    const wanted = normalizeHeader(ref);
    const at = headers.findIndex((h) => normalizeHeader(h) === wanted);
    if (at >= 0) return at;
  }
  return /^\d+$/.test(ref) ? Number.parseInt(ref, 10) : null;
}

/** A draft of an existing format, with columns resolved against the file's headers. */
export function draftFromFormat(format: CsvFormat, headers: string[]): CsvFormatDraft {
  const columns = { ...EMPTY_CSV_DRAFT.columns };
  for (const key of CSV_COLUMN_KEYS) {
    columns[key] = indexOfRef(format.columns[key], headers, format.hasHeader);
  }
  return {
    dateFormat: format.dateFormat,
    decimalSeparator: format.decimalSeparator,
    thousandsSeparator: format.thousandsSeparator,
    negativeStyle: format.negativeStyle,
    columns,
    hasHeader: format.hasHeader,
    skipRows: format.skipRows,
    delimiter: format.delimiter ?? null,
  };
}

/** How to point at the column at `index`: its header text when that is unique in the file, else its index. */
function refForIndex(index: number, headers: string[], hasHeader: boolean): CsvColumnRef {
  const header = headers[index]?.trim();
  if (hasHeader && header) {
    const unique = headers.filter((h) => normalizeHeader(h) === normalizeHeader(header)).length === 1;
    if (unique) return header;
  }
  return index;
}

export type CsvDraftProblem = 'date' | 'description' | 'amount' | 'debit_credit' | 'separators';

/** What stops the draft from being a valid format; empty when it is one. */
export function draftProblems(draft: CsvFormatDraft): CsvDraftProblem[] {
  const problems: CsvDraftProblem[] = [];
  if (draft.columns.date === null) problems.push('date');
  if (draft.columns.description === null) problems.push('description');
  if (draft.negativeStyle === 'debit_credit_columns') {
    if (draft.columns.debit === null && draft.columns.credit === null) problems.push('debit_credit');
  } else if (draft.columns.amount === null) {
    problems.push('amount');
  }
  if (draft.decimalSeparator === draft.thousandsSeparator) problems.push('separators');
  return problems;
}

/**
 * The request's `csvFormat` for a draft, or null while the draft is incomplete.
 * One signed column holds the amount unless the style is separate debit and
 * credit columns, in which case the amount column is left out.
 */
export function formatFromDraft(draft: CsvFormatDraft, headers: string[]): CsvFormat | null {
  if (draftProblems(draft).length > 0) return null;
  const ref = (key: CsvColumnKey): CsvColumnRef | undefined => {
    const index = draft.columns[key];
    return index === null ? undefined : refForIndex(index, headers, draft.hasHeader);
  };
  const split = draft.negativeStyle === 'debit_credit_columns';
  const columns: CsvFormat['columns'] = {
    date: ref('date')!,
    description: ref('description')!,
    ...(split ? {} : { amount: ref('amount') }),
    ...(split && draft.columns.debit !== null ? { debit: ref('debit') } : {}),
    ...(split && draft.columns.credit !== null ? { credit: ref('credit') } : {}),
    ...(draft.columns.checkNumber !== null ? { checkNumber: ref('checkNumber') } : {}),
    ...(draft.columns.payee !== null ? { payee: ref('payee') } : {}),
    ...(draft.columns.reference !== null ? { reference: ref('reference') } : {}),
  };
  return {
    dateFormat: draft.dateFormat,
    decimalSeparator: draft.decimalSeparator,
    thousandsSeparator: draft.thousandsSeparator,
    negativeStyle: draft.negativeStyle,
    columns,
    hasHeader: draft.hasHeader,
    skipRows: Math.max(0, Math.floor(draft.skipRows) || 0),
    ...(draft.delimiter ? { delimiter: draft.delimiter } : {}),
  };
}
