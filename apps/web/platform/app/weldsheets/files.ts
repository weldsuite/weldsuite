/**
 * Spreadsheet files on the platform side: downloads written in the browser
 * from the open workbook (so edits not saved yet are in them), and making
 * sense of a failed import.
 */

import { isApiError } from '@weldsuite/api-client';
import { ImportError, writeCsv, writeXlsx, type Engine, type FormatLocale } from '@weldsuite/sheets-engine';
import type { SheetImportFailure } from '@weldsuite/app-api-client/schemas/sheets';

/** What the import file picker offers. */
export const IMPORT_ACCEPT = [
  '.xlsx',
  '.csv',
  '.tsv',
  '.txt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/tab-separated-values',
].join(',');

/** Files WeldSheets can open, by name (WeldDrive offers "Open in WeldSheets" for these). */
export function isImportable(fileName: string): boolean {
  return /\.(xlsx|csv|tsv)$/i.test(fileName);
}

/** A name that is safe as a downloaded file's name on every system. */
export function fileNameFor(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Spreadsheet';
}

/** Hands the browser a file to save. */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a moment to start before the URL goes.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function downloadXlsx(engine: Engine, name: string, locale: FormatLocale): Promise<void> {
  const bytes = await writeXlsx(engine, { locale });
  saveFile(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileNameFor(name)}.xlsx`);
}

/** One tab as CSV; the byte-order mark makes Excel read it as UTF-8. */
export function downloadCsv(engine: Engine, sheetId: string, name: string, locale: FormatLocale): void {
  const tab = engine.workbook.getSheet(sheetId)?.name;
  const csv = `\uFEFF${writeCsv(engine, sheetId, { locale })}`;
  const title = tab ? `${name} - ${tab}` : name;
  saveFile(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${fileNameFor(title)}.csv`);
}

/** Why an import failed, from sheets-api's answer or from the engine (the preview reads files itself). */
export function importFailure(err: unknown): SheetImportFailure | null {
  if (err instanceof ImportError) return err.code;
  if (!isApiError(err)) return null;
  const reason = (err.body as { error?: { details?: { reason?: unknown } } } | undefined)?.error?.details?.reason;
  return typeof reason === 'string' ? (reason as SheetImportFailure) : null;
}
