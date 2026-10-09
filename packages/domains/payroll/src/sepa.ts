/**
 * SEPA salary batch (ISO 20022 pain.001.001.09, category purpose SALA) for
 * Dutch payroll: the employer uploads it to its own bank. Optionally carries
 * the loonheffingen payment to the Belastingdienst with its betalingskenmerk.
 *
 * Message version: pain.001.001.09, the version of the Dutch Payments
 * Association's "SEPA Credit Transfer Customer-to-Bank Implementation
 * Guidelines for the Netherlands" 2023 v1.0, effective 17 March 2024
 * (https://www.betaalvereniging.nl/en/wp-content/uploads/sites/4/2025/11/Betaalvereniging-NL_IG-C2B-SEPA-Credit-Transfer_2023_v1.0.pdf),
 * which builds on the EPC SCT Customer-to-PSP Implementation Guidelines
 * (EPC132-08; 2025 v1.0:
 * https://www.europeanpaymentscouncil.eu/sites/default/files/kb/file/2025-10/EPC132-08%20SCT%20C2PSP%20IG%202025%20V1.0.pdf).
 * Rabobank and ABN AMRO still also take pain.001.001.03, but .09 is the
 * current Dutch guideline. Output is checked against the ISO 20022 schema
 * pain.001.001.09.xsd (iso20022.org message catalogue).
 *
 * Rules applied (EPC IG usage rules unless noted):
 * - Payment method `TRF` only; service level `SEPA`; charge bearer `SLEV`
 *   only; amounts in EUR, 0.01 to 999999999.99, at most two decimals (2.95);
 *   the debtor agent is mandatory, by BICFI or `Othr/Id` "NOTPROVIDED"; names
 *   max 70 characters, unstructured remittance max 140.
 * - Category purpose `SALA` on the salary payment information; the tax is a
 *   separate payment information with `TAXS`, so the salaries can be booked
 *   as one batch entry (2.3 BtchBookg) while the tax stays its own entry.
 * - Structured remittance for the betalingskenmerk: CdtrRefInf/Tp/CdOrPrtry/Cd
 *   `SCOR`, Issr `CUR` and the 16-digit reference (NL IG Annex A: with the
 *   Dutch structured communication the Issuer is "CUR" and the reference
 *   must follow the betalingskenmerk rules).
 * - Character set (EPC IG §1.4): the Latin set (letters, digits, `/-?:().,'+`
 *   and space). Names and remittance are transliterated (diacritics removed,
 *   `&` as `+`) and anything else becomes a space; identifiers may not start
 *   or end with `/` or contain `//`. Text is XML-escaped regardless.
 * - No postal addresses. The payer's address is only mandatory when the
 *   payee's bank is in a non-EEA SEPA country (EPC IG 2.23, AT-P005); such a
 *   payment gets a `non_eea_creditor` warning so the user can check with the
 *   bank. The country list holds only the long-standing non-EEA members (CH,
 *   GB, SM, VA, MC, AD, GI), not the 2024–2025 accession countries. From
 *   22 November 2026 only structured or hybrid addresses are allowed when one
 *   is given (EPC IG §1.7).
 *
 * Issues (all errors; a rejected payment stays out of the file and its
 * control sums): invalid_iban, invalid_bic, missing_account_holder (each
 * with `role` debtor/employee/tax, and `endToEndId` for an employee),
 * invalid_end_to_end_id, duplicate_end_to_end_id, invalid_amount,
 * invalid_betalingskenmerk, outdated_tax_account, invalid_execution_date,
 * invalid_created_at, invalid_message_id, empty_batch; warning
 * non_eea_creditor.
 *
 * Belastingdienst account (Handboek Loonheffingen 2026 §13.4.1): IBAN
 * NL86 INGB 0002 4455 88 "ten name van de Belastingdienst in Apeldoorn";
 * from 1 May 2026 the new central account NL04 RABO 0200 1122 44, which is
 * mandatory from 2027. The default follows the execution date.
 */

import type { GeneratedFile } from './documents';
import type { PayrollIssue } from './types';

export interface SepaParty {
  name: string;
  iban: string;
  bic?: string | null;
}

export interface SepaSalaryPayment {
  /** Unique per payment, max 35 chars (the payslip id works). */
  endToEndId: string;
  creditor: SepaParty;
  amountCents: number;
  /** Unstructured remittance, max 140 chars ("Salaris april 2026"). */
  remittance: string;
}

export interface SepaTaxPayment {
  amountCents: number;
  /** The period's betalingskenmerk (structured remittance). */
  betalingskenmerk: string;
  /** Defaults to the Belastingdienst's account. */
  creditor?: SepaParty;
}

export interface SepaSalaryBatchInput {
  /** Unique per file, max 35 chars. */
  messageId: string;
  /** ISO date-time the file was created. */
  createdAt: string;
  /** Requested execution date, `YYYY-MM-DD`. */
  executionDate: string;
  debtor: SepaParty;
  salaries: SepaSalaryPayment[];
  tax?: SepaTaxPayment | null;
}

export const PAIN_001_NAMESPACE = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09';

/** Belastingdienst accounts for loonheffingen (Handboek Loonheffingen 2026 §13.4.1). */
export const BELASTINGDIENST_ACCOUNTS = {
  /** Until 30 April 2026, and still allowed for every 2026 return. */
  ing: { name: 'Belastingdienst', iban: 'NL86INGB0002445588' },
  /** From 1 May 2026; mandatory from 2027. */
  rabobank: { name: 'Belastingdienst', iban: 'NL04RABO0200112244' },
} as const;

export function belastingdienstAccount(executionDate: string): SepaParty {
  return executionDate < '2026-05-01' ? { ...BELASTINGDIENST_ACCOUNTS.ing } : { ...BELASTINGDIENST_ACCOUNTS.rabobank };
}

/**
 * IBAN check (ISO 13616): two letters, two check digits, up to 30
 * alphanumerics, and the mod-97 check (rearranged number mod 97 = 1). Dutch
 * IBANs must also have the Dutch layout: 18 characters, a 4-letter bank code
 * and a 10-digit account number (e.g. NL04 RABO 0200 1122 44).
 */
export function isValidIban(iban: string): boolean {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(s)) return false;
  if (s.startsWith('NL') && !/^NL\d{2}[A-Z]{4}\d{10}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

/**
 * The Belastingdienst's 16-digit betalingskenmerk: the first digit is a
 * modulus-11 check over the other 15 (weights 2, 4, 8, 5, 10, 9, 7, 3, 6, 1
 * from the right, repeating; 11 minus the remainder, 10 → 1, 11 → 0), per the
 * Specificatie Betalingskenmerk v1.0 that `betalingskenmerk()` in
 * nl/loonaangifte.ts generates. Spaces and dots are ignored.
 */
export function isValidBetalingskenmerk(reference: string): boolean {
  const s = reference.replace(/[\s.]/g, '');
  if (!/^\d{16}$/.test(s)) return false;
  const weights = [2, 4, 8, 5, 10, 9, 7, 3, 6, 1];
  let sum = 0;
  for (let i = 0; i < 15; i += 1) sum += Number(s[15 - i]) * weights[i % weights.length]!;
  const check = 11 - (sum % 11);
  return Number(s[0]) === (check === 10 ? 1 : check === 11 ? 0 : check);
}

/** EPC IG 2.95: EUR 0.01 to 999,999,999.99, in whole cents. */
function validAmount(cents: number): boolean {
  return Number.isInteger(cents) && cents >= 1 && cents <= 99_999_999_999;
}

/** Long-standing non-EEA SEPA countries (see the header). */
const NON_EEA_SEPA = new Set(['CH', 'GB', 'SM', 'VA', 'MC', 'AD', 'GI']);

const BIC = /^[A-Z]{6}[A-Z2-9][A-NP-Z0-9]([A-Z0-9]{3})?$/;

/** Latin letters that do not decompose into a base letter plus a diacritic. */
const LATIN_EXTRA: Record<string, string> = { ß: 'ss', ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', þ: 'th', Þ: 'Th' };

/** EPC basic Latin set; diacritics removed, `&` as `+`, anything else replaced by a space. */
export function toSepaText(text: string, max: number): string {
  const ascii = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ßøØæÆœŒłŁđĐþÞ]/g, (c) => LATIN_EXTRA[c] ?? ' ')
    .replace(/&/g, '+');
  return ascii.replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Identifiers: basic Latin, no leading/trailing `/`, no `//` (EPC IG 1.4). */
function toSepaId(text: string, max: number): string {
  return toSepaText(text, max).replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '').replace(/ /g, '-').slice(0, max);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function amount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

type Node = [string, Node[] | string, Record<string, string>?];

function render(node: Node, depth = 0): string {
  const [name, content, attrs] = node;
  const pad = '  '.repeat(depth);
  const a = attrs ? Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('') : '';
  if (typeof content === 'string') return `${pad}<${name}${a}>${escapeXml(content)}</${name}>`;
  return `${pad}<${name}${a}>\n${content.map((c) => render(c, depth + 1)).join('\n')}\n${pad}</${name}>`;
}

function agent(bic: string | null | undefined): Node {
  const b = (bic ?? '').replace(/\s/g, '').toUpperCase();
  return ['FinInstnId', b ? [['BICFI', b]] : [['Othr', [['Id', 'NOTPROVIDED']]]]];
}

export function buildSepaSalaryBatch(input: SepaSalaryBatchInput): GeneratedFile & { issues: PayrollIssue[] } {
  const issues: PayrollIssue[] = [];
  const err = (code: string, params?: Record<string, string | number>) => issues.push({ severity: 'error', code, ...(params ? { params } : {}) });

  // Per-payment issues carry the endToEndId as given, so the caller can attach them to its payslip.
  const checkParty = (p: SepaParty, role: 'debtor' | 'employee' | 'tax', endToEndId?: string) => {
    const ref: Record<string, string> = endToEndId === undefined ? {} : { endToEndId };
    if (!isValidIban(p.iban)) err('invalid_iban', { role, ...ref });
    if (p.bic && !BIC.test(p.bic.replace(/\s/g, '').toUpperCase())) err('invalid_bic', { role, ...ref });
    if (!toSepaText(p.name, 70)) err('missing_account_holder', { role, ...ref });
  };
  checkParty(input.debtor, 'debtor');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.executionDate)) err('invalid_execution_date', { executionDate: input.executionDate });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(input.createdAt)) err('invalid_created_at', { createdAt: input.createdAt });

  const ids = new Set<string>();
  const salaryTx: Node[] = [];
  let salaryTotal = 0;
  for (const s of input.salaries) {
    checkParty(s.creditor, 'employee', s.endToEndId);
    const country = normalizeIban(s.creditor.iban).slice(0, 2);
    if (NON_EEA_SEPA.has(country)) issues.push({ severity: 'warning', code: 'non_eea_creditor', params: { endToEndId: s.endToEndId, country } });
    const e2e = toSepaId(s.endToEndId, 35);
    let usable = true;
    if (!e2e) {
      err('invalid_end_to_end_id', { endToEndId: s.endToEndId });
      usable = false;
    } else if (ids.has(e2e)) {
      err('duplicate_end_to_end_id', { endToEndId: s.endToEndId });
      usable = false;
    }
    ids.add(e2e);
    if (!validAmount(s.amountCents)) {
      err('invalid_amount', { endToEndId: s.endToEndId, amountCents: s.amountCents });
      usable = false;
    }
    // A rejected payment stays out of the file and its control sums.
    if (!usable) continue;
    salaryTotal += s.amountCents;
    salaryTx.push([
      'CdtTrfTxInf',
      [
        ['PmtId', [['EndToEndId', e2e]]],
        ['Amt', [['InstdAmt', amount(s.amountCents), { Ccy: 'EUR' }]]],
        ...(s.creditor.bic ? [['CdtrAgt', [agent(s.creditor.bic)]] as Node] : []),
        ['Cdtr', [['Nm', toSepaText(s.creditor.name, 70)]]],
        ['CdtrAcct', [['Id', [['IBAN', normalizeIban(s.creditor.iban)]]]]],
        ['RmtInf', [['Ustrd', toSepaText(s.remittance, 140)]]],
      ],
    ]);
  }

  const msgId = toSepaId(input.messageId, 35);
  if (!msgId) err('invalid_message_id');
  const debtorNodes: Node[] = [
    ['ReqdExctnDt', [['Dt', input.executionDate]]],
    ['Dbtr', [['Nm', toSepaText(input.debtor.name, 70)]]],
    ['DbtrAcct', [['Id', [['IBAN', normalizeIban(input.debtor.iban)]]]]],
    ['DbtrAgt', [agent(input.debtor.bic)]],
    ['ChrgBr', 'SLEV'],
  ];
  const pmtInf = (suffix: string, purpose: string, txs: Node[], total: number, batch: boolean): Node => [
    'PmtInf',
    [
      ['PmtInfId', `${msgId.slice(0, 31)}-${suffix}`],
      ['PmtMtd', 'TRF'],
      ['BtchBookg', batch ? 'true' : 'false'],
      ['NbOfTxs', String(txs.length)],
      ['CtrlSum', amount(total)],
      ['PmtTpInf', [['SvcLvl', [['Cd', 'SEPA']]], ['CtgyPurp', [['Cd', purpose]]]]],
      ...debtorNodes,
      ...txs,
    ],
  ];

  const payments: Node[] = [];
  let txCount = salaryTx.length;
  let total = salaryTotal;
  if (salaryTx.length > 0) payments.push(pmtInf('SAL', 'SALA', salaryTx, salaryTotal, true));

  if (input.tax) {
    const creditor = input.tax.creditor ?? belastingdienstAccount(input.executionDate);
    checkParty(creditor, 'tax');
    const kenmerk = input.tax.betalingskenmerk.replace(/[\s.]/g, '');
    if (!isValidBetalingskenmerk(kenmerk)) err('invalid_betalingskenmerk', { betalingskenmerk: input.tax.betalingskenmerk });
    // The ING account is accepted for 2026 returns only (Handboek §13.4.1).
    if (input.executionDate >= '2027-01-01' && normalizeIban(creditor.iban) === BELASTINGDIENST_ACCOUNTS.ing.iban) {
      err('outdated_tax_account', { iban: BELASTINGDIENST_ACCOUNTS.ing.iban });
    }
    if (!validAmount(input.tax.amountCents)) err('invalid_amount', { endToEndId: 'tax', amountCents: input.tax.amountCents });
  }
  if (input.tax && validAmount(input.tax.amountCents)) {
    const creditor = input.tax.creditor ?? belastingdienstAccount(input.executionDate);
    const kenmerk = input.tax.betalingskenmerk.replace(/[\s.]/g, '');
    const tx: Node = [
      'CdtTrfTxInf',
      [
        ['PmtId', [['EndToEndId', toSepaId(`${msgId.slice(0, 26)}-LH${kenmerk.slice(-6)}`, 35)]]],
        ['Amt', [['InstdAmt', amount(input.tax.amountCents), { Ccy: 'EUR' }]]],
        ...(creditor.bic ? [['CdtrAgt', [agent(creditor.bic)]] as Node] : []),
        ['Cdtr', [['Nm', toSepaText(creditor.name, 70)]]],
        ['CdtrAcct', [['Id', [['IBAN', normalizeIban(creditor.iban)]]]]],
        ['RmtInf', [['Strd', [['CdtrRefInf', [['Tp', [['CdOrPrtry', [['Cd', 'SCOR']]], ['Issr', 'CUR']]], ['Ref', kenmerk]]]]]]],
      ],
    ];
    payments.push(pmtInf('TAX', 'TAXS', [tx], input.tax.amountCents, false));
    txCount += 1;
    total += input.tax.amountCents;
  }
  if (payments.length === 0) err('empty_batch');

  const doc: Node = [
    'Document',
    [
      [
        'CstmrCdtTrfInitn',
        [
          [
            'GrpHdr',
            [
              ['MsgId', msgId],
              ['CreDtTm', input.createdAt.slice(0, 19)],
              ['NbOfTxs', String(txCount)],
              ['CtrlSum', amount(total)],
              ['InitgPty', [['Nm', toSepaText(input.debtor.name, 70)]]],
            ],
          ],
          ...payments,
        ],
      ],
    ],
    { xmlns: PAIN_001_NAMESPACE },
  ];

  return {
    fileName: `salarissen-${input.executionDate}-${msgId}.xml`,
    contentType: 'application/xml',
    content: `<?xml version="1.0" encoding="UTF-8"?>\n${render(doc)}\n`,
    issues,
  };
}
