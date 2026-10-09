/**
 * NACHA (ACH) file of PPD credits for US direct deposit: the employer uploads
 * it to its own bank. WeldSuite never moves the money.
 *
 * Layout per Nacha's ACH Guide for Developers
 * (https://achdevguide.nacha.org/ach-file-details and /ach-file-overview):
 * fixed-width ASCII records of exactly 94 characters, blocking factor 10, the
 * last block padded with records of all 9s. One batch:
 *
 *   1 File Header · 5 Batch Header (PPD) · 6 Entry Detail × n · 8 Batch Control · 9 File Control
 *
 * - Transaction codes: 22 checking credit, 32 savings credit; the optional
 *   balanced-file offset is a debit, 27 checking / 37 savings.
 * - Service class: 220 credits only; 200 mixed when the offset debit is added.
 * - Entry hash: the sum of the 8-digit Receiving DFI Identification fields,
 *   keeping the rightmost 10 digits (high-order digits dropped on overflow).
 * - Trace number: the ODFI's first 8 routing digits + a 7-digit ascending
 *   sequence.
 * - Company Entry Description `PAYROLL`: required in the leftmost 7
 *   characters for wage credits to consumer accounts since 20 March 2026
 *   (https://www.nacha.org/rules/risk-management-topics-company-entry-descriptions).
 *   Any other description is replaced.
 * - Immediate origin (file header) carries the company identification; some
 *   banks want their own routing number there instead, which this builder
 *   does not support yet.
 *
 * Text is upper-cased and reduced to ASCII letters, digits and a few
 * punctuation marks. Lines end with `\n`.
 */

import type { GeneratedFile } from './documents';
import type { PayrollIssue } from './types';

export interface NachaOriginator {
  /** Company name as the bank knows it (max 16). */
  companyName: string;
  /** Company identification the bank assigned, 10 chars (often `1` + EIN). */
  companyId: string;
  /** The employer's bank (ODFI) routing number, 9 digits. */
  odfiRouting: string;
  /** The ODFI's name for the file header (max 23). */
  odfiName: string;
}

export interface NachaCredit {
  /** Employee number or payslip id (max 15). */
  individualId: string;
  /** Max 22. */
  individualName: string;
  routingNumber: string;
  accountNumber: string;
  accountType: 'checking' | 'savings';
  amountCents: number;
}

export interface NachaFileInput {
  originator: NachaOriginator;
  /** Settlement date, `YYYY-MM-DD`. */
  effectiveDate: string;
  /** ISO date-time the file was created. */
  createdAt: string;
  /** A–Z / 0–9, distinguishes files created the same day. */
  fileIdModifier?: string;
  /** Batch entry description (max 10), default `PAYROLL`. */
  entryDescription?: string;
  credits: NachaCredit[];
  /** Some banks want a balanced file: one offsetting debit from the employer's account. */
  balancedOffset?: { routingNumber: string; accountNumber: string; accountType: 'checking' | 'savings' } | null;
}

const RECORD_LENGTH = 94;
const BLOCKING_FACTOR = 10;
const MAX_ENTRY_CENTS = 9_999_999_999;

/**
 * ABA routing number check: nine digits, a Federal Reserve prefix
 * (01–12, 21–32, 61–72 or 80), and the checksum
 * 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10).
 */
export function isValidRoutingNumber(routingNumber: string): boolean {
  if (!/^\d{9}$/.test(routingNumber)) return false;
  const prefix = Number(routingNumber.slice(0, 2));
  const knownPrefix = (prefix >= 1 && prefix <= 12) || (prefix >= 21 && prefix <= 32) || (prefix >= 61 && prefix <= 72) || prefix === 80;
  if (!knownPrefix) return false;
  const d = routingNumber.split('').map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

/** DFI account number: 1–17 letters, digits or hyphens (spaces are removed first). */
export function normalizeAccountNumber(accountNumber: string): string | null {
  const compact = accountNumber.replace(/\s+/g, '');
  return /^[A-Za-z0-9-]{1,17}$/.test(compact) ? compact.toUpperCase() : null;
}

/** Upper-case ASCII for alphanumeric fields. */
function text(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 .,&'/()-]/g, ' ');
}

function alpha(value: string, length: number): string {
  return text(value).slice(0, length).padEnd(length, ' ');
}

function numeric(value: number, length: number): string {
  const s = String(Math.trunc(value));
  return s.length > length ? s.slice(s.length - length) : s.padStart(length, '0');
}

function yymmdd(isoDate: string): string {
  return `${isoDate.slice(2, 4)}${isoDate.slice(5, 7)}${isoDate.slice(8, 10)}`;
}

interface Entry {
  transactionCode: '22' | '32' | '27' | '37';
  routingNumber: string;
  accountNumber: string;
  amountCents: number;
  individualId: string;
  individualName: string;
}

export function buildNachaFile(input: NachaFileInput): GeneratedFile & { issues: PayrollIssue[] } {
  const issues: PayrollIssue[] = [];
  const { originator } = input;

  if (!isValidRoutingNumber(originator.odfiRouting)) {
    issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'odfiRouting' } });
  }
  const companyId = originator.companyId.trim();
  if (companyId.length === 0 || companyId.length > 10) {
    issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'companyId' } });
  }
  if (!originator.companyName.trim()) {
    issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'companyName' } });
  }
  const modifier = (input.fileIdModifier ?? 'A').toUpperCase();
  if (!/^[A-Z0-9]$/.test(modifier)) {
    issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'fileIdModifier' } });
  }

  const entries: Entry[] = [];
  for (const credit of input.credits) {
    const individualId = credit.individualId;
    if (!isValidRoutingNumber(credit.routingNumber)) {
      issues.push({ severity: 'error', code: 'invalid_routing_number', params: { individualId } });
      continue;
    }
    const account = normalizeAccountNumber(credit.accountNumber);
    if (!account) {
      issues.push({ severity: 'error', code: 'invalid_account_number', params: { individualId } });
      continue;
    }
    if (!Number.isInteger(credit.amountCents) || credit.amountCents < 0) {
      issues.push({ severity: 'error', code: 'negative_net_pay', params: { individualId, amountCents: credit.amountCents } });
      continue;
    }
    if (credit.amountCents === 0) {
      issues.push({ severity: 'warning', code: 'net_pay_zero', params: { individualId } });
      continue;
    }
    if (credit.amountCents > MAX_ENTRY_CENTS) {
      issues.push({ severity: 'error', code: 'invalid_amount', params: { individualId, amountCents: credit.amountCents } });
      continue;
    }
    entries.push({
      transactionCode: credit.accountType === 'savings' ? '32' : '22',
      routingNumber: credit.routingNumber,
      accountNumber: account,
      amountCents: credit.amountCents,
      individualId,
      individualName: credit.individualName,
    });
  }

  const totalCredit = entries.reduce((s, e) => s + e.amountCents, 0);
  let totalDebit = 0;
  const offset = input.balancedOffset ?? null;
  if (offset && entries.length > 0) {
    const account = normalizeAccountNumber(offset.accountNumber);
    if (!isValidRoutingNumber(offset.routingNumber)) {
      issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'offsetRoutingNumber' } });
    } else if (!account) {
      issues.push({ severity: 'error', code: 'employer_incomplete', params: { field: 'offsetAccountNumber' } });
    } else if (totalCredit > MAX_ENTRY_CENTS) {
      issues.push({ severity: 'error', code: 'invalid_amount', params: { field: 'offset', amountCents: totalCredit } });
    } else {
      totalDebit = totalCredit;
      entries.push({
        transactionCode: offset.accountType === 'savings' ? '37' : '27',
        routingNumber: offset.routingNumber,
        accountNumber: account,
        amountCents: totalCredit,
        individualId: 'OFFSET',
        individualName: originator.companyName,
      });
    }
  }

  const serviceClass = totalDebit > 0 ? '200' : '220';
  const odfi8 = originator.odfiRouting.replace(/\D/g, '').padEnd(9, '0').slice(0, 8);
  const created = input.createdAt;
  const createdDate = created.slice(0, 10);
  const createdTime = /T(\d{2}):(\d{2})/.exec(created);
  const batchNumber = 1;
  const companyId10 = alpha(companyId, 10);
  const description = (() => {
    const d = text(input.entryDescription ?? 'PAYROLL').trim();
    return d.startsWith('PAYROLL') ? d : 'PAYROLL';
  })();

  const records: string[] = [];
  // 1 File Header.
  records.push(
    '1' +
      '01' +
      ' ' +
      numeric(Number(originator.odfiRouting.replace(/\D/g, '') || 0), 9) +
      companyId10.trim().padStart(10, ' ') +
      yymmdd(createdDate) +
      (createdTime ? `${createdTime[1]}${createdTime[2]}` : '0000') +
      (/^[A-Z0-9]$/.test(modifier) ? modifier : 'A') +
      '094' +
      numeric(BLOCKING_FACTOR, 2) +
      '1' +
      alpha(originator.odfiName, 23) +
      alpha(originator.companyName, 23) +
      ' '.repeat(8),
  );
  // 5 Batch Header.
  records.push(
    '5' +
      serviceClass +
      alpha(originator.companyName, 16) +
      ' '.repeat(20) +
      companyId10 +
      'PPD' +
      alpha(description, 10) +
      ' '.repeat(6) +
      yymmdd(input.effectiveDate) +
      ' '.repeat(3) +
      '1' +
      odfi8 +
      numeric(batchNumber, 7),
  );
  // 6 Entry Detail.
  let entryHash = 0;
  entries.forEach((e, i) => {
    const rdfi8 = e.routingNumber.slice(0, 8);
    entryHash += Number(rdfi8);
    records.push(
      '6' +
        e.transactionCode +
        rdfi8 +
        e.routingNumber.slice(8, 9) +
        e.accountNumber.padEnd(17, ' ') +
        numeric(e.amountCents, 10) +
        alpha(e.individualId, 15) +
        alpha(e.individualName, 22) +
        '  ' +
        '0' +
        odfi8 +
        numeric(i + 1, 7),
    );
  });
  const hash10 = numeric(entryHash % 10_000_000_000, 10);
  // 8 Batch Control.
  records.push(
    '8' +
      serviceClass +
      numeric(entries.length, 6) +
      hash10 +
      numeric(totalDebit, 12) +
      numeric(totalCredit, 12) +
      companyId10 +
      ' '.repeat(19) +
      ' '.repeat(6) +
      odfi8 +
      numeric(batchNumber, 7),
  );
  // 9 File Control.
  const recordCountWithControl = records.length + 1;
  const blockCount = Math.ceil(recordCountWithControl / BLOCKING_FACTOR);
  records.push(
    '9' +
      numeric(1, 6) +
      numeric(blockCount, 6) +
      numeric(entries.length, 8) +
      hash10 +
      numeric(totalDebit, 12) +
      numeric(totalCredit, 12) +
      ' '.repeat(39),
  );
  while (records.length % BLOCKING_FACTOR !== 0) records.push('9'.repeat(RECORD_LENGTH));

  for (const r of records) {
    if (r.length !== RECORD_LENGTH) throw new Error(`NACHA record of ${r.length} characters: ${r}`);
  }

  return {
    fileName: `payroll-${createdDate.replace(/-/g, '')}-${/^[A-Z0-9]$/.test(modifier) ? modifier : 'A'}.ach`,
    contentType: 'text/plain',
    content: `${records.join('\n')}\n`,
    issues,
  };
}
