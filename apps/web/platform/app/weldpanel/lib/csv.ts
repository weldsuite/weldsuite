/**
 * "Export CSV" for every WeldPanel result: rows of plain values → a CSV file
 * the browser downloads. One helper so every view writes the same dialect:
 * a UTF-8 byte order mark (Excel then reads accents right), a header row from
 * the first row's keys, CRLF line ends, RFC 4180 quoting, and text that a
 * spreadsheet would run as a formula (`=`, `+`, `-`, `@` …) prefixed with `'`.
 */

export type CsvValue = string | number | null;
export type CsvRow = Record<string, CsvValue>;

/** What a view hands the chart card's "Export CSV" button. */
export interface CsvExport {
  /** Without the extension; see {@link csvFilename}. */
  filename: string;
  rows: CsvRow[];
}

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Every key that appears in any row, in first-seen order. */
export function csvColumns(rows: readonly CsvRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) seen.add(key);
  return [...seen];
}

/** The CSV text (with its byte order mark). No rows: an empty file with just the mark. */
export function toCsv(rows: readonly CsvRow[]): string {
  const columns = csvColumns(rows);
  if (columns.length === 0) return BOM;
  const lines = [columns.map((c) => cell(c)).join(',')];
  for (const row of rows) lines.push(columns.map((c) => cell(row[c])).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** `--a-b--` → `a-b`: the hyphens at either end dropped (a loop, not a backtracking regex). */
function trimHyphens(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === '-') start++;
  while (end > start && text[end - 1] === '-') end--;
  return text.slice(start, end);
}

/**
 * A file name from a report (or page) name and a date: `Signups by week` on
 * 3 March 2026 → `signups-by-week-2026-03-03`. Characters a file system
 * refuses are dropped; an empty name becomes `weldpanel`.
 */
export function csvFilename(name: string, date: Date = new Date()): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  const slug = trimHyphens(words).slice(0, 80);
  const day = date.toISOString().slice(0, 10);
  return `${slug || 'weldpanel'}-${day}`;
}

/** Downloads `rows` as `<filename>.csv`. */
export function downloadCsv({ filename, rows }: CsvExport): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Let the click start the download before the object URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
