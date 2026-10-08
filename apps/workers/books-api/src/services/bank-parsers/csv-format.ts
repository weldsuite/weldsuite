/**
 * CSV statements with an explicit layout.
 *
 * US banks don't share a CSV format, and guessing day-month order or the sign
 * convention misbooks money. The caller states the layout (`CsvFormat`): date
 * order, number separators, how negatives are written and which column holds
 * what. `detectCsvFormat` proposes one from a sample for the user to confirm;
 * the confirmed format is remembered per bank account in `importSettings`.
 */

import { cleanText } from './ids';
import type {
  BankFileParseResult,
  CsvColumnRef,
  CsvDateFormat,
  CsvFormat,
  CsvFormatProposal,
  ParsedBankTransaction,
} from './types';

// ── Reading rows ────────────────────────────────────────────────────────────

interface CsvRecord {
  cells: string[];
  /** 1-based physical line the record starts on. */
  line: number;
}

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** The delimiter that splits the first lines into the most consistent number of cells. */
export function detectDelimiter(content: string): NonNullable<CsvFormat['delimiter']> {
  const lines = content.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
  let best: NonNullable<CsvFormat['delimiter']> = ',';
  let bestScore = 0;
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((l) => readCsvRecords(l, delimiter)[0]?.cells.length ?? 1);
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

/** Split CSV text into records, honouring quotes, doubled quotes and line breaks inside quotes. */
export function readCsvRecords(content: string, delimiter: string): CsvRecord[] {
  const text = content.replace(/^﻿/, '');
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let touched = false;

  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    if (cells.some((c) => c.trim() !== '')) records.push({ cells, line: recordLine });
    cells = [];
    touched = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!touched) {
      recordLine = line;
      touched = true;
    }
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      endRecord();
    } else {
      cell += ch;
    }
  }
  if (touched || cell !== '' || cells.length > 0) endRecord();
  return records;
}

// ── Dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function makeDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function expandYear(year: number, digits: number): number {
  if (digits >= 4) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

/** A calendar date from a CSV cell, read with the declared order; null when it isn't one. */
export function parseCsvDate(raw: string, order: CsvDateFormat): string | null {
  // "1/15/2024 12:00:00 AM", "2024-01-15T00:00:00"
  const value = raw.trim().replaceAll('"', '').replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AaPp][Mm])?\s*(Z|[+-]\d{2}:?\d{2})?$/, '').trim();
  if (!value) return null;

  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return makeDate(Number(compact[1]), Number(compact[2]), Number(compact[3]));

  // A four-digit year first is unambiguous whatever the declared order.
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (iso) return makeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(value);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = expandYear(Number(numeric[3]), numeric[3].length);
    if (order === 'DMY') return makeDate(year, b, a);
    if (order === 'YMD') return null;
    return makeDate(year, a, b);
  }

  const named = /^(?:[A-Za-z]+,?\s+)?(\d{1,2})[\s-]([A-Za-z]{3,9})\.?,?[\s-](\d{2}|\d{4})$/.exec(value);
  if (named) {
    const month = MONTHS[named[2].toLowerCase()];
    return month ? makeDate(expandYear(Number(named[3]), named[3].length), month, Number(named[1])) : null;
  }
  const namedFirst = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/.exec(value);
  if (namedFirst) {
    const month = MONTHS[namedFirst[1].toLowerCase()];
    return month ? makeDate(expandYear(Number(namedFirst[3]), namedFirst[3].length), month, Number(namedFirst[2])) : null;
  }
  return null;
}

// ── Amounts ─────────────────────────────────────────────────────────────────

/**
 * A signed amount from a CSV cell. A leading minus, parentheses, a trailing
 * minus and a DR suffix all mean negative; `debit_credit_columns` files are
 * handled by the caller (each column holds a positive number).
 */
export function parseCsvAmount(
  raw: string,
  format: Pick<CsvFormat, 'decimalSeparator' | 'thousandsSeparator'>,
): number | null {
  let s = raw.trim().replaceAll('"', '').replaceAll(/[\s ]/g, '');
  if (!s) return null;
  let negative = false;

  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replaceAll(/[$€£¥]|USD|EUR|GBP|CAD/gi, '');
  if (/dr$/i.test(s)) {
    negative = true;
    s = s.slice(0, -2);
  } else if (/cr$/i.test(s)) {
    s = s.slice(0, -2);
  }
  if (/^[-−–]/.test(s)) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (/[-−–]$/.test(s)) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.replaceAll(/[$€£¥]/g, '');

  const { decimalSeparator, thousandsSeparator } = format;
  if (thousandsSeparator && thousandsSeparator !== ' ' && thousandsSeparator !== decimalSeparator) {
    s = s.replaceAll(thousandsSeparator, '');
  }
  if (decimalSeparator === ',') s = s.replace(',', '.');
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(s)) return null;
  const value = Number.parseFloat(s);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

// ── Parsing with a format ───────────────────────────────────────────────────

function normalizeHeader(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9#]+/g, ' ').trim();
}

function resolveColumn(
  ref: CsvColumnRef | undefined,
  headers: string[] | null,
  label: string,
  problems: string[],
): number | null {
  if (ref === undefined || ref === null || ref === '') return null;
  if (typeof ref === 'number') return ref;
  if (headers) {
    const wanted = normalizeHeader(ref);
    const at = headers.findIndex((h) => normalizeHeader(h) === wanted);
    if (at >= 0) return at;
  }
  if (/^\d+$/.test(ref)) return Number.parseInt(ref, 10);
  problems.push(`${label} column "${ref}" was not found in the header row`);
  return null;
}

/** Parse `content` with a confirmed layout. Rows that don't read are reported and skipped. */
export function parseCsvWithFormat(content: string, format: CsvFormat): BankFileParseResult {
  const result: BankFileParseResult = { format: 'csv', transactions: [], errors: [] };
  const delimiter = format.delimiter ?? detectDelimiter(content);
  const records = readCsvRecords(content, delimiter);
  const skip = Math.max(0, format.skipRows | 0);
  const headerRecord = format.hasHeader ? records[skip] : undefined;
  const dataRecords = records.slice(skip + (format.hasHeader ? 1 : 0));
  if (format.hasHeader && !headerRecord) {
    result.errors.push({ message: 'The file has no header row after the skipped rows' });
    return result;
  }
  const headers = headerRecord ? headerRecord.cells.map((c) => c.trim()) : null;

  const problems: string[] = [];
  const cols = format.columns;
  const date = resolveColumn(cols.date, headers, 'Date', problems);
  const description = resolveColumn(cols.description, headers, 'Description', problems);
  const amount = resolveColumn(cols.amount, headers, 'Amount', problems);
  const debit = resolveColumn(cols.debit, headers, 'Debit', problems);
  const credit = resolveColumn(cols.credit, headers, 'Credit', problems);
  const checkNumber = resolveColumn(cols.checkNumber, headers, 'Check number', problems);
  const payee = resolveColumn(cols.payee, headers, 'Payee', problems);
  const reference = resolveColumn(cols.reference, headers, 'Reference', problems);
  if (date === null) problems.push('A date column is required');
  if (amount === null && debit === null && credit === null) problems.push('An amount, or a debit and credit column, is required');
  if (problems.length > 0) {
    for (const message of problems) result.errors.push({ message });
    return result;
  }

  const cell = (cells: string[], at: number | null): string => (at === null ? '' : (cells[at] ?? '').trim());

  for (const record of dataRecords) {
    const { cells, line } = record;
    const dateText = cell(cells, date);
    const isoDate = parseCsvDate(dateText, format.dateFormat);
    if (!isoDate) {
      // Blank dates are usually pending rows, balance lines or footers.
      if (dateText) result.errors.push({ line, message: `Unreadable date "${dateText}"` });
      continue;
    }

    const amountText = cell(cells, amount);
    let signed: number | null;
    if (amountText) {
      signed = parseCsvAmount(amountText, format);
    } else if (debit !== null || credit !== null) {
      const outText = cell(cells, debit);
      const inText = cell(cells, credit);
      // No amount at all: a balance line or footer, not a transaction.
      if (!outText && !inText) continue;
      const out = outText ? parseCsvAmount(outText, format) : 0;
      const into = inText ? parseCsvAmount(inText, format) : 0;
      signed = out === null || into === null ? null : Math.abs(into) - Math.abs(out);
    } else {
      continue;
    }
    if (signed === null) {
      result.errors.push({ line, message: `Unreadable amount in "${amountText || cell(cells, debit) || cell(cells, credit)}"` });
      continue;
    }

    const txn: ParsedBankTransaction = {
      date: isoDate,
      description: cleanText(cell(cells, description)) || cleanText(cell(cells, payee)),
      amount: Math.round(signed * 100) / 100,
      counterpartyName: cleanText(cell(cells, payee)) || undefined,
      reference: cell(cells, reference) || undefined,
      checkNumber: cell(cells, checkNumber).replace(/^0+(?=\d)/, '') || undefined,
      rawData: { format: 'csv', line },
    };
    result.transactions.push(txn);
  }

  if (result.transactions.length > 0) {
    const dates = result.transactions.map((t) => t.date).sort((a, b) => a.localeCompare(b));
    result.dateRange = { from: dates[0], to: dates.at(-1)! };
  }
  return result;
}

// ── Proposing a format ──────────────────────────────────────────────────────

const SYNONYMS = {
  date: ['date', 'posted date', 'posting date', 'post date', 'transaction date', 'trans date', 'booking date', 'effective date', 'settlement date', 'completed date'],
  amount: ['amount', 'transaction amount', 'amt', 'net amount'],
  debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'payments out', 'charges'],
  credit: ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'money in', 'paid in'],
  checkNumber: ['check number', 'check no', 'check #', 'check num', 'checknumber', 'check or slip #', 'cheque number', 'cheque no', 'cheque', 'check', 'chk no', 'chk #'],
  reference: ['reference', 'reference number', 'ref', 'ref no', 'transaction id', 'trans id', 'fitid', 'confirmation', 'confirmation number'],
  description: ['description', 'transaction description', 'original description', 'extended description', 'memo', 'details', 'narrative', 'payee description'],
  payee: ['payee', 'merchant', 'counterparty', 'vendor', 'name'],
} as const;

type SynonymField = keyof typeof SYNONYMS;

function matchHeader(headers: string[], field: SynonymField, taken: Set<number>): number | null {
  const normalized = headers.map(normalizeHeader);
  for (const synonym of SYNONYMS[field]) {
    const at = normalized.findIndex((h, i) => !taken.has(i) && h === synonym);
    if (at >= 0) return at;
  }
  // Then as whole words ("Transaction Date (UTC)" holds "date"; "Checking" does not hold "check").
  for (const synonym of SYNONYMS[field]) {
    const at = normalized.findIndex((h, i) => !taken.has(i) && ` ${h} `.includes(` ${synonym} `));
    if (at >= 0) return at;
  }
  return null;
}

function looksLikeDate(value: string): boolean {
  return parseCsvDate(value, 'MDY') !== null || parseCsvDate(value, 'DMY') !== null;
}

/** Digits with optional sign, currency, parentheses and separators: a cell of a numeric column. */
function looksLikeNumber(value: string): boolean {
  const v = value.trim().replaceAll(/[()$€£¥+\-−–\s]/g, '').replace(/dr$|cr$/i, '');
  return /^\d[\d.,]*$/.test(v);
}

/** A number with one or two decimals, which tells an amount from a check number or a year. */
function looksLikeMoney(value: string): boolean {
  const v = value.trim().replaceAll(/[()$€£¥+\-−–\s]/g, '').replace(/dr$|cr$/i, '');
  return /^\d[\d.,]*[.,]\d{1,2}$/.test(v);
}

function detectDateOrder(cells: string[]): { order: CsvDateFormat; ambiguous: boolean } {
  let firstOver12 = false;
  let secondOver12 = false;
  let yearFirst = false;
  let sawNumeric = false;
  for (const raw of cells) {
    const value = raw.trim().replace(/[ T]\d{1,2}:\d{2}.*$/, '');
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(value) || /^\d{8}$/.test(value)) {
      yearFirst = true;
      continue;
    }
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(value);
    if (!m) continue;
    sawNumeric = true;
    if (Number(m[1]) > 12) firstOver12 = true;
    if (Number(m[2]) > 12) secondOver12 = true;
  }
  if (!sawNumeric) return { order: yearFirst ? 'YMD' : 'MDY', ambiguous: false };
  if (firstOver12 && !secondOver12) return { order: 'DMY', ambiguous: false };
  if (secondOver12 && !firstOver12) return { order: 'MDY', ambiguous: false };
  // Every part is up to 12 (or the file mixes both): the US default, to be confirmed.
  return { order: 'MDY', ambiguous: true };
}

function detectNumberFormat(cells: string[]): Pick<CsvFormat, 'decimalSeparator' | 'thousandsSeparator'> {
  let commaDecimal = 0;
  let dotDecimal = 0;
  let spaceThousands = false;
  for (const raw of cells) {
    const v = raw.replaceAll(/[()$€£¥+\-−–]/g, '').replaceAll(/[A-Za-z]/g, '').trim();
    if (/\d[ \u00A0]\d{3}/.test(v)) spaceThousands = true;
    const s = v.replaceAll(/[\s\u00A0]/g, '');
    if (/,\d{1,2}$/.test(s)) commaDecimal++;
    else if (/\.\d{1,2}$/.test(s)) dotDecimal++;
  }
  if (commaDecimal > dotDecimal) return { decimalSeparator: ',', thousandsSeparator: spaceThousands ? ' ' : '.' };
  return { decimalSeparator: '.', thousandsSeparator: spaceThousands ? ' ' : ',' };
}

/**
 * Propose a layout from the start of a file. The US is the default (MDY, '.'
 * decimals, ',' thousands); the caller must show the proposal for confirmation
 * because day-month order and delimiters can't always be told apart.
 */
export function detectCsvFormat(sample: string): CsvFormatProposal {
  const delimiter = detectDelimiter(sample.replace(/^﻿/, ''));
  const all = readCsvRecords(sample, delimiter);
  const warnings: string[] = [];

  // The header (or first data row) is the first record with the file's usual width.
  const widths = new Map<number, number>();
  for (const r of all) if (r.cells.length >= 2) widths.set(r.cells.length, (widths.get(r.cells.length) ?? 0) + 1);
  const modalWidth = [...widths.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
  const skipRows = Math.max(0, all.findIndex((r) => r.cells.length === modalWidth));
  const body = all.slice(skipRows);

  const first = body[0]?.cells ?? [];
  const hasHeader = first.length > 0 && !first.some((c) => looksLikeDate(c.trim()) || looksLikeNumber(c));
  const headers = hasHeader ? first.map((c) => c.trim()) : first.map((_, i) => `Column ${i + 1}`);
  const rows = (hasHeader ? body.slice(1) : body).map((r) => r.cells);
  const columnCells = (at: number) => rows.slice(0, 200).map((r) => (r[at] ?? '').trim()).filter(Boolean);

  const taken = new Set<number>();
  const pick = (field: SynonymField): number | null => {
    const at = hasHeader ? matchHeader(headers, field, taken) : null;
    if (at !== null) taken.add(at);
    return at;
  };

  let date = pick('date');
  let amount = pick('amount');
  const debit = amount === null ? pick('debit') : null;
  const credit = amount === null ? pick('credit') : null;
  const checkNumber = pick('checkNumber');
  const reference = pick('reference');
  let description = pick('description');
  const payee = pick('payee');

  if (!hasHeader || date === null) {
    const guess = headers.findIndex((_, i) => !taken.has(i) && columnCells(i).length > 0 && columnCells(i).every(looksLikeDate));
    if (date === null && guess >= 0) {
      date = guess;
      taken.add(guess);
    }
  }
  if (amount === null && debit === null && credit === null) {
    const guess = headers.findIndex((_, i) => !taken.has(i) && columnCells(i).length > 0 && columnCells(i).every(looksLikeMoney));
    if (guess >= 0) {
      amount = guess;
      taken.add(guess);
    }
  }
  if (description === null) {
    const guess = headers
      .map((_, i) => i)
      .filter((i) => !taken.has(i))
      .sort((a, b) => columnCells(b).join('').length - columnCells(a).join('').length)[0];
    description = payee ?? guess ?? null;
  }

  const amountCells = [amount, debit, credit]
    .filter((c): c is number => c !== null)
    .flatMap((c) => columnCells(c));
  const numbers = detectNumberFormat(amountCells);
  const dateCells = date === null ? [] : columnCells(date);
  const { order, ambiguous } = detectDateOrder(dateCells);

  let negativeStyle: CsvFormat['negativeStyle'] = 'minus';
  if (amount === null && (debit !== null || credit !== null)) negativeStyle = 'debit_credit_columns';
  else if (amountCells.some((c) => c.includes('('))) negativeStyle = 'parentheses';
  else if (amountCells.some((c) => /\d-$/.test(c.trim()))) negativeStyle = 'trailing_minus';

  if (date === null) warnings.push('No date column found; pick one');
  if (amount === null && debit === null && credit === null) warnings.push('No amount column found; pick one');
  if (ambiguous) warnings.push('Every date could be month-first or day-first; confirm the order');
  if (!hasHeader) warnings.push('No header row found; columns are given by position');

  const ref = (at: number | null): CsvColumnRef | undefined =>
    at === null ? undefined : hasHeader ? headers[at] : at;

  const format: CsvFormat = {
    dateFormat: order,
    decimalSeparator: numbers.decimalSeparator,
    thousandsSeparator: numbers.thousandsSeparator,
    negativeStyle,
    columns: {
      date: ref(date) ?? 0,
      description: ref(description) ?? (hasHeader ? headers[1] ?? 1 : 1),
      ...(amount !== null ? { amount: ref(amount) } : {}),
      ...(debit !== null ? { debit: ref(debit) } : {}),
      ...(credit !== null ? { credit: ref(credit) } : {}),
      ...(checkNumber !== null ? { checkNumber: ref(checkNumber) } : {}),
      ...(payee !== null && payee !== description ? { payee: ref(payee) } : {}),
      ...(reference !== null ? { reference: ref(reference) } : {}),
    },
    hasHeader,
    skipRows,
    delimiter,
  };
  if (format.columns.amount === undefined && format.columns.debit === undefined && format.columns.credit === undefined) {
    format.columns.amount = hasHeader ? headers[2] ?? 2 : 2;
  }

  return { format, headers, sampleRows: rows.slice(0, 8), dateOrderAmbiguous: ambiguous, warnings };
}
