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

    // Extract account IBAN
    const acctBlock = extractBlock(stmt, 'Acct');
    if (acctBlock) {
      const iban = extractTagValue(acctBlock, 'IBAN');
      if (iban) {
        result.accountIban = iban;
      }
    }

    // Extract balances
    const balBlocks = extractAllBlocks(stmt, 'Bal');
    for (const bal of balBlocks) {
      const tp = extractBlock(bal, 'Tp');
      const cdOrPrtry = tp ? extractTagValue(tp, 'Cd') || extractTagValue(tp, 'Prtry') : null;
      const amt = extractTagValue(bal, 'Amt');
      const cdtDbtInd = extractTagValue(bal, 'CdtDbtInd');

      if (amt !== null) {
        const amount = parseFloat(amt);
        const signed = cdtDbtInd === 'DBIT' ? -amount : amount;

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

    // Extract entries (transactions)
    const entries = extractAllBlocks(stmt, 'Ntry');

    for (let i = 0; i < entries.length; i++) {
      try {
        const transaction = parseEntry(entries[i]);
        if (transaction) {
          result.transactions.push(transaction);
        }
      } catch (err) {
        result.errors.push({
          message: `Error parsing entry ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Compute date range
    if (result.transactions.length > 0) {
      const dates = result.transactions.map((t) => t.date).sort();
      result.dateRange = { from: dates[0], to: dates[dates.length - 1] };
    }
  } catch (err) {
    result.errors.push({
      message: `Unexpected CAMT.053 parse error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return result;
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

  // Transaction code
  const bankTxCode = extractBlock(entry, 'BkTxCd');
  let transactionCode: string | undefined;
  if (bankTxCode) {
    const domn = extractBlock(bankTxCode, 'Domn');
    if (domn) {
      const cd = extractTagValue(domn, 'Cd');
      const fmly = extractBlock(domn, 'Fmly');
      const fmlyCd = fmly ? extractTagValue(fmly, 'Cd') : null;
      const subFmlyCd = fmly ? extractTagValue(fmly, 'SubFmlyCd') : null;
      transactionCode = [cd, fmlyCd, subFmlyCd].filter(Boolean).join('-');
    }
  }

  // Entry details
  const ntryDtls = extractBlock(entry, 'NtryDtls');
  const txDtls = ntryDtls ? extractBlock(ntryDtls, 'TxDtls') : null;

  let description = '';
  let counterpartyName: string | undefined;
  let counterpartyIban: string | undefined;
  let counterpartyBic: string | undefined;
  let reference: string | undefined;
  let endToEndId: string | undefined;
  let mandateId: string | undefined;
  let externalId: string | undefined;

  if (txDtls) {
    // References
    const refs = extractBlock(txDtls, 'Refs');
    if (refs) {
      endToEndId = extractTagValue(refs, 'EndToEndId') || undefined;
      mandateId = extractTagValue(refs, 'MndtId') || undefined;
      externalId = extractTagValue(refs, 'AcctSvcrRef') || undefined;

      const instrId = extractTagValue(refs, 'InstrId');
      if (instrId && instrId !== 'NOTPROVIDED') {
        reference = instrId;
      }
    }

    // Remittance information (description)
    const rmtInf = extractBlock(txDtls, 'RmtInf');
    if (rmtInf) {
      // Collect all Ustrd (unstructured) values
      const ustrdValues = extractAllTagValues(rmtInf, 'Ustrd');
      if (ustrdValues.length > 0) {
        description = ustrdValues.join(' ');
      }

      // Structured remittance — try to get Ref from CdtrRefInf
      const strd = extractBlock(rmtInf, 'Strd');
      if (strd) {
        const cdtrRefInf = extractBlock(strd, 'CdtrRefInf');
        if (cdtrRefInf) {
          const ref = extractTagValue(cdtrRefInf, 'Ref');
          if (ref && !reference) {
            reference = ref;
          }
        }
      }
    }

    // Related parties (counterparty)
    const rltdPties = extractBlock(txDtls, 'RltdPties');
    if (rltdPties) {
      // For credits, counterparty is the debtor; for debits, the creditor
      const partyBlock = cdtDbtInd === 'DBIT'
        ? extractBlock(rltdPties, 'Cdtr') || extractBlock(rltdPties, 'Dbtr')
        : extractBlock(rltdPties, 'Dbtr') || extractBlock(rltdPties, 'Cdtr');

      if (partyBlock) {
        counterpartyName = extractTagValue(partyBlock, 'Nm') || undefined;
      }

      // Counterparty account
      const acctBlock = cdtDbtInd === 'DBIT'
        ? extractBlock(rltdPties, 'CdtrAcct') || extractBlock(rltdPties, 'DbtrAcct')
        : extractBlock(rltdPties, 'DbtrAcct') || extractBlock(rltdPties, 'CdtrAcct');

      if (acctBlock) {
        const id = extractBlock(acctBlock, 'Id');
        if (id) {
          counterpartyIban = extractTagValue(id, 'IBAN') || undefined;
        }
      }
    }

    // Related agents (BIC)
    const rltdAgts = extractBlock(txDtls, 'RltdAgts');
    if (rltdAgts) {
      const agtBlock = cdtDbtInd === 'DBIT'
        ? extractBlock(rltdAgts, 'CdtrAgt') || extractBlock(rltdAgts, 'DbtrAgt')
        : extractBlock(rltdAgts, 'DbtrAgt') || extractBlock(rltdAgts, 'CdtrAgt');

      if (agtBlock) {
        const finInstnId = extractBlock(agtBlock, 'FinInstnId');
        if (finInstnId) {
          counterpartyBic = extractTagValue(finInstnId, 'BIC') || extractTagValue(finInstnId, 'BICFI') || undefined;
        }
      }
    }
  }

  // Fallback: if no description from TxDtls, try AddtlNtryInf
  if (!description) {
    description = extractTagValue(entry, 'AddtlNtryInf') || '';
  }

  // Fallback external ID from entry-level AcctSvcrRef
  if (!externalId) {
    externalId = extractTagValue(entry, 'AcctSvcrRef') || undefined;
  }

  // Filter out NOTPROVIDED sentinels
  if (endToEndId === 'NOTPROVIDED') endToEndId = undefined;

  return {
    date,
    valueDate: valueDate || undefined,
    description,
    amount: signedAmount,
    counterpartyName,
    counterpartyIban,
    counterpartyBic,
    reference,
    transactionCode,
    endToEndId,
    mandateId,
    externalId,
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
