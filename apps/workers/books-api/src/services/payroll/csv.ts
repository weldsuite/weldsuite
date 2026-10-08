/**
 * CSV reading for payroll exports: an RFC 4180 parser (quoted fields, doubled
 * quotes, CRLF, a BOM, comma / semicolon / tab delimiters), and the money and
 * date formats payroll reports use.
 */

import { daysInMonth, formatIso, isIsoDate } from '@weldsuite/books-domain/us-compliance/dates';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

const DELIMITERS = [',', ';', '\t'] as const;

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let best: string = ',';
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const char of firstLine) {
      if (char === '"') quoted = !quoted;
      else if (char === delimiter && !quoted) count += 1;
    }
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(input: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((row) => row.some((value) => value.trim() !== ''));
  const [headers = [], ...rows] = nonEmpty;
  return { headers: headers.map((header) => header.trim()), rows };
}

/** Index of a column by header name (case and surrounding spaces ignored), or -1. */
export function columnIndex(headers: readonly string[], name: string | undefined): number {
  if (!name) return -1;
  const wanted = name.trim().toLowerCase();
  return headers.findIndex((header) => header.trim().toLowerCase() === wanted);
}

/**
 * A money amount from a payroll report: `1,234.56`, `$1,234.56`, `(1,234.56)`
 * and `1234.56-` are negative or positive as written; `1.234,56` is read as
 * European. Empty or a dash is `null`; anything else that isn't a number
 * throws.
 */
export function parseMoney(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let value = raw.trim();
  if (value === '' || value === '-' || value === '--') return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  if (value.endsWith('-')) {
    negative = true;
    value = value.slice(0, -1);
  }
  if (value.startsWith('-')) {
    negative = !negative;
    value = value.slice(1);
  }
  value = value.replace(/^\+/, '').replace(/^(USD|US\$|\$)\s*/i, '').replace(/\s*(USD)$/i, '').trim();
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(value)) value = value.replace(/\./g, '').replace(',', '.');
  else if (/^\d+,\d{1,2}$/.test(value)) value = value.replace(',', '.');
  else value = value.replace(/,/g, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(value)) throw new RangeError(`"${raw}" is not an amount`);
  const amount = Math.round(Number(value) * 100) / 100;
  return negative ? -amount : amount;
}

export type DateFormat = 'auto' | 'mdy' | 'dmy' | 'iso';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function fullYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

/** A date from a payroll report as `YYYY-MM-DD`, or `null` when it is not a date. Slash dates are month first unless `format` says otherwise. */
export function parseDate(raw: string | undefined, format: DateFormat = 'auto'): string | null {
  if (!raw) return null;
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value);
  if (iso) {
    const day = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return isIsoDate(day) ? day : null;
  }
  const ymd = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(value);
  if (ymd) return build(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  const parts = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value);
  if (parts) {
    const first = Number(parts[1]);
    const second = Number(parts[2]);
    const year = fullYear(Number(parts[3]));
    return format === 'dmy' ? build(year, second, first) : build(year, first, second);
  }
  const named = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(value);
  if (named) {
    const month = MONTHS.indexOf((named[1] as string).slice(0, 3).toLowerCase()) + 1;
    return month > 0 ? build(Number(named[3]), month, Number(named[2])) : null;
  }
  return null;
}

function build(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return formatIso(year, month, day);
}
