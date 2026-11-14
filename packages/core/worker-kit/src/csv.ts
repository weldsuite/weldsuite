/**
 * CSV for export routes and mailed reports: RFC 4180 quoting, CRLF line
 * breaks, a UTF-8 byte order mark (so Excel reads accents correctly) and a
 * guard against spreadsheet formula injection.
 *
 * A text a spreadsheet would run as a formula (`=`, `+`, `@`, a tab or a
 * return at the start, or a `-` that is not a plain number) gets a leading
 * quote. Numbers are written as they are, so a negative number stays one.
 */

export type CsvCell = string | number | boolean | null | undefined;

/** A text a spreadsheet would run as a formula gets a leading quote. */
export function neutralizeCsvText(value: string): string {
  const risky = /^[=+@\t\r]/.test(value) || (/^-/.test(value) && !/^-?\d+(\.\d+)?$/.test(value));
  return risky ? `'${value}` : value;
}

function quote(text: string): string {
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One cell as CSV text; `null` and `undefined` are empty. */
export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return quote(neutralizeCsvText(value));
}

/** The CSV document of a header row and data rows. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvCell[]>): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** A CSV download. The filename is reduced to letters, digits, dot, dash and underscore. */
export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    },
  });
}
