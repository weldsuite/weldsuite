/**
 * XAF 4.0 auditfile generator (Auditfile Financieel).
 *
 * XAF 4.0 is the Belastingdienst's REQUIRED auditfile format since
 * 1 January 2026 (3.2-family files are rejected outright from 2027).
 * It is produced on demand — typically during a boekenonderzoek or for
 * accountant handoff — never filed periodically.
 *
 * Structure follows the XAF 4.0 schema (~90 elements, RGS-aligned):
 * header → company (customersSuppliers, generalLedger, vatCodes, periods,
 * openingBalance, transactions). Validate output against the official XSD
 * from odb.belastingdienst.nl when the format is revised.
 */

import type { Entity } from '@weldsuite/db/schema';

const XAF_NAMESPACE = 'http://www.auditfiles.nl/XAF/4.0';
const SOFTWARE_DESC = 'WeldBooks (WeldSuite)';
const SOFTWARE_VERSION = '1.0';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name: string, value: unknown): string {
  const str = String(value ?? '').trim();
  return str ? `<${name}>${esc(str)}</${name}>` : '';
}

function amount(value: string | number | null | undefined): string {
  return (Number(value) || 0).toFixed(2);
}

export interface XafAccount {
  code: string;
  name: string;
  type: string;
  openingBalance: string | null;
}

export interface XafContact {
  id: string;
  name: string;
  role: string | null;
  taxNumber: string | null;
  street?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface XafVatCode {
  id: string;
  name: string;
  rate: string;
}

export interface XafTransactionLine {
  accountCode: string;
  description: string | null;
  debit: string | null;
  credit: string | null;
  contactId?: string | null;
  vatCodeId?: string | null;
  vatAmount?: string | null;
}

export interface XafTransaction {
  entryNumber: string;
  date: string; // yyyy-mm-dd
  description: string | null;
  sourceType: string | null;
  lines: XafTransactionLine[];
}

export interface XafInput {
  entity: Entity;
  fiscalYear: number;
  startDate: string; // yyyy-mm-dd
  endDate: string; // yyyy-mm-dd
  generatedAt?: string; // yyyy-mm-dd — injectable for deterministic tests
  accounts: XafAccount[];
  contacts: XafContact[];
  vatCodes: XafVatCode[];
  transactions: XafTransaction[];
}

/** Map WeldBooks account type to the XAF accType leadcode letter. */
function accType(type: string): string {
  switch (type) {
    case 'asset':
    case 'liability':
    case 'equity':
      return 'B'; // balans
    default:
      return 'P'; // profit & loss (winst & verlies)
  }
}

/** Map contact role to XAF custSupTp. */
function custSupType(role: string | null): string {
  switch (role) {
    case 'customer':
      return 'C';
    case 'supplier':
      return 'S';
    case 'both':
      return 'B';
    default:
      return 'O';
  }
}

export function generateXaf(input: XafInput): string {
  const { entity, fiscalYear, startDate, endDate, accounts, contacts, vatCodes, transactions } = input;
  const dateCreated = input.generatedAt ?? new Date().toISOString().slice(0, 10);
  const currency = entity.baseCurrency || 'EUR';

  const totalDebit = transactions
    .flatMap((t) => t.lines)
    .reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const totalCredit = transactions
    .flatMap((t) => t.lines)
    .reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
  const linesCount = transactions.reduce((sum, t) => sum + t.lines.length, 0);

  const customersSuppliers = contacts
    .map(
      (contact) => `
      <customerSupplier>
        ${tag('custSupID', contact.id)}
        ${tag('custSupName', contact.name)}
        ${tag('custSupTp', custSupType(contact.role))}
        ${tag('taxRegIdent', contact.taxNumber)}
        ${contact.street || contact.city ? `
        <streetAddress>
          ${tag('streetname', contact.street)}
          ${tag('city', contact.city)}
          ${tag('postalCode', contact.postalCode)}
          ${tag('country', contact.country)}
        </streetAddress>` : ''}
      </customerSupplier>`,
    )
    .join('');

  const ledgerAccounts = accounts
    .map(
      (acc) => `
      <ledgerAccount>
        ${tag('accID', acc.code)}
        ${tag('accDesc', acc.name)}
        ${tag('accTp', accType(acc.type))}
      </ledgerAccount>`,
    )
    .join('');

  const vatCodesXml = vatCodes
    .map(
      (vat) => `
      <vatCode>
        ${tag('vatID', vat.id)}
        ${tag('vatDesc', vat.name)}
      </vatCode>`,
    )
    .join('');

  const openingBalanceLines = accounts
    .filter((acc) => Number(acc.openingBalance) !== 0 && acc.openingBalance !== null)
    .map((acc) => {
      const balance = Number(acc.openingBalance) || 0;
      return `
      <obLine>
        ${tag('nr', acc.code)}
        ${tag('accID', acc.code)}
        ${balance >= 0 ? tag('debAmnt', amount(balance)) : tag('credAmnt', amount(-balance))}
      </obLine>`;
    })
    .join('');

  const journalTransactions = transactions
    .map((tr, trIdx) => {
      const lines = tr.lines
        .map((line, lineIdx) => {
          const debit = Number(line.debit) || 0;
          const credit = Number(line.credit) || 0;
          return `
          <trLine>
            ${tag('nr', String(lineIdx + 1))}
            ${tag('accID', line.accountCode)}
            ${tag('docRef', tr.entryNumber)}
            ${tag('effDate', tr.date)}
            ${tag('desc', line.description ?? tr.description)}
            ${debit > 0 ? tag('debAmnt', amount(debit)) : ''}
            ${credit > 0 ? tag('credAmnt', amount(credit)) : ''}
            ${line.contactId ? tag('custSupID', line.contactId) : ''}
            ${line.vatCodeId ? `
            <vat>
              ${tag('vatID', line.vatCodeId)}
              ${tag('vatAmnt', amount(line.vatAmount))}
            </vat>` : ''}
          </trLine>`;
        })
        .join('');

      return `
        <transaction>
          ${tag('nr', String(trIdx + 1))}
          ${tag('desc', tr.description)}
          ${tag('trDt', tr.date)}
          ${lines}
        </transaction>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<auditfile xmlns="${XAF_NAMESPACE}">
  <header>
    ${tag('fiscalYear', String(fiscalYear))}
    ${tag('startDate', startDate)}
    ${tag('endDate', endDate)}
    ${tag('curCode', currency)}
    ${tag('dateCreated', dateCreated)}
    ${tag('softwareDesc', SOFTWARE_DESC)}
    ${tag('softwareVersion', SOFTWARE_VERSION)}
  </header>
  <company>
    ${tag('companyIdent', entity.taxIdentifiers?.registrationNumber)}
    ${tag('companyName', entity.legalName ?? entity.name)}
    ${tag('taxRegistrationCountry', entity.jurisdictionCode)}
    ${tag('taxRegIdent', entity.taxIdentifiers?.vatNumber)}
    <customersSuppliers>${customersSuppliers}
    </customersSuppliers>
    <generalLedger>${ledgerAccounts}
    </generalLedger>
    <vatCodes>${vatCodesXml}
    </vatCodes>
    <periods>
      <period>
        ${tag('periodNumber', '1')}
        ${tag('periodDesc', `Boekjaar ${fiscalYear}`)}
        ${tag('startDatePeriod', startDate)}
        ${tag('endDatePeriod', endDate)}
      </period>
    </periods>
    <openingBalance>
      ${tag('opBalDate', startDate)}
      ${tag('linesCount', String(accounts.filter((a) => Number(a.openingBalance) !== 0).length))}
      ${openingBalanceLines}
    </openingBalance>
    <transactions>
      ${tag('linesCount', String(linesCount))}
      ${tag('totalDebit', amount(totalDebit))}
      ${tag('totalCredit', amount(totalCredit))}
      <journal>
        ${tag('jrnID', 'MEMO')}
        ${tag('desc', 'WeldBooks journal')}
        ${tag('jrnTp', 'Z')}
        ${journalTransactions}
      </journal>
    </transactions>
  </company>
</auditfile>`;
}
