/**
 * Spreadsheet files: reading .xlsx, .csv and .tsv into a workbook snapshot,
 * and writing .xlsx and .csv. Everything here is built in-house (ADR
 * SHEETS-002) on the platform's compression streams.
 */

import { readCsv, type ReadCsvOptions } from './csv';
import { ImportError, type ImportResult, type ReadXlsxOptions } from './types';
import { readXlsx } from './xlsx/read';
import { decodeText } from './zip';

export type SpreadsheetFormat = 'xlsx' | 'csv' | 'tsv';

/** The format of a file, from its first bytes and its name; null for one WeldSheets cannot read. */
export function spreadsheetFormat(fileName: string, bytes: Uint8Array): SpreadsheetFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (zip) return ext === 'ods' || ext === 'numbers' ? null : 'xlsx';
  // An old binary .xls starts with the OLE compound-file signature.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return null;
  if (ext === 'tsv' || ext === 'tab') return 'tsv';
  if (ext === 'csv' || ext === 'txt') return 'csv';
  return null;
}

export type ReadSpreadsheetOptions = ReadXlsxOptions & Pick<ReadCsvOptions, 'sheetName'>;

/** Reads an .xlsx, .csv or .tsv file. Throws `ImportError` for anything else, or a file it cannot read. */
export async function readSpreadsheet(fileName: string, bytes: Uint8Array, options: ReadSpreadsheetOptions = {}): Promise<ImportResult> {
  const format = spreadsheetFormat(fileName, bytes);
  if (format === 'xlsx') return readXlsx(bytes, options);
  if (format === null) throw new ImportError('WeldSheets opens .xlsx, .csv and .tsv files', 'unsupported');
  const sheetName = options.sheetName ?? fileName.replace(/\.[^.]+$/, '');
  return readCsv(decodeText(bytes), { ...options, sheetName, ...(format === 'tsv' ? { delimiter: '\t' } : {}) });
}
