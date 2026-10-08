/**
 * US banking basics on pglite: bank accounts with encrypted numbers and card
 * accounts on a liability, statement import (OFX, CSV with an explicit layout,
 * BAI2) with re-import dedupe, matching by name and check number, Undeposited
 * Funds and bank deposits, and statement reconciliation with undo.
 *
 * The books run on an entity with the NL chart plus the two US system roles
 * (`undeposited_funds`, `credit_card_payable`), so the tests don't depend on
 * the US chart template.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../routes/accounting-entities';
import { bankAccountsRoutes } from '../routes/bank-accounts';
import { bankDepositsRoutes } from '../routes/bank-deposits';
import { bankReconciliationsRoutes } from '../routes/bank-reconciliations';
import { bankTransactionsRoutes } from '../routes/bank-transactions';
import { billsRoutes } from '../routes/bills';
import { invoicesRoutes } from '../routes/invoices';
import { paymentsRoutes } from '../routes/payments';

const ENCRYPTION_KEY = `${'0'.repeat(63)}1`;
const events: Array<{ eventType: string; entityId: string; data: Record<string, unknown> }> = [];
const env = {
  DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
  ENTITY_EVENTS: {
    send: async (message: { eventType: string; entityId: string; data: Record<string, unknown> }) => {
      events.push(message);
    },
  },
};

let db: Database;
let entityId: string;
const accountId: Record<string, string> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, method = 'GET', body?: unknown, perms: string[] = ['*']) {
  const { request } = createTestApp(mount, routes, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: env as any,
    context: { permissions: permissions(...perms), tenantDb: db },
  });
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(entityId ? { 'X-Accounting-Entity-Id': entityId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: unknown; error?: { code: string; message: string; details?: Record<string, unknown> }; pagination?: Record<string, unknown> }) : null;
  return {
    status: res.status,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: json?.data as any,
    error: json?.error,
    pagination: json?.pagination,
    text,
  };
}

const bankAccounts = (path = '', method = 'GET', body?: unknown, perms?: string[]) => call('/api/bank-accounts', bankAccountsRoutes, `/api/bank-accounts${path}`, method, body, perms);
const transactions = (path = '', method = 'GET', body?: unknown) => call('/api/bank-transactions', bankTransactionsRoutes, `/api/bank-transactions${path}`, method, body);
const payments = (path = '', method = 'GET', body?: unknown) => call('/api/payments', paymentsRoutes, `/api/payments${path}`, method, body);
const deposits = (path = '', method = 'GET', body?: unknown) => call('/api/bank-deposits', bankDepositsRoutes, `/api/bank-deposits${path}`, method, body);
const reconciliations = (path = '', method = 'GET', body?: unknown, perms?: string[]) => call('/api/bank-reconciliations', bankReconciliationsRoutes, `/api/bank-reconciliations${path}`, method, body, perms);

async function balanceOf(id: string) {
  const [row] = await db.select({ balance: schema.accounts.currentBalance }).from(schema.accounts).where(eq(schema.accounts.id, id)).limit(1);
  return Number(row?.balance ?? 0);
}

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({ code: schema.accounts.code, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return rows
    .map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.debit - b.debit || a.credit - b.credit);
}

/** An OFX 1.x (SGML) statement. `lines` are [FITID, YYYYMMDD, amount, name, memo?, checknum?]. */
function ofx(args: { acct: string; card?: boolean; curdef?: string; ledger: number; lines: Array<[string, string, number, string, string?, string?]> }) {
  const body = args.lines
    .map(
      ([fitid, date, amount, name, memo, check]) =>
        `<STMTTRN>\n<TRNTYPE>${amount < 0 ? 'DEBIT' : 'CREDIT'}\n<DTPOSTED>${date}120000.000[-5:EST]\n<TRNAMT>${amount.toFixed(2)}\n<FITID>${fitid}\n${check ? `<CHECKNUM>${check}\n` : ''}<NAME>${name}\n${memo ? `<MEMO>${memo}\n` : ''}</STMTTRN>`,
    )
    .join('\n');
  const from = args.card
    ? `<CCACCTFROM>\n<ACCTID>${args.acct}\n</CCACCTFROM>`
    : `<BANKACCTFROM>\n<BANKID>021000021\n<ACCTID>${args.acct}\n<ACCTTYPE>CHECKING\n</BANKACCTFROM>`;
  const inner = `<CURDEF>${args.curdef ?? 'USD'}\n${from}\n<BANKTRANLIST>\n<DTSTART>20260201\n<DTEND>20260228\n${body}\n</BANKTRANLIST>\n<LEDGERBAL>\n<BALAMT>${args.ledger.toFixed(2)}\n<DTASOF>20260228\n</LEDGERBAL>`;
  const wrapped = args.card
    ? `<CREDITCARDMSGSRSV1>\n<CCSTMTTRNRS>\n<TRNUID>1\n<CCSTMTRS>\n${inner}\n</CCSTMTRS>\n</CCSTMTTRNRS>\n</CREDITCARDMSGSRSV1>`
    : `<BANKMSGSRSV1>\n<STMTTRNRS>\n<TRNUID>1\n<STMTRS>\n${inner}\n</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>`;
  return `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n\n<OFX>\n<SIGNONMSGSRSV1>\n<SONRS>\n<STATUS>\n<CODE>0\n<SEVERITY>INFO\n</STATUS>\n<DTSERVER>20260301\n<LANGUAGE>ENG\n</SONRS>\n</SIGNONMSGSRSV1>\n${wrapped}\n</OFX>\n`;
}

async function createInvoice(contactId: string, amount: string, issueDate = '2026-01-20') {
  const created = await call('/api/invoices', invoicesRoutes, '/api/invoices', 'POST', {
    contactId,
    issueDate,
    dueDate: '2026-03-31',
    items: [{ description: 'Services', quantity: '1', unitPrice: amount, taxRateId: 'none' }],
  });
  expect(created.status).toBe(201);
  const finalized = await call('/api/invoices', invoicesRoutes, `/api/invoices/${created.data.id}/finalize`, 'POST');
  expect(finalized.status).toBe(200);
  return created.data.id as string;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name: 'US Banking BV',
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id as string;
  await db.update(schema.entities).set({ baseCurrency: 'USD' }).where(eq(schema.entities.id, entityId));

  const now = new Date();
  await db.insert(schema.accounts).values([
    { id: 'acc_undeposited', entityId, code: '1150', name: 'Undeposited Funds', type: 'asset', subtype: 'current_assets', normalSide: 'debit', isSystemAccount: true, metadata: { systemRole: 'undeposited_funds' }, currency: 'USD', createdAt: now, updatedAt: now },
    { id: 'acc_card_payable', entityId, code: '1650', name: 'Credit Card Payable', type: 'liability', subtype: 'credit_card', normalSide: 'credit', isSystemAccount: true, metadata: { systemRole: 'credit_card_payable' }, currency: 'USD', createdAt: now, updatedAt: now },
    { id: 'acc_fees', entityId, code: '4990', name: 'Bank Charges', type: 'expense', normalSide: 'debit', currency: 'USD', createdAt: now, updatedAt: now },
    { id: 'acc_interest', entityId, code: '8990', name: 'Interest Income', type: 'revenue', normalSide: 'credit', currency: 'USD', createdAt: now, updatedAt: now },
  ]);
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  for (const a of accounts) accountId[a.code] = a.id;

  const address = { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 AB', country: 'NL' };
  await db.insert(schema.parties).values([
    { id: 'pty_acme', displayName: 'Acme Corporation', role: 'customer', billingAddress: address },
    { id: 'pty_beta', displayName: 'Beta Roofing LLC', role: 'customer', billingAddress: address },
    { id: 'pty_landlord', displayName: 'Office Landlord LLC', role: 'supplier' },
  ]);
}, 90_000);

// ── Bank accounts ───────────────────────────────────────────────────────────

describe('bank accounts', () => {
  let checkingId: string;
  let cardId: string;

  it('stores a US checking account with an encrypted number and creates its asset ledger account', async () => {
    const res = await bankAccounts('', 'POST', {
      name: 'Chase Business Checking',
      bankName: 'JPMorgan Chase',
      currency: 'USD',
      accountType: 'checking',
      routingNumber: '021000021',
      accountNumber: '0001 2345-6789',
    });
    expect(res.status).toBe(201);
    checkingId = res.data.id;
    expect(res.data).toMatchObject({
      accountType: 'checking',
      routingNumber: '021000021',
      accountNumberLast4: '6789',
      hasAccountNumber: true,
    });
    expect(res.data.accountNumberEncrypted).toBeUndefined();
    expect(res.text).not.toContain('000123456789');

    const [row] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, checkingId));
    expect(row.accountNumberEncrypted).toBeTruthy();
    expect(row.accountNumberEncrypted).not.toContain('6789');

    const [ledger] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, row.ledgerAccountId!));
    expect(ledger).toMatchObject({ type: 'asset', subtype: 'bank', normalSide: 'debit', entityId });
    accountId.checkingLedger = ledger.id;
    expect(res.data.ledgerAccount).toMatchObject({ created: true, id: ledger.id });
  });

  it('lists and returns accounts with the last four digits only, and keeps the blob out of events', async () => {
    const list = await bankAccounts();
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('000123456789');
    expect(list.text).not.toContain('accountNumberEncrypted');
    expect(list.data[0]).toMatchObject({ accountNumberLast4: '6789', routingNumber: '021000021' });

    const detail = await bankAccounts(`/${checkingId}`);
    expect(detail.data.accountNumberEncrypted).toBeUndefined();
    expect(detail.data.hasAccountNumber).toBe(true);

    const created = events.filter((e) => e.eventType === 'bank_account:created');
    expect(created.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('accountNumberEncrypted');
    expect(JSON.stringify(events)).not.toContain('000123456789');
  });

  it('rejects a routing number that fails the ABA checksum', async () => {
    const res = await bankAccounts('', 'POST', { name: 'Bad', accountType: 'checking', routingNumber: '021000022' });
    expect(res.status).toBe(400);
    expect(res.error?.message).toMatch(/routing number/i);
  });

  it('puts a credit card on a liability account under Credit Card Payable', async () => {
    const res = await bankAccounts('', 'POST', {
      name: 'Amex Blue Business',
      currency: 'USD',
      accountType: 'credit_card',
      accountNumber: '4111111111111111',
    });
    expect(res.status).toBe(201);
    cardId = res.data.id;
    const [row] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, cardId));
    const [ledger] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, row.ledgerAccountId!));
    expect(ledger).toMatchObject({ type: 'liability', normalSide: 'credit', subtype: 'credit_card', parentAccountId: 'acc_card_payable', code: '1651' });
    accountId.cardLedger = ledger.id;

    const wrong = await bankAccounts('', 'POST', { name: 'Card on an asset', accountType: 'credit_card', ledgerAccountId: accountId['1100'] });
    expect(wrong.status).toBe(400);
    expect(wrong.error?.message).toMatch(/liability ledger account/);
  });

  it('reveals the full number only with tax_ids:reveal, and logs every reveal', async () => {
    const denied = await bankAccounts(`/${checkingId}/reveal-account-number`, 'POST', {}, ['banking:read']);
    expect(denied.status).toBe(403);
    expect(await db.select().from(schema.taxIdReveals)).toHaveLength(0);

    const revealed = await bankAccounts(`/${checkingId}/reveal-account-number`, 'POST', { reason: 'Setting up ACH' }, ['banking:read', 'tax_ids:reveal']);
    expect(revealed.status).toBe(200);
    expect(revealed.data).toMatchObject({ accountNumber: '000123456789', routingNumber: '021000021' });

    const log = await db.select().from(schema.taxIdReveals);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      subjectType: 'bank_account',
      subjectId: checkingId,
      field: 'account_number',
      revealedBy: 'user_test_default',
      reason: 'Setting up ACH',
      entityId,
    });
    expect(JSON.stringify(events)).not.toContain('000123456789');

    // The accounting audit log notes the reveal, never the number.
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'acct_number_revealed'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('000123456789');
  });

  it('keeps the number when other fields change and clears it on request', async () => {
    const renamed = await bankAccounts(`/${checkingId}`, 'PATCH', { name: 'Chase Operating' });
    expect(renamed.status).toBe(200);
    expect(renamed.data).toMatchObject({ name: 'Chase Operating', accountNumberLast4: '6789', hasAccountNumber: true });

    const cleared = await bankAccounts(`/${checkingId}`, 'PATCH', { accountNumber: null });
    expect(cleared.data).toMatchObject({ accountNumberLast4: null, hasAccountNumber: false });
    const again = await bankAccounts(`/${checkingId}`, 'PATCH', { accountNumber: '000123456789' });
    expect(again.data.accountNumberLast4).toBe('6789');
  });
});

// ── Statement import ────────────────────────────────────────────────────────

describe('statement import', () => {
  let checkingId: string;
  let savingsId: string;
  let operatingId: string;
  let cardId: string;

  beforeAll(async () => {
    const [checking] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.accountNumberLast4, '6789'));
    checkingId = checking.id;
    const savings = await bankAccounts('', 'POST', { name: 'Savings', currency: 'USD', accountType: 'savings' });
    savingsId = savings.data.id;
    const operating = await bankAccounts('', 'POST', { name: 'Operating (BAI2)', currency: 'USD', accountType: 'checking', accountNumber: '0975312468' });
    operatingId = operating.data.id;
    const [card] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.accountNumberLast4, '1111'));
    cardId = card.id;
  });

  const checkingFile = () =>
    ofx({
      acct: '000123456789',
      ledger: 3448.51,
      lines: [
        ['2026020201', '20260202', -1250, 'OFFICE LANDLORD LLC', 'Rent February', '1042'],
        ['2026020501', '20260205', 4800.5, 'ACME CORP', 'ACH CREDIT INV 2001'],
        ['2026021001', '20260210', -89.99, 'ADOBE INC'],
        ['2026022801', '20260228', -12, 'MONTHLY SERVICE FEE'],
      ],
    });

  it('imports an OFX file end to end and skips every line when the same file comes again', async () => {
    const first = await transactions('/import', 'POST', { bankAccountId: checkingId, fileName: 'chase-feb.ofx', content: checkingFile() });
    expect(first.status).toBe(201);
    expect(first.data).toMatchObject({ format: 'ofx', totalParsed: 4, imported: 4, duplicates: 0, closingBalance: 3448.51, currency: 'USD' });

    const rows = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.bankAccountId, checkingId));
    expect(rows).toHaveLength(4);
    const rent = rows.find((r) => r.externalId === '2026020201')!;
    expect(rent).toMatchObject({ source: 'import', checkNumber: '1042', amount: '-1250.00', status: 'unreconciled', counterpartyName: 'OFFICE LANDLORD LLC' });
    expect(rent.date.toISOString().slice(0, 10)).toBe('2026-02-02');

    const [account] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, checkingId));
    expect(account.lastImportBalance).toBe('3448.51');

    const again = await transactions('/import', 'POST', { bankAccountId: checkingId, fileName: 'chase-feb.ofx', content: checkingFile() });
    expect(again.status).toBe(201);
    expect(again.data).toMatchObject({ imported: 0, duplicates: 4 });
    expect(await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.bankAccountId, checkingId))).toHaveLength(4);
  });

  it('refuses a file for another account or currency unless told to import anyway', async () => {
    const other = ofx({ acct: '999999999999', ledger: 10, lines: [['X1', '20260201', 10, 'DEPOSIT']] });
    const refused = await transactions('/import', 'POST', { bankAccountId: checkingId, fileName: 'other.qfx', content: other });
    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('ACCOUNT_MISMATCH');
    expect(refused.error?.details).toMatchObject({ fileAccountLast4: '9999', bankAccountLast4: '6789' });

    const eur = ofx({ acct: '000123456789', curdef: 'EUR', ledger: 10, lines: [['X2', '20260201', 10, 'DEPOSIT']] });
    const currency = await transactions('/import', 'POST', { bankAccountId: checkingId, fileName: 'eur.ofx', content: eur });
    expect(currency.error?.code).toBe('CURRENCY_MISMATCH');

    const forced = await transactions('/import', 'POST', { bankAccountId: checkingId, fileName: 'other.qfx', content: other, ignoreAccountMismatch: true });
    expect(forced.status).toBe(201);
    expect(forced.data.format).toBe('qfx');
    expect(forced.data.warning.code).toBe('ACCOUNT_MISMATCH');
  });

  it('asks for a CSV layout, imports with it, remembers it, and does not double a re-import', async () => {
    const csv = [
      'Account Summary for Savings',
      '',
      'Posting Date,Description,Amount,Check Number',
      '01/05/2026,"TRANSFER FROM CHECKING",(1250.00),',
      '01/12/2026,INTEREST PAID,"4,800.50",',
      '01/31/2026,MONTHLY FEE,(12.00),1043',
    ].join('\n');

    const needsFormat = await transactions('/import', 'POST', { bankAccountId: savingsId, fileName: 'savings.csv', content: csv });
    expect(needsFormat.status).toBe(422);
    expect(needsFormat.error?.code).toBe('CSV_FORMAT_REQUIRED');
    const proposal = (needsFormat.error?.details as { proposal: { format: Record<string, unknown>; dateOrderAmbiguous: boolean } }).proposal;
    expect(proposal.format).toMatchObject({ dateFormat: 'MDY', negativeStyle: 'parentheses', hasHeader: true, skipRows: 1 });

    const preview = await transactions('/import/preview', 'POST', { bankAccountId: savingsId, content: csv, csvFormat: proposal.format });
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ format: 'csv', needsCsvFormat: false, totalParsed: 3, duplicates: 0 });
    expect(preview.data.sample[0]).toMatchObject({ date: '2026-01-05', amount: -1250 });
    expect((await transactions('/import/preview', 'POST', { content: csv })).data.needsCsvFormat).toBe(true);

    const imported = await transactions('/import', 'POST', {
      bankAccountId: savingsId,
      fileName: 'savings.csv',
      content: csv,
      csvFormat: proposal.format,
      rememberCsvFormat: true,
    });
    expect(imported.status).toBe(201);
    expect(imported.data).toMatchObject({ format: 'csv', imported: 3, csvFormatRemembered: true });
    const [account] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.id, savingsId));
    expect((account.importSettings as { csv: { dateFormat: string } }).csv.dateFormat).toBe('MDY');

    // The remembered layout is used when the request carries none; identical lines are not imported again.
    const again = await transactions('/import', 'POST', { bankAccountId: savingsId, fileName: 'savings.csv', content: csv });
    expect(again.status).toBe(201);
    expect(again.data).toMatchObject({ imported: 0, duplicates: 3 });
    const fee = (await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.bankAccountId, savingsId))).find((r) => r.checkNumber === '1043');
    expect(fee).toMatchObject({ amount: '-12.00', source: 'import' });
  });

  it('imports a BAI2 prior-day file for the matching account of a multi-account file', async () => {
    const bai2 = [
      '01,121000248,CUSTOMERID,260116,0630,1,80,,2/',
      '02,CUSTOMERID,121000248,1,260215,2359,USD,2/',
      '03,0975312468,USD,010,1050000,,,015,1177750,,/',
      '16,142,125050,,B0001,INV2001,ACH CREDIT ACME CORP INVOICE 2001/',
      '16,475,30000,,B0003,1042,CHECK PAID/',
      '16,495,15000,,B0004,WIRE77,OUTGOING WIRE TO SMITH & SONS/',
      '16,890,500,,,,UNSUPPORTED/',
      '49,5555550,6/',
      '03,0123456789,USD,010,50000,,,015,45000,,/',
      '16,451,5000,,B0005,,ACH DEBIT UTILITY CO/',
      '49,95000,3/',
      '98,5650550,2,12/',
      '99,5650550,1,14/',
    ].join('\n');
    const res = await transactions('/import', 'POST', { bankAccountId: operatingId, fileName: 'prior-day.bai', content: bai2 });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ format: 'bai2', imported: 3, duplicates: 0, closingBalance: 11777.5 });
    expect(res.data.errors).toHaveLength(1);
    const rows = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.bankAccountId, operatingId));
    expect(rows.map((r) => Number(r.amount)).sort((a, b) => a - b)).toEqual([-300, -150, 1250.5]);
    expect(rows.find((r) => r.checkNumber === '1042')).toMatchObject({ transactionCode: '475', source: 'import' });

    const again = await transactions('/import', 'POST', { bankAccountId: operatingId, fileName: 'prior-day.bai', content: bai2 });
    expect(again.data).toMatchObject({ imported: 0, duplicates: 3 });
  });

  it('imports a credit card file where purchases are negative and books them on the liability account', async () => {
    const card = ofx({
      acct: '4111111111111111',
      card: true,
      ledger: -116.8,
      lines: [
        ['CC1', '20260203', -64.2, 'STAPLES 0123', 'OFFICE SUPPLIES'],
        ['CC2', '20260209', -1299, 'DELL MARKETING'],
        ['CC3', '20260215', -20, 'STAPLES 0123', 'RETURN'],
        ['CC4', '20260220', 1500, 'ONLINE PAYMENT THANK YOU'],
      ],
    });
    const res = await transactions('/import', 'POST', { bankAccountId: cardId, fileName: 'amex.qbo', content: card });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ format: 'qbo', imported: 4 });

    const lines = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.bankAccountId, cardId));
    for (const line of lines) {
      const categorized = await transactions(`/${line.id}/reconcile`, 'POST', {
        type: 'manual',
        // Purchases are expenses; the payment to the card comes out of the savings account (1200).
        categoryAccountId: Number(line.amount) < 0 ? accountId['4310'] : accountId['1200'],
      });
      expect(categorized.status).toBe(200);
    }
    // 64.20 + 1299 + 20 charged, 1500 paid: the card is overpaid by 116.80 (a debit balance).
    expect(await balanceOf(accountId.cardLedger)).toBe(116.8);
  });
});

// ── Matching ────────────────────────────────────────────────────────────────

describe('matching by name, amount and check number', () => {
  it('suggests the invoice whose customer the free-text description names, without an IBAN', async () => {
    const acme = await createInvoice('pty_acme', '500.00', '2026-02-01');
    const beta = await createInvoice('pty_beta', '500.00', '2026-02-01');
    const [checking] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.accountNumberLast4, '6789'));
    await db.insert(schema.bankTransactions).values({
      id: 'bt_acme_pay', entityId, bankAccountId: checking.id, date: new Date('2026-02-12'), amount: '500.00', status: 'unreconciled',
      description: 'ACH CREDIT ACME CORP PMT', counterpartyName: null,
    });

    const res = await transactions('/bt_acme_pay/suggestions');
    expect(res.status).toBe(200);
    const [best, second] = res.data as Array<{ type: string; id: string; confidence: number; reasons: string[] }>;
    expect(best).toMatchObject({ type: 'invoice', id: acme });
    expect(best.reasons.join(' ')).toMatch(/name matches/);
    expect(second.id).toBe(beta);
    expect(best.confidence).toBeGreaterThan(second.confidence);
  });

  it('matches a cleared check to the payment already recorded and unlinks it again without voiding it', async () => {
    const [checking] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.accountNumberLast4, '6789'));
    const bill = await call('/api/bills', billsRoutes, '/api/bills', 'POST', {
      contactId: 'pty_landlord', issueDate: '2026-02-01', dueDate: '2026-03-01',
      items: [{ description: 'Rent', quantity: '1', unitPrice: '75', taxRateId: 'none', accountId: accountId['4310'] }],
    });
    expect(bill.status).toBe(201);
    await call('/api/bills', billsRoutes, `/api/bills/${bill.data.id}/approve`, 'PATCH');

    // A check we wrote: printed, its number kept on the payment.
    const paid = await payments('', 'POST', { type: 'sent', amount: '75.00', date: '2026-02-06', paymentMethod: 'check', checkNumber: '3001', bankAccountId: checking.id, allocations: [{ billId: bill.data.id, amount: '75.00' }] });
    expect(paid.status).toBe(201);
    expect(paid.data.undeposited).toBe(false);
    const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, paid.data.id));
    expect(payment).toMatchObject({ checkNumber: '3001', checkStatus: 'printed', paymentMethod: 'check' });

    await db.insert(schema.bankTransactions).values({
      id: 'bt_check_3001', entityId, bankAccountId: checking.id, date: new Date('2026-02-14'), amount: '-75.00', status: 'unreconciled',
      description: 'CHECK 3001', checkNumber: '3001', source: 'import',
    });
    const suggestions = await transactions('/bt_check_3001/suggestions');
    expect(suggestions.data[0]).toMatchObject({ type: 'payment', id: paid.data.id });
    expect(suggestions.data[0].confidence).toBeGreaterThanOrEqual(0.9);
    expect(suggestions.data[0].reasons).toContain('check number matches');

    const entriesBefore = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entityId, entityId));
    const matched = await transactions('/bt_check_3001/match-payment', 'POST', { paymentId: paid.data.id });
    expect(matched.status).toBe(200);
    const [line] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_check_3001'));
    expect(line).toMatchObject({ status: 'reconciled', reconciledPaymentId: paid.data.id, reconciliationType: 'payment_link' });
    const [cleared] = await db.select().from(schema.payments).where(eq(schema.payments.id, paid.data.id));
    expect(cleared).toMatchObject({ bankTransactionId: 'bt_check_3001', checkStatus: 'cleared' });
    // Nothing was posted: the payment already held the money.
    expect(await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entityId, entityId))).toHaveLength(entriesBefore.length);

    // The same payment can't be matched twice.
    await db.insert(schema.bankTransactions).values({ id: 'bt_check_dup', entityId, bankAccountId: checking.id, date: new Date('2026-02-15'), amount: '-75.00', status: 'unreconciled', checkNumber: '3001' });
    expect((await transactions('/bt_check_dup/match-payment', 'POST', { paymentId: paid.data.id })).status).toBe(400);
    await db.delete(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_check_dup'));

    const undone = await transactions('/bt_check_3001/unreconcile', 'POST');
    expect(undone.status).toBe(200);
    const [reopened] = await db.select().from(schema.payments).where(eq(schema.payments.id, paid.data.id));
    expect(reopened).toMatchObject({ bankTransactionId: null, checkStatus: 'printed', deletedAt: null });
    expect(await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entityId, entityId))).toHaveLength(entriesBefore.length);
  });

  it('auto-reconciles a line whose check number and amount match a recorded payment', async () => {
    const [checking] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.accountNumberLast4, '6789'));
    const paid = await payments('', 'POST', { type: 'sent', amount: '40.00', date: '2026-02-07', paymentMethod: 'check', checkNumber: '3002', bankAccountId: checking.id, contactId: 'pty_landlord' });
    expect(paid.status).toBe(201);
    await db.insert(schema.bankTransactions).values({ id: 'bt_check_3002', entityId, bankAccountId: checking.id, date: new Date('2026-02-16'), amount: '-40.00', status: 'unreconciled', checkNumber: '3002', description: 'CHECK' });

    const res = await transactions('/auto-reconcile', 'POST', { bankAccountId: checking.id });
    expect(res.status).toBe(200);
    const result = (res.data.results as Array<{ transactionId: string; autoReconciled: boolean; reconciledEntityType?: string }>).find((r) => r.transactionId === 'bt_check_3002');
    expect(result).toMatchObject({ autoReconciled: true, reconciledEntityType: 'payment' });
    const [cleared] = await db.select().from(schema.payments).where(eq(schema.payments.id, paid.data.id));
    expect(cleared.checkStatus).toBe('cleared');
  });

  it('filters payments by check number', async () => {
    const found = await payments('?checkNumber=3002');
    expect(found.status).toBe(200);
    expect(found.data).toHaveLength(1);
    expect(found.data[0]).toMatchObject({ checkNumber: '3002' });
    expect((await payments('?checkNumber=nope')).data).toHaveLength(0);
    expect((await payments('?search=3001')).data).toHaveLength(1);
  });
});

// ── Undeposited Funds and bank deposits ─────────────────────────────────────

describe('undeposited funds and bank deposits', () => {
  let checkingId: string;
  let invoiceA: string;
  let invoiceB: string;
  const paymentIds: string[] = [];
  let depositId: string;
  let depositEntryId: string;
  let baseline: number;

  beforeAll(async () => {
    const [checking] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.accountNumberLast4, '6789'));
    checkingId = checking.id;
    invoiceA = await createInvoice('pty_acme', '100.00', '2026-03-01');
    invoiceB = await createInvoice('pty_beta', '250.00', '2026-03-01');
    baseline = await balanceOf(accountId.checkingLedger);
  });

  it('parks received checks in Undeposited Funds instead of the bank', async () => {
    const first = await payments('', 'POST', { type: 'received', amount: '100.00', date: '2026-03-02', paymentMethod: 'check', checkNumber: '1001', allocations: [{ invoiceId: invoiceA, amount: '100.00' }] });
    const second = await payments('', 'POST', { type: 'received', amount: '250.00', date: '2026-03-03', paymentMethod: 'check', checkNumber: '1002', allocations: [{ invoiceId: invoiceB, amount: '250.00' }] });
    expect(first.status).toBe(201);
    expect(first.data.undeposited).toBe(true);
    paymentIds.push(first.data.id, second.data.id);

    expect(await entryLines(first.data.journalEntryId)).toEqual([
      { code: '1150', debit: 100, credit: 0 },
      { code: '1300', debit: 0, credit: 100 },
    ]);
    expect(await balanceOf('acc_undeposited')).toBe(350);
    expect(await balanceOf(accountId.checkingLedger)).toBe(baseline);
    // A check we receive is not "printed" by us.
    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.id, first.data.id));
    expect(row.checkStatus).toBeNull();

  });

  it('lists what waits in Undeposited Funds', async () => {
    const res = await deposits('/undeposited');
    expect(res.status).toBe(200);
    expect(res.data).toHaveLength(2);
    expect(res.data[0]).toMatchObject({ paymentId: paymentIds[0], checkNumber: '1001', amount: 100, contactName: 'Acme Corporation' });
    expect(res.data[1]).toMatchObject({ paymentId: paymentIds[1], checkNumber: '1002', amount: 250 });
  });

  it('posts one deposit: Dr bank, Cr Undeposited Funds per payment', async () => {
    const res = await deposits('', 'POST', { bankAccountId: checkingId, date: '2026-03-05', paymentIds, memo: 'March 5 deposit' });
    expect(res.status).toBe(201);
    expect(res.data.amount).toBe('350.00');
    depositId = res.data.id;
    depositEntryId = res.data.journalEntryId;

    expect(await entryLines(depositEntryId)).toEqual([
      { code: '1150', debit: 0, credit: 100 },
      { code: '1150', debit: 0, credit: 250 },
      { code: '1201', debit: 350, credit: 0 },
    ]);
    expect(await balanceOf('acc_undeposited')).toBe(0);
    const stamped = await db.select().from(schema.payments).where(eq(schema.payments.depositId, depositId));
    expect(stamped.map((p) => p.id).sort()).toEqual([...paymentIds].sort());
    expect((await deposits('/undeposited')).data).toHaveLength(0);

    const detail = await deposits(`/${depositId}`);
    expect(detail.data).toMatchObject({ amount: '350.00', status: 'posted', memo: 'March 5 deposit', bankAccountName: 'Chase Operating' });
    expect(detail.data.payments).toHaveLength(2);

    // Same payments can't go into a second deposit, and a deposited payment can't be voided.
    const dup = await deposits('', 'POST', { bankAccountId: checkingId, date: '2026-03-06', paymentIds: [paymentIds[0]] });
    expect(dup.status).toBe(400);
    const blocked = await payments(`/${paymentIds[0]}`, 'DELETE');
    expect(blocked.status).toBe(400);
    expect(blocked.error?.message).toMatch(/bank deposit/);
  });

  it('matches the deposit to the single bank line, suggests it by amount, and unreconcile releases it', async () => {
    await db.insert(schema.bankTransactions).values({
      id: 'bt_deposit', entityId, bankAccountId: checkingId, date: new Date('2026-03-06'), amount: '350.00', status: 'unreconciled', description: 'DEPOSIT', source: 'import',
    });
    const suggestions = await transactions('/bt_deposit/suggestions');
    expect(suggestions.data[0]).toMatchObject({ type: 'deposit', id: depositId });
    expect(suggestions.data[0].confidence).toBeGreaterThanOrEqual(0.6);

    const bankBefore = await balanceOf(accountId.checkingLedger);
    const matched = await transactions('/bt_deposit/match-deposit', 'POST', { depositId });
    expect(matched.status).toBe(200);
    const [line] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_deposit'));
    expect(line).toMatchObject({ status: 'reconciled', depositId, journalEntryId: depositEntryId, reconciliationType: 'deposit' });
    const [deposit] = await db.select().from(schema.bankDeposits).where(eq(schema.bankDeposits.id, depositId));
    expect(deposit.bankTransactionId).toBe('bt_deposit');
    expect(await balanceOf(accountId.checkingLedger)).toBe(bankBefore);

    await db.insert(schema.bankTransactions).values({ id: 'bt_wrong', entityId, bankAccountId: checkingId, date: new Date('2026-03-06'), amount: '349.00', status: 'unreconciled' });
    expect((await transactions('/bt_wrong/match-deposit', 'POST', { depositId })).status).toBe(400);

    expect((await transactions('/bt_deposit/unreconcile', 'POST')).status).toBe(200);
    const [released] = await db.select().from(schema.bankDeposits).where(eq(schema.bankDeposits.id, depositId));
    expect(released.bankTransactionId).toBeNull();
    const [reopened] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_deposit'));
    expect(reopened).toMatchObject({ status: 'unreconciled', depositId: null, journalEntryId: null });
    // Matching again works, and leaves the ledger as the deposit made it.
    expect((await transactions('/bt_deposit/match-deposit', 'POST', { depositId })).status).toBe(200);
    expect(await balanceOf(accountId.checkingLedger)).toBe(bankBefore);
  });

  it('changes the memo only, and voids: entry reversed, payments back in Undeposited Funds, bank line released', async () => {
    const renamed = await deposits(`/${depositId}`, 'PATCH', { memo: 'Deposit slip 18' });
    expect(renamed.status).toBe(200);
    expect((await deposits(`/${depositId}`)).data.memo).toBe('Deposit slip 18');
    expect((await deposits(`/${depositId}`, 'PATCH', { memo: 'Deposit slip 18', amount: 1 })).data.amount).toBe('350.00');

    const voided = await deposits(`/${depositId}`, 'DELETE');
    expect(voided.status).toBe(204);
    const [deposit] = await db.select().from(schema.bankDeposits).where(eq(schema.bankDeposits.id, depositId));
    expect(deposit.status).toBe('void');
    expect(await balanceOf('acc_undeposited')).toBe(350);
    expect(await balanceOf(accountId.checkingLedger)).toBe(baseline);
    expect((await deposits('/undeposited')).data).toHaveLength(2);
    const [line] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_deposit'));
    expect(line).toMatchObject({ status: 'unreconciled', depositId: null });
    const [original] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, depositEntryId));
    expect(original.status).toBe('reversed');

    expect((await deposits(`/${depositId}`, 'DELETE')).status).toBe(400);
  });

  it('takes other lines on the slip: money added, and cash back taken out', async () => {
    const res = await deposits('', 'POST', {
      bankAccountId: checkingId,
      date: '2026-03-08',
      paymentIds: [paymentIds[0]],
      otherLines: [
        { accountId: accountId['8990'], amount: 5, description: 'Interest' },
        { accountId: accountId['4990'], amount: -10, description: 'Cash back' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.data.amount).toBe('95.00');
    expect(await entryLines(res.data.journalEntryId)).toEqual([
      { code: '1150', debit: 0, credit: 100 },
      { code: '1201', debit: 95, credit: 0 },
      { code: '4990', debit: 10, credit: 0 },
      { code: '8990', debit: 0, credit: 5 },
    ]);
    // Undo it so the next tests start from the two payments waiting.
    expect((await deposits(`/${res.data.id}`, 'DELETE')).status).toBe(204);
    expect(await balanceOf('acc_undeposited')).toBe(350);
  });

  it('pages deposits with a cursor and refuses a deposit without a bank ledger account', async () => {
    const one = await deposits('', 'POST', { bankAccountId: checkingId, date: '2026-03-09', paymentIds: [paymentIds[0]] });
    const two = await deposits('', 'POST', { bankAccountId: checkingId, date: '2026-03-10', paymentIds: [paymentIds[1]] });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);

    const page = await deposits('?status=posted&limit=1');
    expect(page.data).toHaveLength(1);
    expect(page.data[0].id).toBe(two.data.id);
    expect(page.pagination).toMatchObject({ hasMore: true, totalCount: 2 });
    const next = await deposits(`?status=posted&limit=1&cursor=${page.pagination!.cursor}`);
    expect(next.data.map((d: { id: string }) => d.id)).toEqual([one.data.id]);
    expect(next.pagination).toMatchObject({ hasMore: false, cursor: null });

    await db.insert(schema.bankAccounts).values({ id: 'ba_unlinked', entityId, name: 'Unlinked', currency: 'USD', accountType: 'checking' });
    const none = await deposits('', 'POST', { bankAccountId: 'ba_unlinked', date: '2026-03-11', paymentIds: [] , otherLines: [{ accountId: accountId['8990'], amount: 5 }] });
    expect(none.status).toBe(400);
    expect(none.error?.message).toMatch(/not linked to a ledger account/);
  });
});

describe('an entity without an Undeposited Funds account', () => {
  it('debits the bank straight away, as before', async () => {
    const other = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
      name: 'Plain BV', jurisdictionCode: 'NL', vatNumber: 'NL987654321B01', taxIdentifiers: { registrationNumber: '87654321' }, bankDetails: { iban: 'NL91ABNA0417164300' },
    });
    expect(other.status).toBe(201);
    const previous = entityId;
    entityId = other.data.id as string;
    try {
      const invoice = await createInvoice('pty_acme', '60.00');
      const paid = await payments('', 'POST', { type: 'received', amount: '60.00', date: '2026-03-01', paymentMethod: 'check', checkNumber: '77', allocations: [{ invoiceId: invoice, amount: '60.00' }] });
      expect(paid.status).toBe(201);
      expect(paid.data.undeposited).toBe(false);
      const lines = await entryLines(paid.data.journalEntryId);
      expect(lines.map((l) => l.code).sort()).toEqual(['1100', '1300']);
      const direct = await payments('', 'POST', { type: 'received', amount: '2.00', date: '2026-03-01', paymentMethod: 'check', depositTo: 'bank', contactId: 'pty_acme' });
      expect(direct.data.undeposited).toBe(false);
      const explicit = await payments('', 'POST', { type: 'received', amount: '1.00', date: '2026-03-01', paymentMethod: 'check', depositTo: 'undeposited_funds', contactId: 'pty_acme' });
      expect(explicit.status).toBe(400);
      expect(explicit.error?.message).toMatch(/no Undeposited Funds account/);
    } finally {
      entityId = previous;
    }
  });
});

// ── Statement reconciliation ────────────────────────────────────────────────

describe('statement reconciliation', () => {
  let checkingId: string;
  let ledgerId: string;
  let first: { id: string };

  beforeAll(async () => {
    const [checking] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.accountNumberLast4, '6789'));
    checkingId = checking.id;
    ledgerId = checking.ledgerAccountId!;
  });

  /** Ledger lines of the checking account that no reconciliation has cleared. */
  async function stamped() {
    const rows = await db.select({ id: schema.journalLines.id, reconciliationId: schema.journalLines.reconciliationId, reconciled: schema.journalLines.reconciled })
      .from(schema.journalLines).where(eq(schema.journalLines.accountId, ledgerId));
    return rows;
  }

  it('shows the open lines with their documents and works out the difference as lines are ticked', async () => {
    // Two checks deposited March 9-10 (350 in) and two checks written in February (75 and 40 out). The statement is dated past
    // today so the reversals of the voided deposits fall inside it and net out with their originals.
    const started = await reconciliations('', 'POST', { bankAccountId: checkingId, statementDate: '2099-06-30', statementEndingBalance: '235.00' });
    expect(started.status).toBe(201);
    first = started.data;
    expect(started.data).toMatchObject({ status: 'in_progress', accountKind: 'bank', beginningBalance: '0.00', statementEndingBalance: '235.00', clearedBalance: '0.00', difference: '235.00' });
    expect(started.data.nettedLineCount).toBe(4);
    expect(started.data.inflows.map((l: { amount: number }) => l.amount).sort((a: number, b: number) => a - b)).toEqual([100, 250]);
    expect(started.data.outflows.map((l: { amount: number }) => l.amount).sort((a: number, b: number) => a - b)).toEqual([40, 75]);
    const deposit = started.data.inflows.find((l: { amount: number }) => l.amount === 250);
    expect(deposit.document).toMatchObject({ type: 'bank_deposit' });
    const check = started.data.outflows.find((l: { amount: number }) => l.amount === 75);
    expect(check.document).toMatchObject({ type: 'payment_sent', checkNumber: '3001', method: 'check' });

    // A second reconciliation can't start while one is open.
    const conflict = await reconciliations('', 'POST', { bankAccountId: checkingId, statementDate: '2099-07-31', statementEndingBalance: 0 });
    expect(conflict.status).toBe(409);
    expect(conflict.error?.details).toMatchObject({ reconciliationId: first.id });

    const ids = [...started.data.inflows, ...started.data.outflows].map((l: { id: string }) => l.id);
    const saved = await reconciliations(`/${first.id}`, 'PATCH', { clearedLineIds: [started.data.inflows[0].id] });
    expect(saved.status).toBe(200);
    expect(saved.data.clearedBalance).toBe('100.00');
    expect(saved.data.difference).toBe('135.00');
    expect((await reconciliations(`/${first.id}`, 'PATCH', { clearedLineIds: ['jl_missing'] })).status).toBe(400);

    const early = await reconciliations(`/${first.id}/complete`, 'POST', {});
    expect(early.status).toBe(400);
    expect(early.error?.message).toMatch(/difference is 135\.00/);

    // 350 - 75 - 40 = 235: tick everything.
    const all = await reconciliations(`/${first.id}`, 'PATCH', { clearedLineIds: ids });
    expect(all.data).toMatchObject({ clearedBalance: '235.00', difference: '0.00' });
    expect(all.data.totals.inflows).toMatchObject({ count: 2, clearedCount: 2, clearedTotal: 350 });
  });

  it('completes at difference zero: stamps the lines, stores the report, keeps the history', async () => {
    const done = await reconciliations(`/${first.id}/complete`, 'POST', {});
    expect(done.status).toBe(200);
    expect(done.data).toMatchObject({ status: 'completed', clearedBalance: '235.00', difference: '0.00' });

    const lines = await stamped();
    const cleared = lines.filter((l) => l.reconciliationId === first.id);
    // Four ticked lines and the two voided deposits with their reversals.
    expect(cleared).toHaveLength(8);
    expect(cleared.every((l) => l.reconciled === true)).toBe(true);

    const report = await reconciliations(`/${first.id}/report`);
    expect(report.status).toBe(200);
    expect(report.data.summary).toMatchObject({ beginningBalance: 0, clearedBalance: 235, statementEndingBalance: 235, difference: 0 });
    expect(report.data.clearedInflows).toMatchObject({ count: 2, total: 350 });
    expect(report.data.clearedOutflows.count).toBe(2);
    expect(report.data.clearedOutflows.items.map((i: { checkNumber: string | null }) => i.checkNumber).sort()).toEqual(['3001', '3002']);

    const history = await reconciliations(`?bankAccountId=${checkingId}`);
    expect(history.data).toHaveLength(1);
    expect(history.data[0]).toMatchObject({ id: first.id, status: 'completed', hasReport: true });
    expect(history.data[0].report).toBeUndefined();

    // Nothing left to tick before the next statement, which starts where this one ended.
    const next = await reconciliations('', 'POST', { bankAccountId: checkingId, statementDate: '2099-07-31', statementEndingBalance: 235 });
    expect(next.data).toMatchObject({ beginningBalance: '235.00', difference: '0.00' });
    expect(next.data.inflows).toHaveLength(0);
    expect((await reconciliations('', 'POST', { bankAccountId: checkingId, statementDate: '2099-03-01', statementEndingBalance: 0 })).status).toBe(409);
    expect((await reconciliations(`/${next.data.id}`, 'DELETE')).status).toBe(204);
    expect((await reconciliations('', 'POST', { bankAccountId: checkingId, statementDate: '2099-03-15', statementEndingBalance: 0 })).error?.message).toMatch(/after the last reconciled statement/);
  });

  it('undoes only the latest completed reconciliation, and only with banking:manage', async () => {
    const second = await reconciliations('', 'POST', { bankAccountId: checkingId, statementDate: '2099-07-31', statementEndingBalance: 235 });
    expect((await reconciliations(`/${second.data.id}/complete`, 'POST', {})).status).toBe(200);

    expect((await reconciliations(`/${first.id}/undo`, 'POST', undefined, ['banking:update'])).status).toBe(403);
    const notLatest = await reconciliations(`/${first.id}/undo`, 'POST');
    expect(notLatest.status).toBe(400);
    expect(notLatest.error?.message).toMatch(/Undo the latest reconciliation first/);

    expect((await reconciliations(`/${second.data.id}/undo`, 'POST')).data.status).toBe('undone');
    const undone = await reconciliations(`/${first.id}/undo`, 'POST');
    expect(undone.status).toBe(200);
    expect(undone.data.status).toBe('undone');

    const lines = await stamped();
    expect(lines.every((l) => l.reconciliationId === null && l.reconciled === false)).toBe(true);
    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityType, 'bank_reconciliation'), eq(schema.auditLog.action, 'undone')));
    expect(audit.map((a) => a.entityId).sort()).toEqual([first.id, second.data.id].sort());
    expect(events.filter((e) => e.eventType === 'bank_reconciliation:undone')).toHaveLength(2);
  });

  it('posts the difference to an account (a bank fee) and clears it, and undo reverses that entry', async () => {
    const started = await reconciliations('', 'POST', { bankAccountId: checkingId, statementDate: '2099-06-30', statementEndingBalance: '230.00' });
    expect(started.status).toBe(201);
    const ids = [...started.data.inflows, ...started.data.outflows].map((l: { id: string }) => l.id);
    await reconciliations(`/${started.data.id}`, 'PATCH', { clearedLineIds: ids });

    // The statement is 5.00 lower than the books: a fee that was never recorded.
    const refused = await reconciliations(`/${started.data.id}/complete`, 'POST', {});
    expect(refused.status).toBe(400);
    const bankBefore = await balanceOf(ledgerId);
    const done = await reconciliations(`/${started.data.id}/complete`, 'POST', { adjustment: { accountId: accountId['4990'], memo: 'March service fee' } });
    expect(done.status).toBe(200);
    expect(done.data.adjustmentJournalEntryId).toMatch(/^je_/);
    expect(await entryLines(done.data.adjustmentJournalEntryId)).toEqual([
      { code: '1201', debit: 0, credit: 5 },
      { code: '4990', debit: 5, credit: 0 },
    ]);
    expect(await balanceOf(ledgerId)).toBe(bankBefore - 5);
    const stampedNow = (await stamped()).filter((l) => l.reconciliationId === started.data.id);
    // Four ticked, four netted, and the adjustment's bank line.
    expect(stampedNow).toHaveLength(9);
    const report = await reconciliations(`/${started.data.id}/report`);
    expect(report.data.adjustment).toMatchObject({ amount: 5, difference: -5, journalEntryId: done.data.adjustmentJournalEntryId });

    const undone = await reconciliations(`/${started.data.id}/undo`, 'POST');
    expect(undone.status).toBe(200);
    expect(await balanceOf(ledgerId)).toBe(bankBefore);
    const [adjustment] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, done.data.adjustmentJournalEntryId));
    expect(adjustment.status).toBe('reversed');
    expect((await stamped()).every((l) => l.reconciliationId === null)).toBe(true);
  });

  it('flips the signs for a credit card: the statement balance is what is owed', async () => {
    const [card] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.accountNumberLast4, '1111'));
    // Charges 1383.20 (credits on the liability), a payment of 1500 (debit): the balance owed is -116.80.
    const started = await reconciliations('', 'POST', { bankAccountId: card.id, statementDate: '2026-02-28', statementEndingBalance: '-116.80' });
    expect(started.status).toBe(201);
    expect(started.data.accountKind).toBe('credit_card');
    expect(started.data.outflows.map((l: { amount: number }) => l.amount).sort((a: number, b: number) => a - b)).toEqual([20, 64.2, 1299]);
    expect(started.data.inflows.map((l: { amount: number }) => l.amount)).toEqual([1500]);

    const ids = [...started.data.inflows, ...started.data.outflows].map((l: { id: string }) => l.id);
    const ticked = await reconciliations(`/${started.data.id}`, 'PATCH', { clearedLineIds: ids });
    expect(ticked.data).toMatchObject({ clearedBalance: '-116.80', difference: '0.00' });
    const done = await reconciliations(`/${started.data.id}/complete`, 'POST', {});
    expect(done.status).toBe(200);
    expect(done.data.status).toBe('completed');
  });
});

// ── The US chart ────────────────────────────────────────────────────────────

describe('on a US entity with the real chart', () => {
  let usEntityId: string;
  let previous: string;

  beforeAll(async () => {
    const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
      name: 'Acme Studio LLC',
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      taxIdentifiers: { einOrSsn: '123456789' },
      address: { line1: '1 Congress Ave', city: 'Austin', state: 'tx', postalCode: '78701' },
    });
    expect(created.status).toBe(201);
    usEntityId = created.data.id as string;
    previous = entityId;
    entityId = usEntityId;
  });

  it('takes over the chart\'s own Checking, Savings and Line of credit, and gives each card a child of Credit Card Payable', async () => {
    const checking = await bankAccounts('', 'POST', { name: 'Chase Business Checking', accountType: 'checking', routingNumber: '021000021', accountNumber: '4455667788' });
    expect(checking.status).toBe(201);
    expect(checking.data.ledgerAccount).toMatchObject({ code: '1000', name: 'Checking', created: false });

    // A second checking account is a new account, carrying the income-tax line of the first.
    const second = await bankAccounts('', 'POST', { name: 'Wells Fargo Operating', accountType: 'checking' });
    expect(second.data.ledgerAccount).toMatchObject({ created: true });
    const [secondLedger] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, second.data.ledgerAccount.id));
    const [firstLedger] = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, usEntityId)).then((rows) => rows.filter((r) => r.code === '1000'));
    expect(secondLedger).toMatchObject({ type: 'asset', subtype: 'bank', taxLine: firstLedger.taxLine });
    expect(firstLedger.taxLine).toBeTruthy();

    const savings = await bankAccounts('', 'POST', { name: 'Emergency savings', accountType: 'savings' });
    expect(savings.data.ledgerAccount).toMatchObject({ code: '1010', created: false });
    const loc = await bankAccounts('', 'POST', { name: 'Bank LOC', accountType: 'line_of_credit' });
    expect(loc.data.ledgerAccount).toMatchObject({ code: '2500', created: false });

    const card = await bankAccounts('', 'POST', { name: 'Chase Ink', accountType: 'credit_card', accountNumber: '5555444433332222' });
    expect(card.data.ledgerAccount).toMatchObject({ code: '2101', created: true });
    const [cardLedger] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, card.data.ledgerAccount.id));
    const [payable] = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, usEntityId)).then((rows) => rows.filter((r) => r.code === '2100'));
    expect(cardLedger).toMatchObject({ type: 'liability', normalSide: 'credit', parentAccountId: payable.id, taxLine: payable.taxLine });
  });

  it('parks a received check in the chart\'s Undeposited funds and deposits it into Checking', async () => {
    const paid = await payments('', 'POST', { type: 'received', amount: '480.00', date: '2026-03-02', paymentMethod: 'check', checkNumber: '5001', contactId: 'pty_acme' });
    expect(paid.status).toBe(201);
    expect(paid.data.undeposited).toBe(true);
    // Dr Undeposited funds / Cr Accounts receivable (an unapplied payment stays on the customer).
    expect(await entryLines(paid.data.journalEntryId)).toEqual([
      { code: '1050', debit: 480, credit: 0 },
      { code: '1100', debit: 0, credit: 480 },
    ]);

    const [checking] = await db.select().from(schema.bankAccounts).where(and(eq(schema.bankAccounts.entityId, usEntityId), eq(schema.bankAccounts.accountNumberLast4, '7788')));
    const deposit = await deposits('', 'POST', { bankAccountId: checking.id, date: '2026-03-04', paymentIds: [paid.data.id] });
    expect(deposit.status).toBe(201);
    expect(await entryLines(deposit.data.journalEntryId)).toEqual([
      { code: '1000', debit: 480, credit: 0 },
      { code: '1050', debit: 0, credit: 480 },
    ]);
    expect((await deposits('/undeposited')).data).toHaveLength(0);
  });

  it('keeps what waits in Undeposited Funds apart per entity', async () => {
    const waiting = await payments('', 'POST', { type: 'received', amount: '30.00', date: '2026-03-05', paymentMethod: 'cash', contactId: 'pty_acme' });
    expect(waiting.data.undeposited).toBe(true);
    expect((await deposits('/undeposited')).data.map((p: { paymentId: string }) => p.paymentId)).toEqual([waiting.data.id]);
    entityId = previous;
    expect((await deposits('/undeposited')).data).toHaveLength(0);
    entityId = usEntityId;
  });
});
