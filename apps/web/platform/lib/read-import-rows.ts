/**
 * Reading an uploaded CSV/Excel file into rows for an importer.
 *
 * Every cell comes back as text the way the file holds it. SheetJS would
 * otherwise turn number-like CSV text into numbers and print them back in
 * Excel's General format: `007` became `7`, `+31612345678` lost its plus, and
 * `+919740822531` became `9.19741E+11`.
 */

import * as XLSX from 'xlsx';

/** First sheet of a CSV/Excel file as one object per row, keyed by header. */
export function readImportRows(data: ArrayBuffer | Uint8Array): Record<string, unknown>[] {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // `raw` keeps CSV/TSV cells as the text in the file; it has no effect on .xlsx.
  const wb = XLSX.read(bytes, { type: 'array', raw: true, cellDates: true, cellNF: false, cellText: false });
  const sheet = wb.Sheets[wb.SheetNames[0]!];
  if (!sheet) throw new Error('The file contains no sheets');
  keepWholeNumbers(sheet);
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    raw: false,
    defval: '',
    blankrows: false,
  });
}

/**
 * An Excel cell typed as a number (a phone or an ID) is printed in General
 * format, which shortens 12+ digits to `9.19741E+11`. Give whole numbers their
 * exact digits instead; decimals and dates print as before.
 */
function keepWholeNumbers(sheet: XLSX.WorkSheet): void {
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith('!')) continue;
    const c = cell as XLSX.CellObject;
    if (c.t === 'n' && Number.isSafeInteger(c.v)) c.w = String(c.v);
  }
}
