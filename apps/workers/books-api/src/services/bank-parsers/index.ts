import type { BankFileParseResult } from './types';
import { parseMT940 } from './mt940';
import { parseCAMT053 } from './camt053';
import { parseCSV } from './csv';

export type { ParsedBankTransaction, BankFileParseResult } from './types';
export { parseMT940 } from './mt940';
export { parseCAMT053 } from './camt053';
export { parseCSV } from './csv';

/**
 * Auto-detect the bank statement format and parse it.
 * Optionally accepts a forced format override.
 */
export function parseBankFile(
  content: string,
  format?: 'mt940' | 'camt053' | 'csv',
): BankFileParseResult {
  const detectedFormat = format || detectFormat(content);

  switch (detectedFormat) {
    case 'mt940':
      return parseMT940(content);
    case 'camt053':
      return parseCAMT053(content);
    case 'csv':
      return parseCSV(content);
    default:
      return parseCSV(content);
  }
}

function detectFormat(content: string): 'mt940' | 'camt053' | 'csv' {
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

  return 'csv';
}
