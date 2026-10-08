/**
 * BAI2 cash-management files (the prior-day and current-day reports business
 * banks send): records 01 file header, 02 group header, 03 account
 * identifier and balances, 16 transaction detail, 88 continuation, 49 account
 * trailer, 98 group trailer, 99 file trailer.
 *
 * Amounts are integers in cents (an implied two decimals). Detail records
 * carry no sign: type codes 100-399 are credits (money in) and 400-699 debits
 * (money out). A transaction's date is the group's as-of date (record 02)
 * unless the record says it is value-dated.
 */

import { cleanText, occurrenceCounter, syntheticExternalId } from './ids';
import type {
  BankFileParseResult,
  ParsedBankTransaction,
  ParsedStatementAccount,
} from './types';

/** Common detail type codes, used when the bank sends no text. */
const TYPE_LABELS: Record<string, string> = {
  '108': 'Credit',
  '115': 'Lockbox deposit',
  '142': 'ACH credit received',
  '165': 'Preauthorized ACH credit',
  '174': 'Other deposit',
  '175': 'Check deposit',
  '195': 'Incoming money transfer',
  '275': 'Online banking deposit',
  '399': 'Miscellaneous credit',
  '408': 'Debit',
  '451': 'ACH debit received',
  '475': 'Check paid',
  '495': 'Outgoing money transfer',
  '501': 'Preauthorized ACH debit',
  '555': 'Debit in lieu of check',
  '698': 'Miscellaneous fee',
  '699': 'Miscellaneous debit',
};

/** "YYMMDD" → "YYYY-MM-DD" (two-digit years are 20YY). */
export function parseBai2Date(value: string | undefined): string | null {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec((value ?? '').trim());
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `20${match[1]}-${match[2]}-${match[3]}`;
}

/** Cents as an amount; a decimal point (some banks send one) is honoured. */
export function parseBai2Amount(value: string | undefined): number | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  if (/^[+-]?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) / 100;
  if (/^[+-]?\d*\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  return null;
}

interface Bai2Record {
  code: string;
  fields: string[];
  line: number;
}

/** Join physical lines into records: a record ends at '/', and 88 lines continue the one before. */
function readRecords(content: string): Bai2Record[] {
  const records: Bai2Record[] = [];
  const lines = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  let open: { code: string; body: string; line: number } | null = null;

  const close = () => {
    if (!open) return;
    const body = open.body.replace(/\/\s*$/, '');
    records.push({ code: open.code, fields: body.split(','), line: open.line });
    open = null;
  };

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('88,') && open) {
      // The continuation's fields carry on the previous record's.
      open.body = `${open.body.replace(/\/\s*$/, '')},${line.slice(3)}`;
    } else if (/^\d{2},/.test(line)) {
      close();
      open = { code: line.slice(0, 2), body: line, line: index + 1 };
    } else if (open) {
      open.body += line; // a record wrapped in the middle of a field
    }
  });
  close();
  return records;
}

interface StatusItem {
  typeCode: string;
  amount: number | null;
}

/** Skip the extra fields a funds-availability type brings along. */
function fundsExtra(fields: string[], at: number, fundsType: string): number {
  switch (fundsType.toUpperCase()) {
    case 'S':
      return 3;
    case 'V':
      return 2;
    case 'D': {
      const count = Number.parseInt(fields[at] ?? '0', 10);
      return 1 + (Number.isFinite(count) ? count * 2 : 0);
    }
    default:
      return 0;
  }
}

/** Record 03 after the account number and currency: repeated type code, amount, item count, funds type. */
function readStatusItems(fields: string[]): StatusItem[] {
  const items: StatusItem[] = [];
  let i = 3;
  while (i < fields.length) {
    const typeCode = (fields[i] ?? '').trim();
    if (!typeCode) {
      i += 1;
      continue;
    }
    const fundsType = fields[i + 3] ?? '';
    items.push({ typeCode, amount: parseBai2Amount(fields[i + 1]) });
    i += 4 + fundsExtra(fields, i + 4, fundsType);
  }
  return items;
}

interface AccountSection {
  account: ParsedStatementAccount;
  transactions: ParsedBankTransaction[];
  openingBalance?: number;
  closingBalance?: number;
  availableBalance?: number;
  balanceDate?: string;
}

function isCredit(typeCode: string): boolean | null {
  const code = Number.parseInt(typeCode, 10);
  if (code >= 100 && code <= 399) return true;
  if (code >= 400 && code <= 699) return false;
  return null;
}

function readDetail(
  record: Bai2Record,
  group: { asOfDate: string | null; currency?: string },
  nextOccurrence: (key: string) => number,
  accountNumber: string,
  errors: BankFileParseResult['errors'],
): ParsedBankTransaction | null {
  const f = record.fields;
  const typeCode = (f[1] ?? '').trim();
  const cents = parseBai2Amount(f[2]);
  const fundsType = (f[3] ?? '').trim();
  if (!typeCode || cents === null) {
    errors.push({ line: record.line, message: 'Transaction record without a type code or amount' });
    return null;
  }
  const credit = isCredit(typeCode);
  if (credit === null) {
    errors.push({ line: record.line, message: `Skipped transaction with unsupported type code ${typeCode}` });
    return null;
  }

  let at = 4;
  let valueDate: string | undefined;
  if (fundsType.toUpperCase() === 'V') {
    valueDate = parseBai2Date(f[4]) ?? undefined;
    at += 2;
  } else {
    at += fundsExtra(f, at, fundsType);
  }
  const bankReference = cleanText(f[at]);
  const customerReference = cleanText(f[at + 1]);
  const detail = cleanText(f.slice(at + 2).join(' '));

  const date = group.asOfDate;
  if (!date) {
    errors.push({ line: record.line, message: 'Transaction record without an as-of date on its group' });
    return null;
  }

  const amount = Math.abs(cents) * (credit ? 1 : -1);
  const description = detail || TYPE_LABELS[typeCode] || `BAI type ${typeCode}`;
  const checkNumber = typeCode === '475' ? (/^\d{1,10}$/.test(customerReference) ? customerReference : /^\d{1,10}$/.test(bankReference) ? bankReference : undefined) : undefined;

  const key = [accountNumber, date, typeCode, amount.toFixed(2), bankReference, customerReference, description].join('|');
  return {
    date,
    ...(valueDate && valueDate !== date ? { valueDate } : {}),
    description,
    amount,
    reference: customerReference || bankReference || undefined,
    transactionCode: typeCode,
    checkNumber,
    externalId: syntheticExternalId(
      'bai2',
      [accountNumber, date, typeCode, amount.toFixed(2), bankReference, customerReference, description],
      nextOccurrence(key),
    ),
    rawData: { format: 'bai2', typeCode, bankReference: bankReference || null, customerReference: customerReference || null },
  };
}

function last4(value: string | undefined): string | undefined {
  const cleaned = (value ?? '').replaceAll(/[^0-9A-Za-z]/g, '');
  return cleaned.length >= 4 ? cleaned.slice(-4).toLowerCase() : undefined;
}

export function parseBai2(content: string, options: { accountLast4?: string } = {}): BankFileParseResult {
  const result: BankFileParseResult = { format: 'bai2', transactions: [], errors: [] };

  try {
    const records = readRecords(content.replace(/^﻿/, ''));
    if (!records.some((r) => r.code === '01')) {
      result.errors.push({ message: 'Not a BAI2 file: no 01 file header record' });
      return result;
    }

    const sections: AccountSection[] = [];
    const errors: BankFileParseResult['errors'] = [];
    const nextOccurrence = occurrenceCounter();
    let group: { asOfDate: string | null; currency?: string } = { asOfDate: null };
    let section: AccountSection | null = null;

    for (const record of records) {
      const f = record.fields;
      switch (record.code) {
        case '02':
          group = { asOfDate: parseBai2Date(f[4]), currency: (f[6] ?? '').trim().toUpperCase() || undefined };
          break;
        case '03': {
          const accountNumber = (f[1] ?? '').trim();
          const currency = (f[2] ?? '').trim().toUpperCase() || group.currency;
          section = { account: { accountNumber: accountNumber || undefined, currency }, transactions: [] };
          section.balanceDate = group.asOfDate ?? undefined;
          for (const item of readStatusItems(f)) {
            if (item.amount === null) continue;
            if (item.typeCode === '010') section.openingBalance = item.amount;
            else if (item.typeCode === '015') section.closingBalance = item.amount;
            else if (item.typeCode === '045') section.availableBalance = item.amount;
          }
          sections.push(section);
          break;
        }
        case '16':
          if (!section) {
            errors.push({ line: record.line, message: 'Transaction record outside an account' });
            break;
          }
          {
            const txn = readDetail(record, group, nextOccurrence, section.account.accountNumber ?? '', errors);
            if (txn) section.transactions.push(txn);
          }
          break;
        case '49':
          section = null;
          break;
        default:
          break;
      }
    }

    if (sections.length === 0) {
      result.errors.push({ message: 'No account records (03) found in this BAI2 file' });
      return result;
    }
    result.accounts = sections.map((s) => s.account);

    const selected = selectSection(sections, options.accountLast4, result);
    if (!selected) return result;

    result.account = selected.account;
    result.currency = selected.account.currency;
    result.transactions = selected.transactions;
    result.errors.push(...errors);
    if (selected.openingBalance !== undefined) result.openingBalance = selected.openingBalance;
    if (selected.closingBalance !== undefined) result.closingBalance = selected.closingBalance;
    if (selected.availableBalance !== undefined) result.availableBalance = selected.availableBalance;
    if (selected.balanceDate) result.balanceDate = selected.balanceDate;
    if (result.transactions.length > 0) {
      const dates = result.transactions.map((t) => t.date).sort((a, b) => a.localeCompare(b));
      result.dateRange = { from: dates[0], to: dates.at(-1)! };
    }
  } catch (err) {
    result.errors.push({ message: `Unexpected BAI2 parse error: ${err instanceof Error ? err.message : String(err)}` });
  }
  return result;
}

function selectSection(
  sections: AccountSection[],
  accountLast4: string | undefined,
  result: BankFileParseResult,
): AccountSection | null {
  if (sections.length === 1) return sections[0];
  const wanted = accountLast4?.toLowerCase();
  const match = wanted ? sections.find((s) => last4(s.account.accountNumber) === wanted) : undefined;
  if (match) return match;
  const ends = sections.map((s) => last4(s.account.accountNumber) ?? '?').join(', ');
  result.errors.push({
    message: wanted
      ? `This file holds ${sections.length} accounts (ending ${ends}); none ends in ${wanted}`
      : `This file holds ${sections.length} accounts (ending ${ends}); set the account number on the bank account so the right one can be picked`,
  });
  return null;
}
