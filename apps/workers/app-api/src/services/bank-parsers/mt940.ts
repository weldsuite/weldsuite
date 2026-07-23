import type { BankFileParseResult, ParsedBankTransaction } from './types';

/**
 * Parse MT940 (SWIFT) bank statement format.
 * Handles Dutch bank formats: ING, ABN AMRO, Rabobank.
 */
export function parseMT940(content: string): BankFileParseResult {
  const result: BankFileParseResult = {
    format: 'mt940',
    transactions: [],
    errors: [],
  };

  try {
    // Normalise line endings
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Split into individual statements (separated by :20: tags or -)
    const statements = splitStatements(normalized);

    for (const statement of statements) {
      parseStatement(statement, result);
    }

    // Compute date range
    if (result.transactions.length > 0) {
      const dates = result.transactions.map((t) => t.date).sort();
      result.dateRange = { from: dates[0], to: dates[dates.length - 1] };
    }
  } catch (err) {
    result.errors.push({
      message: `Unexpected MT940 parse error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return result;
}

function splitStatements(content: string): string[] {
  // MT940 statements can be delimited by :20: tags
  // We treat the entire content as potentially multiple statements separated by :20:
  const parts = content.split(/(?=^:20:)/m);
  return parts.filter((p) => p.trim().length > 0);
}

function parseStatement(statement: string, result: BankFileParseResult): void {
  const lines = statement.split('\n');
  const tags: Array<{ tag: string; value: string; lineNum: number }> = [];

  // Parse tags - MT940 tags start with : at beginning of line
  let currentTag: { tag: string; value: string; lineNum: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tagMatch = line.match(/^:(\d{2}[A-Z]?):(.*)$/);

    if (tagMatch) {
      if (currentTag) {
        tags.push(currentTag);
      }
      currentTag = { tag: tagMatch[1], value: tagMatch[2], lineNum: i + 1 };
    } else if (currentTag && line.trim() !== '' && !line.startsWith('-')) {
      // Continuation line
      currentTag.value += '\n' + line;
    }
  }
  if (currentTag) {
    tags.push(currentTag);
  }

  // Extract account IBAN from :25:
  const tag25 = tags.find((t) => t.tag === '25');
  if (tag25) {
    const iban = extractIban(tag25.value);
    if (iban) {
      result.accountIban = iban;
    }
  }

  // Extract opening balance from :60F: or :60M:
  const tag60 = tags.find((t) => t.tag === '60F' || t.tag === '60M');
  if (tag60) {
    const balance = parseBalanceTag(tag60.value);
    if (balance !== null) {
      result.openingBalance = balance;
    }
  }

  // Extract closing balance from :62F: or :62M:
  const tag62 = tags.find((t) => t.tag === '62F' || t.tag === '62M');
  if (tag62) {
    const balance = parseBalanceTag(tag62.value);
    if (balance !== null) {
      result.closingBalance = balance;
    }
  }

  // Parse :61: and :86: pairs
  for (let i = 0; i < tags.length; i++) {
    if (tags[i].tag === '61') {
      const tag61 = tags[i];
      // The next tag might be :86: with transaction details
      const tag86 = i + 1 < tags.length && tags[i + 1].tag === '86' ? tags[i + 1] : null;

      const transaction = parseTransaction(tag61, tag86, result.errors);
      if (transaction) {
        result.transactions.push(transaction);
      }
    }
  }
}

/**
 * Parse :61: statement line.
 * Format: YYMMDD[MMDD]C/DamountSNNNreference//bank-reference\nmore-info
 * Example: 2301150115C1234,56N029NONREF//BANK-REF-123
 */
function parseTransaction(
  tag61: { value: string; lineNum: number },
  tag86: { value: string; lineNum: number } | null,
  errors: BankFileParseResult['errors'],
): ParsedBankTransaction | null {
  const line = tag61.value.replace(/\n/g, '');

  // Match the :61: line format
  // Date: 6 digits YYMMDD, optional entry date 4 digits MMDD
  // C/D indicator: C, D, RC (reversal credit), RD (reversal debit)
  // Amount: digits with comma as decimal separator
  // Transaction type: S/N/F + 3 chars
  // Reference and bank reference
  const match = line.match(
    /^(\d{6})(\d{4})?(R?[CD])([A-Z]?)(\d+,\d*)(S|N|F)(\d{3})(.*)$/,
  );

  if (!match) {
    errors.push({ line: tag61.lineNum, message: `Cannot parse :61: line: ${line.substring(0, 80)}` });
    return null;
  }

  const [, dateStr, entryDateStr, cdIndicator, , amountStr, , typeCode, remainder] = match;

  // Parse date
  const date = parseMT940Date(dateStr);
  if (!date) {
    errors.push({ line: tag61.lineNum, message: `Invalid date in :61: line: ${dateStr}` });
    return null;
  }

  // Parse value date from entry date if present
  let valueDate: string | undefined;
  if (entryDateStr) {
    const year = dateStr.substring(0, 2);
    valueDate = parseMT940Date(year + entryDateStr) || undefined;
  }

  // Parse amount
  const amount = parseFloat(amountStr.replace(',', '.'));
  const signedAmount = cdIndicator === 'D' || cdIndicator === 'RD' ? -amount : amount;

  // Parse reference from remainder
  // Format: reference//bank-reference
  let reference: string | undefined;
  let externalId: string | undefined;

  const refParts = remainder.split('//');
  if (refParts.length >= 1) {
    const ref = refParts[0].trim();
    if (ref && ref !== 'NONREF') {
      reference = ref;
    }
  }
  if (refParts.length >= 2) {
    externalId = refParts[1].trim();
  }

  // Parse :86: information
  let description = '';
  let counterpartyName: string | undefined;
  let counterpartyIban: string | undefined;
  let counterpartyBic: string | undefined;
  let endToEndId: string | undefined;
  let mandateId: string | undefined;
  let rawTag86: string | undefined;

  if (tag86) {
    rawTag86 = tag86.value;
    const info = parseTag86(tag86.value);
    description = info.description;
    counterpartyName = info.counterpartyName;
    counterpartyIban = info.counterpartyIban;
    counterpartyBic = info.counterpartyBic;
    endToEndId = info.endToEndId;
    mandateId = info.mandateId;
    if (info.reference && !reference) {
      reference = info.reference;
    }
  }

  return {
    date,
    valueDate,
    description,
    amount: signedAmount,
    counterpartyName,
    counterpartyIban,
    counterpartyBic,
    reference,
    transactionCode: typeCode,
    endToEndId,
    mandateId,
    externalId,
    rawData: rawTag86 ? { tag86: rawTag86 } : undefined,
  };
}

/**
 * Parse :86: tag content.
 * Dutch banks use various sub-field formats:
 * - Slash-separated: /CNTP/name/iban/bic//  /REMI/description  /EREF/end-to-end-id
 * - ING format: free text with >nn sub-fields
 * - Simple free text
 */
function parseTag86(value: string): {
  description: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyBic?: string;
  reference?: string;
  endToEndId?: string;
  mandateId?: string;
} {
  const result: ReturnType<typeof parseTag86> = { description: '' };

  // Normalise multiline to single string
  const text = value.replace(/\n/g, '');

  // Try structured format with /XXX/ sub-fields (ABN AMRO, Rabobank style)
  if (text.includes('/CNTP/') || text.includes('/REMI/') || text.includes('/EREF/')) {
    return parseStructuredTag86(text);
  }

  // Try ING format with >nn sub-fields
  if (text.match(/>(\d{2})/)) {
    return parseINGTag86(text);
  }

  // Plain text fallback
  result.description = text.trim();

  // Try to extract IBAN from description
  const ibanMatch = text.match(/\b([A-Z]{2}\d{2}[A-Z0-9]{4}\d{7,})\b/);
  if (ibanMatch) {
    result.counterpartyIban = ibanMatch[1];
  }

  return result;
}

function parseStructuredTag86(text: string): ReturnType<typeof parseTag86> {
  const result: ReturnType<typeof parseTag86> = { description: '' };

  // Extract /CNTP/ counterparty block: /CNTP/iban/bic/name/city/
  const cntpMatch = text.match(/\/CNTP\/([^/]*)\/([^/]*)\/([^/]*)\/([^/]*)\//);
  if (cntpMatch) {
    if (cntpMatch[1]) result.counterpartyIban = cntpMatch[1].trim();
    if (cntpMatch[2]) result.counterpartyBic = cntpMatch[2].trim();
    if (cntpMatch[3]) result.counterpartyName = cntpMatch[3].trim();
  }

  // Extract /REMI/ remittance info
  const remiMatch = text.match(/\/REMI\/(?:USTD\/\/)?([^/]*(?:\/[^/]*)*?)(?=\/[A-Z]{4}\/|$)/);
  if (remiMatch) {
    result.description = remiMatch[1].trim();
  }

  // Extract /EREF/ end-to-end reference
  const erefMatch = text.match(/\/EREF\/([^/]+)/);
  if (erefMatch) {
    result.endToEndId = erefMatch[1].trim();
  }

  // Extract /MARF/ mandate reference
  const marfMatch = text.match(/\/MARF\/([^/]+)/);
  if (marfMatch) {
    result.mandateId = marfMatch[1].trim();
  }

  // Extract /PREF/ or /KREF/ payment reference
  const prefMatch = text.match(/\/(?:PREF|KREF)\/([^/]+)/);
  if (prefMatch) {
    result.reference = prefMatch[1].trim();
  }

  // If no description from REMI, use the full text minus structured fields
  if (!result.description) {
    result.description = text
      .replace(/\/[A-Z]{4}\/[^/]*/g, '')
      .trim() || text.trim();
  }

  return result;
}

function parseINGTag86(text: string): ReturnType<typeof parseTag86> {
  const result: ReturnType<typeof parseTag86> = { description: '' };
  const fields: Record<string, string> = {};

  // ING uses >nn as sub-field indicators
  // >00 = transaction type description
  // >20-29 = remittance info / description
  // >30 = BIC
  // >31 = counterparty account (IBAN)
  // >32-33 = counterparty name
  // >34 = reference
  const parts = text.split(/>([\d]{2})/);

  for (let i = 1; i < parts.length; i += 2) {
    const code = parts[i];
    const val = (parts[i + 1] || '').trim();
    if (fields[code]) {
      fields[code] += ' ' + val;
    } else {
      fields[code] = val;
    }
  }

  // Build description from >00, >20 through >29
  const descParts: string[] = [];
  if (fields['00']) descParts.push(fields['00']);
  for (let i = 20; i <= 29; i++) {
    const key = String(i);
    if (fields[key]) descParts.push(fields[key]);
  }
  result.description = descParts.join(' ').trim();

  // Counterparty
  if (fields['31']) result.counterpartyIban = fields['31'].replace(/\s/g, '');
  if (fields['30']) result.counterpartyBic = fields['30'];
  const nameParts: string[] = [];
  if (fields['32']) nameParts.push(fields['32']);
  if (fields['33']) nameParts.push(fields['33']);
  if (nameParts.length > 0) result.counterpartyName = nameParts.join(' ').trim();

  // Reference
  if (fields['34']) result.reference = fields['34'];

  return result;
}

/**
 * Parse MT940 balance tag value.
 * Format: C/DYYMMDDCURRENCYAMOUNT
 * Example: C230115EUR1234,56
 */
function parseBalanceTag(value: string): number | null {
  const match = value.match(/^(C|D)(\d{6})([A-Z]{3})(\d+,\d*)$/);
  if (!match) return null;

  const [, cd, , , amountStr] = match;
  const amount = parseFloat(amountStr.replace(',', '.'));
  return cd === 'D' ? -amount : amount;
}

function parseMT940Date(yymmdd: string): string | null {
  if (yymmdd.length < 6) return null;
  const yy = parseInt(yymmdd.substring(0, 2), 10);
  const mm = yymmdd.substring(2, 4);
  const dd = yymmdd.substring(4, 6);

  // Y2K window: 00-79 = 2000s, 80-99 = 1900s
  const year = yy < 80 ? 2000 + yy : 1900 + yy;

  const monthNum = parseInt(mm, 10);
  const dayNum = parseInt(dd, 10);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;

  return `${year}-${mm}-${dd}`;
}

function extractIban(value: string): string | null {
  // :25: may contain IBAN directly or in format BANKCODE/ACCOUNTNUMBER
  const cleaned = value.replace(/\s/g, '').replace(/\n/g, '');
  const ibanMatch = cleaned.match(/([A-Z]{2}\d{2}[A-Z0-9]{4}\d{7,})/);
  return ibanMatch ? ibanMatch[1] : null;
}
