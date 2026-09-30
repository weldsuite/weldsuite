import type { BankFileParseResult, ParsedBankTransaction } from './types';

/**
 * Parse CAMT.053 (ISO 20022) XML bank statement.
 * Uses regex-based XML parsing (no DOM APIs) for Cloudflare Worker compatibility.
 */
export function parseCAMT053(content: string): BankFileParseResult {
  const result: BankFileParseResult = {
    format: 'camt053',
    transactions: [],
    errors: [],
  };

  try {
    // Normalise line endings
    const xml = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Find all Stmt (statement) blocks
    const stmtBlocks = extractAllBlocks(xml, 'Stmt');

    if (stmtBlocks.length === 0) {
      result.errors.push({ message: 'No Stmt blocks found in CAMT.053 document' });
      return result;
    }

    // Process the first statement (most common case)
    const stmt = stmtBlocks[0];

    applyAccountIban(result, stmt);
    applyBalances(result, stmt);
    collectEntries(result, stmt);

    // Compute date range
    if (result.transactions.length > 0) {
      const dates = result.transactions.map((t) => t.date).sort((a, b) => (a < b ? -1 : Number(a > b)));
      result.dateRange = { from: dates[0], to: dates[dates.length - 1] };
    }
  } catch (err) {
    result.errors.push({
      message: `Unexpected CAMT.053 parse error: ${errorMessage(err)}`,
    });
  }

  return result;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract the statement's account IBAN. */
function applyAccountIban(result: BankFileParseResult, stmt: string): void {
  const acctBlock = extractBlock(stmt, 'Acct');
  if (!acctBlock) return;
  const iban = extractTagValue(acctBlock, 'IBAN');
  if (iban) {
    result.accountIban = iban;
  }
}

/** Extract opening / closing balances. */
function applyBalances(result: BankFileParseResult, stmt: string): void {
  for (const bal of extractAllBlocks(stmt, 'Bal')) {
    const tp = extractBlock(bal, 'Tp');
    const cdOrPrtry = tp ? extractTagValue(tp, 'Cd') || extractTagValue(tp, 'Prtry') : null;
    const amt = extractTagValue(bal, 'Amt');
    if (amt === null) continue;

    const amount = parseFloat(amt);
    const signed = extractTagValue(bal, 'CdtDbtInd') === 'DBIT' ? -amount : amount;

    // OPBD = Opening Booked, PRCD = Previous Closing
    if (cdOrPrtry === 'OPBD' || cdOrPrtry === 'PRCD') {
      result.openingBalance = signed;
    }
    // CLBD = Closing Booked
    if (cdOrPrtry === 'CLBD') {
      result.closingBalance = signed;
    }
  }
}

/** Extract entries (transactions), recording a per-entry error instead of aborting. */
function collectEntries(result: BankFileParseResult, stmt: string): void {
  const entries = extractAllBlocks(stmt, 'Ntry');
  for (let i = 0; i < entries.length; i++) {
    try {
      const transaction = parseEntry(entries[i]);
      if (transaction) {
        result.transactions.push(transaction);
      }
    } catch (err) {
      result.errors.push({
        message: `Error parsing entry ${i + 1}: ${errorMessage(err)}`,
      });
    }
  }
}

function parseEntry(entry: string): ParsedBankTransaction | null {
  // Booking date
  const bookgDt = extractBlock(entry, 'BookgDt');
  const date = bookgDt ? extractTagValue(bookgDt, 'Dt') : null;
  if (!date) return null;

  // Value date
  const valDt = extractBlock(entry, 'ValDt');
  const valueDate = valDt ? extractTagValue(valDt, 'Dt') : undefined;

  // Amount
  const amtStr = extractTagValue(entry, 'Amt');
  const amount = amtStr ? parseFloat(amtStr) : 0;

  // Credit/Debit indicator
  const cdtDbtInd = extractTagValue(entry, 'CdtDbtInd');
  const signedAmount = cdtDbtInd === 'DBIT' ? -Math.abs(amount) : Math.abs(amount);

  const transactionCode = parseTransactionCode(entry);

  // Entry details
  const ntryDtls = extractBlock(entry, 'NtryDtls');
  const txDtls = ntryDtls ? extractBlock(ntryDtls, 'TxDtls') : null;
  const details = txDtls ? parseTxDetails(txDtls, cdtDbtInd === 'DBIT') : {};

  // Fallback: if no description from TxDtls, try AddtlNtryInf
  const description = details.description || extractTagValue(entry, 'AddtlNtryInf') || '';

  // Fallback external ID from entry-level AcctSvcrRef
  const externalId = details.externalId || extractTagValue(entry, 'AcctSvcrRef') || undefined;

  // Filter out NOTPROVIDED sentinels
  const endToEndId = details.endToEndId === 'NOTPROVIDED' ? undefined : details.endToEndId;

  return {
    date,
    valueDate: valueDate || undefined,
    description,
    amount: signedAmount,
    counterpartyName: details.counterpartyName,
    counterpartyIban: details.counterpartyIban,
    counterpartyBic: details.counterpartyBic,
    reference: details.reference,
    transactionCode,
    endToEndId,
    mandateId: details.mandateId,
    externalId,
  };
}

interface TxDetails {
  description?: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyBic?: string;
  reference?: string;
  endToEndId?: string;
  mandateId?: string;
  externalId?: string;
}

function parseTransactionCode(entry: string): string | undefined {
  const bankTxCode = extractBlock(entry, 'BkTxCd');
  const domn = bankTxCode ? extractBlock(bankTxCode, 'Domn') : null;
  if (!domn) return undefined;

  const cd = extractTagValue(domn, 'Cd');
  const fmly = extractBlock(domn, 'Fmly');
  const fmlyCd = fmly ? extractTagValue(fmly, 'Cd') : null;
  const subFmlyCd = fmly ? extractTagValue(fmly, 'SubFmlyCd') : null;
  return [cd, fmlyCd, subFmlyCd].filter(Boolean).join('-');
}

/** Pick the first non-empty block: creditor-side first for debits, debtor-side first for credits. */
function extractCounterpartyBlock(
  xml: string,
  isDebit: boolean,
  creditorTag: string,
  debtorTag: string,
): string | null {
  // For credits, counterparty is the debtor; for debits, the creditor
  return isDebit
    ? extractBlock(xml, creditorTag) || extractBlock(xml, debtorTag)
    : extractBlock(xml, debtorTag) || extractBlock(xml, creditorTag);
}

/** References block: end-to-end id, mandate id, external id and instruction id (as reference). */
function parseRefs(txDtls: string): TxDetails {
  const refs = extractBlock(txDtls, 'Refs');
  if (!refs) return {};

  const instrId = extractTagValue(refs, 'InstrId');
  return {
    endToEndId: extractTagValue(refs, 'EndToEndId') || undefined,
    mandateId: extractTagValue(refs, 'MndtId') || undefined,
    externalId: extractTagValue(refs, 'AcctSvcrRef') || undefined,
    reference: instrId && instrId !== 'NOTPROVIDED' ? instrId : undefined,
  };
}

/** Remittance information: unstructured description plus the structured creditor reference. */
function parseRemittance(txDtls: string): { description?: string; structuredRef?: string } {
  const rmtInf = extractBlock(txDtls, 'RmtInf');
  if (!rmtInf) return {};

  // Collect all Ustrd (unstructured) values
  const ustrdValues = extractAllTagValues(rmtInf, 'Ustrd');
  const description = ustrdValues.length > 0 ? ustrdValues.join(' ') : undefined;

  // Structured remittance — try to get Ref from CdtrRefInf
  const strd = extractBlock(rmtInf, 'Strd');
  const cdtrRefInf = strd ? extractBlock(strd, 'CdtrRefInf') : null;
  const structuredRef = cdtrRefInf ? extractTagValue(cdtrRefInf, 'Ref') || undefined : undefined;
  return { description, structuredRef };
}

/** Related parties: counterparty name and IBAN. */
function parseRelatedParties(
  txDtls: string,
  isDebit: boolean,
): Pick<TxDetails, 'counterpartyName' | 'counterpartyIban'> {
  const rltdPties = extractBlock(txDtls, 'RltdPties');
  if (!rltdPties) return {};

  const partyBlock = extractCounterpartyBlock(rltdPties, isDebit, 'Cdtr', 'Dbtr');
  const counterpartyName = partyBlock ? extractTagValue(partyBlock, 'Nm') || undefined : undefined;

  const acctBlock = extractCounterpartyBlock(rltdPties, isDebit, 'CdtrAcct', 'DbtrAcct');
  const id = acctBlock ? extractBlock(acctBlock, 'Id') : null;
  const counterpartyIban = id ? extractTagValue(id, 'IBAN') || undefined : undefined;

  return { counterpartyName, counterpartyIban };
}

/** Related agents: counterparty BIC. */
function parseRelatedAgentBic(txDtls: string, isDebit: boolean): string | undefined {
  const rltdAgts = extractBlock(txDtls, 'RltdAgts');
  if (!rltdAgts) return undefined;

  const agtBlock = extractCounterpartyBlock(rltdAgts, isDebit, 'CdtrAgt', 'DbtrAgt');
  const finInstnId = agtBlock ? extractBlock(agtBlock, 'FinInstnId') : null;
  if (!finInstnId) return undefined;
  return extractTagValue(finInstnId, 'BIC') || extractTagValue(finInstnId, 'BICFI') || undefined;
}

function parseTxDetails(txDtls: string, isDebit: boolean): TxDetails {
  const refs = parseRefs(txDtls);
  const remittance = parseRemittance(txDtls);
  const parties = parseRelatedParties(txDtls, isDebit);

  return {
    ...refs,
    description: remittance.description,
    // The InstrId reference wins; the structured creditor reference is only a fallback.
    reference: refs.reference || remittance.structuredRef,
    ...parties,
    counterpartyBic: parseRelatedAgentBic(txDtls, isDebit),
  };
}

// --- Lightweight XML helpers (no DOM) ---

/**
 * Extract the inner content of the first occurrence of a tag.
 * Handles namespaced tags (ignores namespace prefix).
 */
function extractBlock(xml: string, tagName: string): string | null {
  // Match both <Tag> and <ns:Tag> and <ns2:Tag>
  const openPattern = new RegExp(`<(?:[a-zA-Z0-9]+:)?${escapeRegExp(tagName)}(?:\\s[^>]*)?>`, 's');
  const match = xml.match(openPattern);
  if (!match || match.index === undefined) return null;

  const startIdx = match.index + match[0].length;

  // Find the matching close tag
  const closePattern = new RegExp(`</(?:[a-zA-Z0-9]+:)?${escapeRegExp(tagName)}>`, 's');
  const closeMatch = xml.substring(startIdx).match(closePattern);
  if (!closeMatch || closeMatch.index === undefined) return null;

  return xml.substring(startIdx, startIdx + closeMatch.index);
}

/**
 * Extract all occurrences of a block tag.
 */
function extractAllBlocks(xml: string, tagName: string): string[] {
  const results: string[] = [];
  const openPattern = new RegExp(`<(?:[a-zA-Z0-9]+:)?${escapeRegExp(tagName)}(?:\\s[^>]*)?>`, 'gs');
  const closePattern = new RegExp(`</(?:[a-zA-Z0-9]+:)?${escapeRegExp(tagName)}>`, 'g');

  let openMatch: RegExpExecArray | null;
  while ((openMatch = openPattern.exec(xml)) !== null) {
    const startIdx = openMatch.index + openMatch[0].length;
    closePattern.lastIndex = startIdx;
    const closeMatch = closePattern.exec(xml);
    if (closeMatch) {
      results.push(xml.substring(startIdx, closeMatch.index));
    }
  }

  return results;
}

/**
 * Extract the text value of a simple (leaf) tag.
 */
function extractTagValue(xml: string, tagName: string): string | null {
  const pattern = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${escapeRegExp(tagName)}(?:\\s[^>]*)?>([^<]*)</(?:[a-zA-Z0-9]+:)?${escapeRegExp(tagName)}>`,
    's',
  );
  const match = xml.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * Extract all text values for a given tag name.
 */
function extractAllTagValues(xml: string, tagName: string): string[] {
  const pattern = new RegExp(
    `<(?:[a-zA-Z0-9]+:)?${escapeRegExp(tagName)}(?:\\s[^>]*)?>([^<]*)</(?:[a-zA-Z0-9]+:)?${escapeRegExp(tagName)}>`,
    'gs',
  );
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
