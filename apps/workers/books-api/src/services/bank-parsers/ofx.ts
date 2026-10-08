/**
 * OFX / QFX / QBO statements.
 *
 * Reads both dialects: OFX 1.x is SGML (leaf elements without closing tags,
 * a plain-text header) and 2.x is XML. QFX (Quicken) and QBO (QuickBooks) are
 * OFX files with extra vendor tags; only the extension tells them apart.
 *
 * Amounts are signed from the account holder's side: a bank deposit and a
 * card payment are positive, a withdrawal and a card purchase negative. That
 * is the convention of bank_transactions, so nothing is flipped here.
 */

import { cleanText, occurrenceCounter, syntheticExternalId } from './ids';
import type {
  BankFileParseResult,
  ParsedBankTransaction,
  ParsedStatementAccount,
} from './types';

interface OfxNode {
  name: string;
  value?: string;
  children: OfxNode[];
}

/** Elements that hold other elements; an empty-valued tag outside this list is a blank leaf. */
const AGGREGATES = new Set([
  'OFX', 'SIGNONMSGSRSV1', 'SONRS', 'STATUS', 'FI',
  'BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS', 'BANKACCTFROM', 'BANKACCTTO', 'BANKTRANLIST', 'STMTTRN',
  'CREDITCARDMSGSRSV1', 'CCSTMTTRNRS', 'CCSTMTRS', 'CCACCTFROM', 'CCACCTTO',
  'LEDGERBAL', 'AVAILBAL', 'PAYEE', 'BALLIST', 'BAL', 'INVSTMTMSGSRSV1', 'INVSTMTTRNRS', 'INVSTMTRS',
  'INVACCTFROM', 'INVTRANLIST', 'LOANMSGSRSV1', 'SECLISTMSGSRSV1', 'BANKMSGSET', 'CREDITCARDMSGSET',
]);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function stripCdata(text: string): string {
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(text.trim());
  return cdata ? cdata[1] : text;
}

/** Build an element tree from SGML or XML markup (everything from `<OFX>` on). */
function parseTree(markup: string): OfxNode {
  const root: OfxNode = { name: '#root', children: [] };
  const stack: OfxNode[] = [root];
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9_.]*)\s*>([^<]*)/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(markup)) !== null) {
    const name = match[2].toUpperCase();
    if (match[1]) {
      // A closing tag ends the nearest open aggregate of that name; the closing
      // tag of a leaf element (XML) has nothing open and is ignored.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const value = decodeEntities(stripCdata(match[3])).trim();
    const node: OfxNode = { name, children: [] };
    stack[stack.length - 1].children.push(node);
    if (value) node.value = value;
    else if (AGGREGATES.has(name)) stack.push(node);
  }
  return root;
}

function findAll(node: OfxNode, name: string, found: OfxNode[] = []): OfxNode[] {
  for (const child of node.children) {
    if (child.name === name) found.push(child);
    findAll(child, name, found);
  }
  return found;
}

function child(node: OfxNode | undefined, name: string): OfxNode | undefined {
  return node?.children.find((c) => c.name === name);
}

function text(node: OfxNode | undefined, name: string): string | undefined {
  const value = child(node, name)?.value;
  return value ? value : undefined;
}

/** `YYYYMMDD[HHMMSS[.XXX]][TZ]` as a calendar date; the time and zone are dropped, never applied. */
export function parseOfxDate(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** OFX amounts use '.' or ',' as the decimal mark and never a thousands separator. */
export function parseOfxAmount(value: string | undefined): number | null {
  if (!value) return null;
  let cleaned = value.trim().replaceAll(/\s/g, '');
  if (cleaned.includes(',') && !cleaned.includes('.')) cleaned = cleaned.replace(',', '.');
  if (!/^[+-]?\d+(\.\d*)?$|^[+-]?\.\d+$/.test(cleaned)) return null;
  const number = Number.parseFloat(cleaned);
  return Number.isFinite(number) ? number : null;
}

const ACCOUNT_TYPES: Record<string, string> = {
  CHECKING: 'checking',
  SAVINGS: 'savings',
  MONEYMRKT: 'money_market',
  CREDITLINE: 'line_of_credit',
};

interface Section {
  account: ParsedStatementAccount;
  isCard: boolean;
  transactions: ParsedBankTransaction[];
  errors: BankFileParseResult['errors'];
  closingBalance?: number;
  availableBalance?: number;
  balanceDate?: string;
}

function sectionAccount(section: OfxNode, isCard: boolean): ParsedStatementAccount {
  const from = child(section, isCard ? 'CCACCTFROM' : 'BANKACCTFROM');
  const type = text(from, 'ACCTTYPE')?.toUpperCase();
  return {
    routingNumber: text(from, 'BANKID'),
    accountNumber: text(from, 'ACCTID'),
    accountType: isCard ? 'credit_card' : type ? ACCOUNT_TYPES[type] : undefined,
    currency: text(section, 'CURDEF')?.toUpperCase(),
  };
}

function transactionText(txn: OfxNode): { name?: string; description: string } {
  const name = text(txn, 'NAME') ?? text(child(txn, 'PAYEE'), 'NAME') ?? text(txn, 'EXTDNAME');
  const memo = text(txn, 'MEMO');
  const parts: string[] = [];
  if (name) parts.push(cleanText(name));
  // Banks often repeat the name in the memo; keep the memo only when it adds something.
  if (memo && !(name && cleanText(memo).toLowerCase() === cleanText(name).toLowerCase())) parts.push(cleanText(memo));
  return { name: name ? cleanText(name) : undefined, description: parts.join(' - ') };
}

function parseTransaction(
  txn: OfxNode,
  index: number,
  nextOccurrence: (key: string) => number,
  errors: BankFileParseResult['errors'],
): ParsedBankTransaction | null {
  const date = parseOfxDate(text(txn, 'DTPOSTED'));
  const amount = parseOfxAmount(text(txn, 'TRNAMT'));
  if (!date || amount === null) {
    errors.push({ message: `Transaction ${index + 1}: missing or unreadable ${date ? 'TRNAMT' : 'DTPOSTED'}` });
    return null;
  }

  const { name, description } = transactionText(txn);
  const type = text(txn, 'TRNTYPE')?.toUpperCase();
  const checkNumber = text(txn, 'CHECKNUM');
  const reference = text(txn, 'REFNUM') ?? text(txn, 'SRVRTID');

  // The same FITID twice in one file is two real lines (some banks reuse them): keep both.
  const fitid = text(txn, 'FITID');
  let externalId: string;
  if (fitid) {
    const occurrence = nextOccurrence(`fitid|${fitid}`);
    externalId = occurrence > 1 ? `${fitid}#${occurrence}` : fitid;
  } else {
    const key = [date, amount.toFixed(2), name, description].join('|');
    externalId = syntheticExternalId('ofx', [date, amount.toFixed(2), name, description, checkNumber], nextOccurrence(key));
  }

  const valueDate = parseOfxDate(text(txn, 'DTUSER') ?? text(txn, 'DTAVAIL'));
  return {
    date,
    ...(valueDate && valueDate !== date ? { valueDate } : {}),
    description: description || type || '',
    amount,
    counterpartyName: name,
    reference,
    transactionCode: type,
    checkNumber,
    externalId,
    rawData: { format: 'ofx', trnType: type, fitid: fitid ?? null },
  };
}

function parseSection(node: OfxNode, isCard: boolean): Section {
  const account = sectionAccount(node, isCard);
  const errors: BankFileParseResult['errors'] = [];
  const tranList = child(node, 'BANKTRANLIST');
  const nextOccurrence = occurrenceCounter();
  const transactions: ParsedBankTransaction[] = [];
  (tranList?.children ?? [])
    .filter((c) => c.name === 'STMTTRN')
    .forEach((txn, index) => {
      const parsed = parseTransaction(txn, index, nextOccurrence, errors);
      if (parsed) transactions.push(parsed);
    });

  const ledger = child(node, 'LEDGERBAL');
  const available = child(node, 'AVAILBAL');
  return {
    account,
    isCard,
    transactions,
    errors,
    closingBalance: parseOfxAmount(text(ledger, 'BALAMT')) ?? undefined,
    availableBalance: parseOfxAmount(text(available, 'BALAMT')) ?? undefined,
    balanceDate: parseOfxDate(text(ledger, 'DTASOF')) ?? undefined,
  };
}

function last4(value: string | undefined): string | undefined {
  const digits = (value ?? '').replaceAll(/[^0-9A-Za-z]/g, '');
  return digits.length >= 4 ? digits.slice(-4).toLowerCase() : undefined;
}

export function parseOfx(
  content: string,
  options: { format?: 'ofx' | 'qfx' | 'qbo'; accountLast4?: string } = {},
): BankFileParseResult {
  const result: BankFileParseResult = {
    format: options.format ?? 'ofx',
    transactions: [],
    errors: [],
  };

  try {
    const start = content.search(/<OFX[\s>]/i);
    if (start < 0) {
      result.errors.push({ message: 'No <OFX> document found in this file' });
      return result;
    }
    const tree = parseTree(content.slice(start));
    const sections = [
      ...findAll(tree, 'STMTRS').map((n) => parseSection(n, false)),
      ...findAll(tree, 'CCSTMTRS').map((n) => parseSection(n, true)),
    ];
    if (sections.length === 0) {
      result.errors.push({ message: 'No bank or credit card statement found in this OFX file' });
      return result;
    }
    result.accounts = sections.map((s) => s.account);

    const selected = selectSection(sections, options.accountLast4, result);
    if (!selected) return result;

    result.account = selected.account;
    result.currency = selected.account.currency;
    result.transactions = selected.transactions;
    result.errors.push(...selected.errors);
    if (selected.closingBalance !== undefined) result.closingBalance = selected.closingBalance;
    if (selected.availableBalance !== undefined) result.availableBalance = selected.availableBalance;
    if (selected.balanceDate) result.balanceDate = selected.balanceDate;

    if (result.transactions.length > 0) {
      const dates = result.transactions.map((t) => t.date).sort((a, b) => a.localeCompare(b));
      result.dateRange = { from: dates[0], to: dates.at(-1)! };
    }
  } catch (err) {
    result.errors.push({ message: `Unexpected OFX parse error: ${err instanceof Error ? err.message : String(err)}` });
  }
  return result;
}

function selectSection(
  sections: Section[],
  accountLast4: string | undefined,
  result: BankFileParseResult,
): Section | null {
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
