import type { BankFileParseResult, ParsedBankTransaction } from './types';

/**
 * Parse CSV bank statement files.
 * Auto-detects Dutch bank formats: ING, ABN AMRO, Rabobank.
 */
export function parseCSV(content: string): BankFileParseResult {
  const result: BankFileParseResult = {
    format: 'csv',
    transactions: [],
    errors: [],
  };

  try {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
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
      const dates = result.transactions.map((t) => t.date).filter(Boolean).sort();
      if (dates.length > 0) {
        result.dateRange = { from: dates[0], to: dates[dates.length - 1] };
      }
    }
  } catch (err) {
    result.errors.push({
      message: `Unexpected CSV parse error: ${err instanceof Error ? err.message : String(err)}`,
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

// --- ING CSV Parser ---

function parseINGCSV(lines: string[], result: BankFileParseResult): void {
  const separator = detectSeparator(lines[0]);
  const headers = parseCSVLine(lines[0], separator).map((h) => h.toLowerCase().trim());

  const colIdx = {
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

  if (colIdx.date === -1 || colIdx.amount === -1) {
    result.errors.push({ message: 'Could not identify required ING CSV columns' });
    return;
  }

  // Account IBAN from first data row
  if (colIdx.account !== -1 && lines.length > 1) {
    const firstRow = parseCSVLine(lines[1], separator);
    if (firstRow[colIdx.account]) {
      result.accountIban = firstRow[colIdx.account].replace(/\s/g, '');
    }
  }

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const fields = parseCSVLine(lines[i], separator);
    try {
      const date = parseDate(fields[colIdx.date] || '');
      if (!date) {
        result.errors.push({ line: i + 1, message: `Invalid date: ${fields[colIdx.date]}` });
        continue;
      }

      let amount = parseAmount(fields[colIdx.amount] || '0');
      // ING uses "Af"/"Bij" to indicate debit/credit
      if (colIdx.afBij !== -1) {
        const afBij = (fields[colIdx.afBij] || '').toLowerCase().trim();
        if (afBij === 'af') {
          amount = -Math.abs(amount);
        } else {
          amount = Math.abs(amount);
        }
      }

      const counterpartyName = colIdx.name !== -1 ? fields[colIdx.name] || undefined : undefined;
      const counterpartyIban = colIdx.counterAccount !== -1 ? fields[colIdx.counterAccount]?.replace(/\s/g, '') || undefined : undefined;
      const description = colIdx.description !== -1 ? fields[colIdx.description] || '' : '';
      const transactionCode = colIdx.code !== -1 ? fields[colIdx.code] || undefined : undefined;

      // Try to extract reference from description
      const reference = extractReferenceFromText(description);

      result.transactions.push({
        date,
        description,
        amount,
        counterpartyName: counterpartyName || undefined,
        counterpartyIban: counterpartyIban || undefined,
        reference,
        transactionCode,
        rawData: { format: 'ing', line: i + 1 },
      });
    } catch (err) {
      result.errors.push({
        line: i + 1,
        message: `Error parsing row: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

// --- ABN AMRO CSV Parser ---

function parseABNCSV(lines: string[], result: BankFileParseResult): void {
  // ABN AMRO: tab-separated, no header row
  // Fields: accountNumber, currency, date (YYYYMMDD), balanceBefore, balanceAfter, valueDate, amount, description

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const fields = lines[i].split('\t').map((f) => f.trim());
    if (fields.length < 7) {
      result.errors.push({ line: i + 1, message: `Expected at least 7 tab-separated fields, got ${fields.length}` });
      continue;
    }

    try {
      const accountNumber = fields[0];
      if (i === 0 && accountNumber) {
        result.accountIban = accountNumber.replace(/\s/g, '');
      }

      const date = parseDate(fields[2]);
      if (!date) {
        result.errors.push({ line: i + 1, message: `Invalid date: ${fields[2]}` });
        continue;
      }

      const valueDate = parseDate(fields[5]) || undefined;
      const amount = parseAmount(fields[6]);
      const description = fields[7] || '';

      // ABN AMRO description often contains structured data with counterparty info
      const counterparty = extractCounterpartyFromABN(description);

      const runningBalance = fields[4] ? parseAmount(fields[4]) : undefined;

      result.transactions.push({
        date,
        valueDate,
        description,
        amount,
        runningBalance,
        counterpartyName: counterparty.name,
        counterpartyIban: counterparty.iban,
        reference: counterparty.reference,
        rawData: { format: 'abn', line: i + 1 },
      });
    } catch (err) {
      result.errors.push({
        line: i + 1,
        message: `Error parsing row: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

function extractCounterpartyFromABN(description: string): {
  name?: string;
  iban?: string;
  reference?: string;
} {
  const result: { name?: string; iban?: string; reference?: string } = {};

  // Try to find IBAN in description
  const ibanMatch = description.match(/\b([A-Z]{2}\d{2}[A-Z0-9]{4}\d{7,})\b/);
  if (ibanMatch) {
    result.iban = ibanMatch[1];
  }

  // Try to extract name (often before IBAN or after specific markers)
  const nameMatch = description.match(/^([A-Z][A-Za-z\s.'-]+?)(?:\s{2,}|\s*[A-Z]{2}\d{2})/);
  if (nameMatch) {
    result.name = nameMatch[1].trim();
  }

  result.reference = extractReferenceFromText(description);
  return result;
}

// --- Rabobank CSV Parser ---

function parseRaboCSV(lines: string[], result: BankFileParseResult): void {
  const separator = detectSeparator(lines[0]);
  const headers = parseCSVLine(lines[0], separator).map((h) => h.toLowerCase().trim());

  const colIdx = {
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

  if (colIdx.date === -1 || colIdx.amount === -1) {
    result.errors.push({ message: 'Could not identify required Rabobank CSV columns' });
    return;
  }

  // Account IBAN
  if (colIdx.iban !== -1 && lines.length > 1) {
    const firstRow = parseCSVLine(lines[1], separator);
    if (firstRow[colIdx.iban]) {
      result.accountIban = firstRow[colIdx.iban].replace(/\s/g, '');
    }
  }

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const fields = parseCSVLine(lines[i], separator);
    try {
      const date = parseDate(fields[colIdx.date] || '');
      if (!date) {
        result.errors.push({ line: i + 1, message: `Invalid date: ${fields[colIdx.date]}` });
        continue;
      }

      const valueDate = colIdx.valueDate !== -1 ? parseDate(fields[colIdx.valueDate] || '') || undefined : undefined;
      const amount = parseAmount(fields[colIdx.amount] || '0');

      // Build description from multiple columns
      const descParts: string[] = [];
      if (colIdx.description !== -1 && fields[colIdx.description]) descParts.push(fields[colIdx.description]);
      if (colIdx.description2 !== -1 && fields[colIdx.description2]) descParts.push(fields[colIdx.description2]);
      if (colIdx.description3 !== -1 && fields[colIdx.description3]) descParts.push(fields[colIdx.description3]);
      const description = descParts.join(' ').trim();

      const counterpartyName = colIdx.counterName !== -1 ? fields[colIdx.counterName] || undefined : undefined;
      const counterpartyIban = colIdx.counterIban !== -1 ? fields[colIdx.counterIban]?.replace(/\s/g, '') || undefined : undefined;
      const counterpartyBic = colIdx.counterBic !== -1 ? fields[colIdx.counterBic] || undefined : undefined;
      const reference = colIdx.reference !== -1 ? fields[colIdx.reference] || undefined : undefined;
      const endToEndId = colIdx.endToEndId !== -1 ? fields[colIdx.endToEndId] || undefined : undefined;
      const mandateId = colIdx.mandateId !== -1 ? fields[colIdx.mandateId] || undefined : undefined;
      const transactionCode = colIdx.code !== -1 ? fields[colIdx.code] || undefined : undefined;
      const runningBalance = colIdx.balance !== -1 && fields[colIdx.balance] ? parseAmount(fields[colIdx.balance]) : undefined;

      result.transactions.push({
        date,
        valueDate,
        description,
        amount,
        runningBalance,
        counterpartyName: counterpartyName || undefined,
        counterpartyIban: counterpartyIban || undefined,
        counterpartyBic: counterpartyBic || undefined,
        reference: reference || undefined,
        transactionCode,
        endToEndId: endToEndId || undefined,
        mandateId: mandateId || undefined,
        rawData: { format: 'rabo', line: i + 1 },
      });
    } catch (err) {
      result.errors.push({
        line: i + 1,
        message: `Error parsing row: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

// --- Generic CSV Parser ---

function parseGenericCSV(lines: string[], result: BankFileParseResult): void {
  const separator = detectSeparator(lines[0]);
  const headers = parseCSVLine(lines[0], separator).map((h) => h.toLowerCase().trim());

  // Try to find common column names
  const colIdx = {
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

  if (colIdx.date === -1) {
    result.errors.push({ message: 'Could not identify date column in CSV' });
    return;
  }

  if (colIdx.amount === -1 && colIdx.credit === -1 && colIdx.debit === -1) {
    result.errors.push({ message: 'Could not identify amount column(s) in CSV' });
    return;
  }

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const fields = parseCSVLine(lines[i], separator);
    try {
      const date = parseDate(fields[colIdx.date] || '');
      if (!date) {
        result.errors.push({ line: i + 1, message: `Invalid date: ${fields[colIdx.date]}` });
        continue;
      }

      let amount: number;
      if (colIdx.amount !== -1) {
        amount = parseAmount(fields[colIdx.amount] || '0');
      } else {
        const credit = colIdx.credit !== -1 ? parseAmount(fields[colIdx.credit] || '0') : 0;
        const debit = colIdx.debit !== -1 ? parseAmount(fields[colIdx.debit] || '0') : 0;
        amount = credit - debit;
      }

      const valueDate = colIdx.valueDate !== -1 ? parseDate(fields[colIdx.valueDate] || '') || undefined : undefined;
      const description = colIdx.description !== -1 ? fields[colIdx.description] || '' : '';
      const counterpartyName = colIdx.counterName !== -1 ? fields[colIdx.counterName] || undefined : undefined;
      const counterpartyIban = colIdx.counterIban !== -1 ? fields[colIdx.counterIban]?.replace(/\s/g, '') || undefined : undefined;
      const reference = colIdx.reference !== -1 ? fields[colIdx.reference] || undefined : undefined;
      const runningBalance = colIdx.balance !== -1 && fields[colIdx.balance] ? parseAmount(fields[colIdx.balance]) : undefined;

      result.transactions.push({
        date,
        valueDate,
        description,
        amount,
        runningBalance,
        counterpartyName: counterpartyName || undefined,
        counterpartyIban: counterpartyIban || undefined,
        reference: reference || undefined,
        rawData: { format: 'generic', line: i + 1 },
      });
    } catch (err) {
      result.errors.push({
        line: i + 1,
        message: `Error parsing row: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
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

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          // Escaped quote
          current += '"';
          i += 2;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
        }
      } else {
        current += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (line.substring(i, i + separator.length) === separator) {
        fields.push(current);
        current = '';
        i += separator.length;
      } else {
        current += char;
        i++;
      }
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
  const trimmed = value.trim().replace(/"/g, '');
  if (!trimmed) return null;

  // YYYYMMDD
  let match = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  // YYYY-MM-DD
  match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  // DD-MM-YYYY or DD/MM/YYYY (European format, common in Dutch banks)
  match = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    const day = match[1].padStart(2, '0');
    const month = match[2].padStart(2, '0');
    const year = match[3];
    // Assume DD-MM-YYYY for European banks
    return `${year}-${month}-${day}`;
  }

  // YYYY/MM/DD
  match = trimmed.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  return null;
}

/**
 * Parse amount string, handling Dutch number format (comma as decimal, dot as thousands).
 */
function parseAmount(value: string): number {
  let cleaned = value.trim().replace(/"/g, '');
  if (!cleaned) return 0;

  // Remove currency symbols and whitespace
  cleaned = cleaned.replace(/[€$£\s]/g, '');

  // Handle Dutch format: 1.234,56 → 1234.56
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // If comma comes after dot, it's the decimal separator (European)
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // US format: 1,234.56
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.includes(',')) {
    // Only comma — treat as decimal separator
    cleaned = cleaned.replace(',', '.');
  }

  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Try to extract a payment reference (betalingskenmerk) from free text.
 * Dutch payment references are typically 16 digits.
 */
function extractReferenceFromText(text: string): string | undefined {
  // 16-digit structured payment reference (betalingskenmerk)
  const refMatch = text.match(/\b(\d{16})\b/);
  if (refMatch) return refMatch[1];

  // Shorter reference patterns
  const kwMatch = text.match(/(?:kenmerk|ref(?:erentie)?|reference)[:\s]*([A-Za-z0-9-]+)/i);
  if (kwMatch) return kwMatch[1];

  return undefined;
}
