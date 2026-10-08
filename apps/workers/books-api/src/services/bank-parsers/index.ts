import type { BankFileFormat, BankFileParseResult, BankParseOptions } from './types';
import { CsvFormatRequiredError } from './types';
import { parseMT940 } from './mt940';
import { parseCAMT053 } from './camt053';
import { knownBankCsv, parseCSV } from './csv';
import { detectCsvFormat, parseCsvWithFormat } from './csv-format';
import { parseOfx } from './ofx';
import { parseBai2 } from './bai2';

export type {
  BankFileFormat,
  BankFileParseResult,
  BankParseOptions,
  CsvFormat,
  CsvFormatProposal,
  ParsedBankTransaction,
  ParsedStatementAccount,
} from './types';
export { BANK_FILE_FORMATS, CsvFormatRequiredError } from './types';
export { parseMT940 } from './mt940';
export { parseCAMT053 } from './camt053';
export { parseCSV } from './csv';
export { detectCsvFormat, parseCsvWithFormat } from './csv-format';
export { parseOfx } from './ofx';
export { parseBai2 } from './bai2';

/**
 * Detect the statement format and parse it. `format` forces one; otherwise the
 * file's content decides, and its extension only tells .qfx / .qbo from .ofx.
 *
 * A CSV needs an explicit layout (`options.csvFormat`) unless it is one of the
 * known Dutch bank exports; without one this throws `CsvFormatRequiredError`
 * carrying a proposed layout for the user to confirm.
 */
export function parseBankFile(
  content: string,
  format?: BankFileFormat,
  options: BankParseOptions = {},
): BankFileParseResult {
  const text = content.replace(/^﻿/, '');
  let detected = format ?? detectFormat(text, options.fileName);
  // OFX, QFX and QBO are one format; the extension says which dialect the user exported.
  if (detected === 'ofx') {
    const extension = extensionOf(options.fileName);
    if (extension === 'qfx' || extension === 'qbo') detected = extension;
  }

  switch (detected) {
    case 'mt940':
      return parseMT940(text);
    case 'camt053':
      return parseCAMT053(text);
    case 'ofx':
    case 'qfx':
    case 'qbo':
      return parseOfx(text, { format: detected, accountLast4: options.accountLast4 });
    case 'bai2':
      return parseBai2(text, { accountLast4: options.accountLast4 });
    default:
      return parseCsv(text, options);
  }
}

function parseCsv(content: string, options: BankParseOptions): BankFileParseResult {
  if (options.csvFormat) return parseCsvWithFormat(content, options.csvFormat);
  if (knownBankCsv(content)) return parseCSV(content);
  const proposal = detectCsvFormat(content);
  throw new CsvFormatRequiredError(
    'This CSV has no known bank layout. Confirm the date order, number format and columns, then import again.',
    proposal,
  );
}

function extensionOf(fileName: string | undefined): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName ?? '');
  return match ? match[1].toLowerCase() : '';
}

export function detectFormat(content: string, fileName?: string): BankFileFormat {
  const trimmed = content.trimStart();

  // MT940: starts with :20: or contains characteristic tags
  if (trimmed.startsWith(':20:') || /^:60[FM]:/m.test(trimmed)) {
    return 'mt940';
  }

  // CAMT.053: XML with BkToCstmrStmt or Document namespace
  if (
    trimmed.includes('<BkToCstmrStmt') ||
    trimmed.includes('<Document') ||
    trimmed.includes('camt.053')
  ) {
    return 'camt053';
  }

  // OFX 1.x starts with an OFXHEADER block, 2.x with an <?OFX ...?> instruction; both hold an <OFX> element.
  if (/^OFXHEADER:/i.test(trimmed) || /<\?OFX\b/i.test(trimmed.slice(0, 600)) || /<OFX[\s>]/i.test(trimmed)) {
    const extension = extensionOf(fileName);
    return extension === 'qfx' || extension === 'qbo' ? extension : 'ofx';
  }

  // BAI2: a 01 file header record followed by 02/03 records, each ending in '/'.
  if (/^01,[^\n]*\/\s*$/m.test(trimmed) && /^0[23],/m.test(trimmed)) {
    return 'bai2';
  }

  return 'csv';
}
