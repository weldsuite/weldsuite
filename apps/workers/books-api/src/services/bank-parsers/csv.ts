import type { BankFileParseResult, ParsedBankTransaction } from './types';

/**
 * Parse the Dutch bank CSV exports (ING, ABN AMRO, Rabobank) and, for older callers, a generic header-matched layout.
 * Anything else goes through the explicit-format parser in csv-format.ts.
 */
export function parseCSV(content: string): BankFileParseResult {
  const result: BankFileParseResult = {
    format: 'csv',
    transactions: [],
    errors: [],
  };

  try {
    const normalized = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim();
    if (!normalized) {
      result.errors.push({ message: 'Empty CSV file' });
      return result;
    }

    const lines = normalized.split('\n');
    if (lines.length < 2) {
      result.errors.push({ message: 'CSV file has no data rows' });
      return result;
    }

    // Detect format
    const format = detectCSVFormat(lines[0], lines.length > 1 ? lines[1] : '');

    switch (format) {
      case 'ing':
        parseINGCSV(lines, result);
        break;
      case 'abn':
        parseABNCSV(lines, result);
        break;
      case 'rabo':
        parseRaboCSV(lines, result);
        break;
      default:
        parseGenericCSV(lines, result);
        break;
    }

    // Compute date range
    if (result.transactions.length > 0) {
      const dates = result.transactions.map((t) => t.date).filter(Boolean).sort((a, b) => (a < b ? -1 : Number(a > b)));
      if (dates.length > 0) {
        result.dateRange = { from: dates[0], to: dates.at(-1)! };
      }
    }
  } catch (err) {
    result.errors.push({
      message: `Unexpected CSV parse error: ${errorMessage(err)}`,
    });
  }

  return result;
}

type CSVFormat = 'ing' | 'abn' | 'rabo' | 'generic';

function detectCSVFormat(headerLine: string, dataLine: string): CSVFormat {
  const headerLower = headerLine.toLowerCase();

  // ING: "Datum","Naam / Omschrijving","Rekening","Tegenrekening","Code","Af Bij","Bedrag (EUR)","Mutatiesoort","Mededelingen"
  if (headerLower.includes('naam / omschrijving') || headerLower.includes('af bij') || headerLower.includes('mutatiesoort')) {
    return 'ing';
  }

  // ABN AMRO: tab-separated, no header, fields: accountNumber, currency, date, balanceBefore, balanceAfter, valueDate, amount, description
  if (headerLine.includes('\t') && !headerLine.startsWith('"')) {
    const tabs = headerLine.split('\t');
    if (tabs.length >= 7) {
      // Check if first field looks like an account number and third field looks like a date
      if (/^\d{9,}$/.test(tabs[0].trim()) || /^[A-Z]{2}\d{2}/.test(tabs[0].trim())) {
        return 'abn';
      }
    }
  }

  // Rabobank: IBAN, currency, date, amount, ...
  if (headerLower.includes('iban') && (headerLower.includes('tegenrekening iban') || headerLower.includes('naam tegenpartij'))) {
    return 'rabo';
  }

  // Also check data line for ABN AMRO (it has no header)
  if (dataLine.includes('\t')) {
    const tabs = dataLine.split('\t');
    if (tabs.length >= 7 && /^[A-Z]{2}\d{2}/.test(tabs[0].trim())) {
      return 'abn';
    }
  }

  return 'generic';
}

/**
 * The Dutch bank export this file is (ING, ABN AMRO, Rabobank), or null when
 * its layout is not a known bank format. Known layouts need no explicit
 * `CsvFormat`; every other CSV does (see csv-format.ts).
 */
export function knownBankCsv(content: string): 'ing' | 'abn' | 'rabo' | null {
  const lines = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim().split('\n');
  if (lines.length < 2) return null;
  const format = detectCSVFormat(lines[0], lines[1]);
  return format === 'generic' ? null : format;
}

// --- Shared row helpers ---

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lower-cased, trimmed header cells of the first line. */
function readHeaders(headerLine: string, separator: string): string[] {
  return parseCSVLine(headerLine, separator).map((h) => h.toLowerCase().trim());
}

/**
 * Run `parseRow` over every non-blank line from `startIndex`. A row that throws is reported as an
 * error (1-based line number) and skipped; a row that returns null was already reported/ignored.
 */
function parseDataRows(
  lines: string[],
  startIndex: number,
  result: BankFileParseResult,
  parseRow: (line: string, lineNo: number) => ParsedBankTransaction | null,
): void {
  for (let i = startIndex; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    try {
      const transaction = parseRow(lines[i], i + 1);
      if (transaction) {
        result.transactions.push(transaction);
      }
    } catch (err) {
      result.errors.push({
        line: i + 1,
        message: `Error parsing row: ${errorMessage(err)}`,
      });
    }
  }
}

/** Account IBAN from the given column of the first data row. */
function applyAccountIbanFromFirstRow(
  result: BankFileParseResult,
  lines: string[],
  separator: string,
  column: number,
): void {
  if (column === -1 || lines.length <= 1) return;
  const value = parseCSVLine(lines[1], separator)[column];
  if (value) {
    result.accountIban = value.replaceAll(/\s/g, '');
  }
}

/** Parse the date column of a row; reports an "Invalid date" error and returns null when unreadable. */
function readRequiredDate(
  fields: string[],
  column: number,
  lineNo: number,
  result: BankFileParseResult,
): string | null {
  const date = parseDate(fields[column] || '');
  if (!date) {
    result.errors.push({ line: lineNo, message: `Invalid date: ${fields[column]}` });
  }
  return date;
}

/** Text of an optional column (undefined when the column is absent or the cell empty). */
function optionalText(fields: string[], column: number): string | undefined {
  return column !== -1 ? fields[column] || undefined : undefined;
}

/** IBAN of an optional column with whitespace removed. */
function optionalIban(fields: string[], column: number): string | undefined {
  return column !== -1 ? fields[column]?.replaceAll(/\s/g, '') || undefined : undefined;
}

/** Date of an optional column. */
function optionalDate(fields: string[], column: number): string | undefined {
  return column !== -1 ? parseDate(fields[column] || '') || undefined : undefined;
}

/** Running balance of an optional column (only when the cell is non-empty). */
function optionalBalance(fields: string[], column: number): number | undefined {
  return column !== -1 && fields[column] ? parseAmount(fields[column]) : undefined;
}

/** Amount of an optional column (0 when the column is absent or empty). */
function amountOrZero(fields: string[], column: number): number {
  return column !== -1 ? parseAmount(fields[column] || '0') : 0;
}

// --- ING CSV Parser ---

function ingColumns(headers: string[]) {
  return {
    date: findColumn(headers, ['datum']),
    name: findColumn(headers, ['naam / omschrijving', 'naam/omschrijving']),
    account: findColumn(headers, ['rekening']),
    counterAccount: findColumn(headers, ['tegenrekening']),
    code: findColumn(headers, ['code']),
    afBij: findColumn(headers, ['af bij']),
    amount: findColumn(headers, ['bedrag (eur)', 'bedrag']),
    type: findColumn(headers, ['mutatiesoort']),
    description: findColumn(headers, ['mededelingen']),
  };
}

type IngColumns = ReturnType<typeof ingColumns>;

function parseINGRow(
  fields: string[],
  lineNo: number,
  colIdx: IngColumns,
  result: BankFileParseResult,
): ParsedBankTransaction | null {
  const date = readRequiredDate(fields, colIdx.date, lineNo, result);
  if (!date) return null;

  let amount = parseAmount(fields[colIdx.amount] || '0');
  // ING uses "Af"/"Bij" to indicate debit/credit
  if (colIdx.afBij !== -1) {
    const afBij = (fields[colIdx.afBij] || '').toLowerCase().trim();
    amount = afBij === 'af' ? -Math.abs(amount) : Math.abs(amount);
  }

  const description = optionalText(fields, colIdx.description) ?? '';

  return {
    date,
    description,
    amount,
    counterpartyName: optionalText(fields, colIdx.name),
    counterpartyIban: optionalIban(fields, colIdx.counterAccount),
    // Try to extract reference from description
    reference: extractReferenceFromText(description),
    transactionCode: optionalText(fields, colIdx.code),
    rawData: { format: 'ing', line: lineNo },
  };
}

function parseINGCSV(lines: string[], result: BankFileParseResult): void {
  const separator = detectSeparator(lines[0]);
  const colIdx = ingColumns(readHeaders(lines[0], separator));

  if (colIdx.date === -1 || colIdx.amount === -1) {
    result.errors.push({ message: 'Could not identify required ING CSV columns' });
    return;
  }

  applyAccountIbanFromFirstRow(result, lines, separator, colIdx.account);

  parseDataRows(lines, 1, result, (line, lineNo) =>
    parseINGRow(parseCSVLine(line, separator), lineNo, colIdx, result),
  );
}

// --- ABN AMRO CSV Parser ---

function parseABNRow(
  line: string,
  lineNo: number,
  result: BankFileParseResult,
): ParsedBankTransaction | null {
  const fields = line.split('\t').map((f) => f.trim());
  if (fields.length < 7) {
    result.errors.push({ line: lineNo, message: `Expected at least 7 tab-separated fields, got ${fields.length}` });
    return null;
  }

  const accountNumber = fields[0];
  if (lineNo === 1 && accountNumber) {
    result.accountIban = accountNumber.replaceAll(/\s/g, '');
  }

  const date = parseDate(fields[2]);
  if (!date) {
    result.errors.push({ line: lineNo, message: `Invalid date: ${fields[2]}` });
    return null;
  }

  const description = fields[7] || '';

  // ABN AMRO description often contains structured data with counterparty info
  const counterparty = extractCounterpartyFromABN(description);

  return {
    date,
    valueDate: parseDate(fields[5]) || undefined,
    description,
    amount: parseAmount(fields[6]),
    runningBalance: fields[4] ? parseAmount(fields[4]) : undefined,
    counterpartyName: counterparty.name,
    counterpartyIban: counterparty.iban,
    reference: counterparty.reference,
    rawData: { format: 'abn', line: lineNo },
  };
}

function parseABNCSV(lines: string[], result: BankFileParseResult): void {
  // ABN AMRO: tab-separated, no header row
  // Fields: accountNumber, currency, date (YYYYMMDD), balanceBefore, balanceAfter, valueDate, amount, description
  parseDataRows(lines, 0, result, (line, lineNo) => parseABNRow(line, lineNo, result));
}

function extractCounterpartyFromABN(description: string): {
  name?: string;
  iban?: string;
  reference?: string;
} {
  const result: { name?: string; iban?: string; reference?: string } = {};

  // Try to find IBAN in description
  const ibanMatch = /\b([A-Z]{2}\d{2}[A-Z0-9]{4}\d{7,})\b/.exec(description);
  if (ibanMatch) {
    result.iban = ibanMatch[1];
  }

  // Try to extract name (often before IBAN or after specific markers)
  // `\s?` (not `\s*`) before the IBAN country code: two or more spaces already
  // end the name through the first branch, and the overlap made this quadratic.
  const nameMatch = /^([A-Z][A-Za-z\s.'-]+?)(?:\s{2,}|\s?[A-Z]{2}\d{2})/.exec(description);
  if (nameMatch) {
    result.name = nameMatch[1].trim();
  }

  result.reference = extractReferenceFromText(description);
  return result;
}

// --- Rabobank CSV Parser ---

function raboColumns(headers: string[]) {
  return {
    iban: findColumn(headers, ['iban/bban', 'iban']),
    currency: findColumn(headers, ['munt', 'currency']),
    date: findColumn(headers, ['datum', 'boekdatum', 'date']),
    valueDate: findColumn(headers, ['rentedatum', 'value date']),
    amount: findColumn(headers, ['bedrag', 'amount']),
    counterName: findColumn(headers, ['naam tegenpartij', 'tegenpartij']),
    counterIban: findColumn(headers, ['tegenrekening iban', 'tegenrekening']),
    counterBic: findColumn(headers, ['bic tegenpartij']),
    description: findColumn(headers, ['omschrijving-1', 'omschrijving', 'description']),
    description2: findColumn(headers, ['omschrijving-2']),
    description3: findColumn(headers, ['omschrijving-3']),
    reference: findColumn(headers, ['betalingskenmerk', 'payment reference']),
    code: findColumn(headers, ['code']),
    endToEndId: findColumn(headers, ['id van de transactie', 'end to end id']),
    mandateId: findColumn(headers, ['machtigingsid', 'mandate id']),
    balance: findColumn(headers, ['saldo na trn', 'balance after']),
  };
}

type RaboColumns = ReturnType<typeof raboColumns>;

function parseRaboRow(
  fields: string[],
  lineNo: number,
  colIdx: RaboColumns,
  result: BankFileParseResult,
): ParsedBankTransaction | null {
  const date = readRequiredDate(fields, colIdx.date, lineNo, result);
  if (!date) return null;

  // Build description from multiple columns
  const description = [colIdx.description, colIdx.description2, colIdx.description3]
    .map((column) => optionalText(fields, column))
    .filter(Boolean)
    .join(' ')
    .trim();

  return {
    date,
    valueDate: optionalDate(fields, colIdx.valueDate),
    description,
    amount: parseAmount(fields[colIdx.amount] || '0'),
    runningBalance: optionalBalance(fields, colIdx.balance),
    counterpartyName: optionalText(fields, colIdx.counterName),
    counterpartyIban: optionalIban(fields, colIdx.counterIban),
    counterpartyBic: optionalText(fields, colIdx.counterBic),
    reference: optionalText(fields, colIdx.reference),
    transactionCode: optionalText(fields, colIdx.code),
    endToEndId: optionalText(fields, colIdx.endToEndId),
    mandateId: optionalText(fields, colIdx.mandateId),
    rawData: { format: 'rabo', line: lineNo },
  };
}

function parseRaboCSV(lines: string[], result: BankFileParseResult): void {
  const separator = detectSeparator(lines[0]);
  const colIdx = raboColumns(readHeaders(lines[0], separator));

  if (colIdx.date === -1 || colIdx.amount === -1) {
    result.errors.push({ message: 'Could not identify required Rabobank CSV columns' });
    return;
  }

  applyAccountIbanFromFirstRow(result, lines, separator, colIdx.iban);

  parseDataRows(lines, 1, result, (line, lineNo) =>
    parseRaboRow(parseCSVLine(line, separator), lineNo, colIdx, result),
  );
}

// --- Generic CSV Parser ---

function genericColumns(headers: string[]) {
  // Try to find common column names
  return {
    date: findColumn(headers, ['date', 'datum', 'boekdatum', 'booking date', 'transaction date']),
    valueDate: findColumn(headers, ['value date', 'rentedatum', 'valutering']),
    description: findColumn(headers, ['description', 'omschrijving', 'mededelingen', 'memo', 'narrative']),
    amount: findColumn(headers, ['amount', 'bedrag', 'transaction amount']),
    credit: findColumn(headers, ['credit', 'bij', 'credit amount']),
    debit: findColumn(headers, ['debit', 'af', 'debit amount']),
    balance: findColumn(headers, ['balance', 'saldo', 'running balance']),
    counterName: findColumn(headers, ['counterparty', 'naam', 'name', 'beneficiary', 'tegenpartij']),
    counterIban: findColumn(headers, ['counterparty iban', 'tegenrekening', 'account']),
    reference: findColumn(headers, ['reference', 'referentie', 'betalingskenmerk']),
  };
}

type GenericColumns = ReturnType<typeof genericColumns>;

function parseGenericRow(
  fields: string[],
  lineNo: number,
  colIdx: GenericColumns,
  result: BankFileParseResult,
): ParsedBankTransaction | null {
  const date = readRequiredDate(fields, colIdx.date, lineNo, result);
  if (!date) return null;

  const amount =
    colIdx.amount !== -1
      ? parseAmount(fields[colIdx.amount] || '0')
      : amountOrZero(fields, colIdx.credit) - amountOrZero(fields, colIdx.debit);

  return {
    date,
    valueDate: optionalDate(fields, colIdx.valueDate),
    description: optionalText(fields, colIdx.description) ?? '',
    amount,
    runningBalance: optionalBalance(fields, colIdx.balance),
    counterpartyName: optionalText(fields, colIdx.counterName),
    counterpartyIban: optionalIban(fields, colIdx.counterIban),
    reference: optionalText(fields, colIdx.reference),
    rawData: { format: 'generic', line: lineNo },
  };
}

function parseGenericCSV(lines: string[], result: BankFileParseResult): void {
  const separator = detectSeparator(lines[0]);
  const colIdx = genericColumns(readHeaders(lines[0], separator));

  if (colIdx.date === -1) {
    result.errors.push({ message: 'Could not identify date column in CSV' });
    return;
  }

  if (colIdx.amount === -1 && colIdx.credit === -1 && colIdx.debit === -1) {
    result.errors.push({ message: 'Could not identify amount column(s) in CSV' });
    return;
  }

  parseDataRows(lines, 1, result, (line, lineNo) =>
    parseGenericRow(parseCSVLine(line, separator), lineNo, colIdx, result),
  );
}

// --- Utility functions ---

function detectSeparator(line: string): string {
  const commaCount = (line.match(/,/g) || []).length;
  const semicolonCount = (line.match(/;/g) || []).length;
  const tabCount = (line.match(/\t/g) || []).length;

  if (tabCount > commaCount && tabCount > semicolonCount) return '\t';
  if (semicolonCount > commaCount) return ';';
  return ',';
}

/**
 * Parse a CSV line respecting quoted fields.
 */
function parseCSVLine(line: string, separator: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (inQuotes && char === '"') {
      if (line[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i += 2;
      } else {
        // End of quoted field
        inQuotes = false;
        i++;
      }
    } else if (!inQuotes && char === '"') {
      inQuotes = true;
      i++;
    } else if (!inQuotes && line.substring(i, i + separator.length) === separator) {
      fields.push(current);
      current = '';
      i += separator.length;
    } else {
      current += char;
      i++;
    }
  }

  fields.push(current);
  return fields;
}

function findColumn(headers: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const idx = headers.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  // Partial match
  for (const candidate of candidates) {
    const idx = headers.findIndex((h) => h.includes(candidate));
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Parse various date formats into ISO YYYY-MM-DD.
 * Supported: YYYYMMDD, YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, MM/DD/YYYY (if unambiguous)
 */
function parseDate(value: string): string | null {
  const trimmed = value.trim().replaceAll('"', '');
  if (!trimmed) return null;

  // YYYYMMDD
  let match = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  // YYYY-MM-DD
  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  // DD-MM-YYYY or DD/MM/YYYY (European format, common in Dutch banks)
  match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(trimmed);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    // Assume DD-MM-YYYY for European banks
    return `${year}-${month}-${day}`;
  }

  // YYYY/MM/DD
  match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(trimmed);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  return null;
}

/**
 * Parse amount string, handling Dutch number format (comma as decimal, dot as thousands).
 */
function parseAmount(value: string): number {
  let cleaned = value.trim().replaceAll('"', '');
  if (!cleaned) return 0;

  // Remove currency symbols and whitespace
  cleaned = cleaned.replaceAll(/[€$£\s]/g, '');

  // Handle Dutch format: 1.234,56 → 1234.56
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // If comma comes after dot, it's the decimal separator (European)
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    if (lastComma > lastDot) {
      cleaned = cleaned.replaceAll('.', '').replace(',', '.');
    } else {
      // US format: 1,234.56
      cleaned = cleaned.replaceAll(',', '');
    }
  } else if (cleaned.includes(',')) {
    // Only comma — treat as decimal separator
    cleaned = cleaned.replace(',', '.');
  }

  const num = Number.parseFloat(cleaned);
  return Number.isNaN(num) ? 0 : num;
}

/**
 * Try to extract a payment reference (betalingskenmerk) from free text.
 * Dutch payment references are typically 16 digits.
 */
function extractReferenceFromText(text: string): string | undefined {
  // 16-digit structured payment reference (betalingskenmerk)
  const refMatch = /\b(\d{16})\b/.exec(text);
  if (refMatch) return refMatch[1];

  // Shorter reference patterns
  const kwMatch = /(?:kenmerk|ref(?:erentie)?|reference)[:\s]*([A-Za-z0-9-]+)/i.exec(text);
  if (kwMatch) return kwMatch[1];

  return undefined;
}
