/**
 * /api/bank-transactions (pglite): statement import in every format (OFX,
 * BAI2, MT940, CAMT.053, the Dutch bank CSVs, CSV with a confirmed layout)
 * with preview, dedupe and the account / currency checks; the list with its
 * filters; matching a line to an invoice, a bill, a recorded payment and a
 * deposit, posting it straight to an account, and undoing each; the automatic
 * matcher; excluding; and the refusals.
 *
 * Invoices, bills, payments and deposits are seeded as rows (or through the
 * payment service), so only the banking routes are exercised.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { bankAccountsRoutes } from '../bank-accounts';
import { bankTransactionsRoutes } from './index';
import { recordPayment } from '../../services/accounting-payments';

const KEY = `${'0'.repeat(63)}1`;
const env = { DATABASE_ENCRYPTION_KEY: KEY };

let db: Database;
let entityId = '';
let bankId = '';
let cardId = '';
let bankLedgerId = '';

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
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = text ? (JSON.parse(text) as { data?: any; error?: { code: string; message: string; details?: any }; pagination?: any }) : {};
  return { status: res.status, ...json };
}

const lines = (path = '', method = 'GET', body?: unknown, perms?: string[]) =>
  call('/api/bank-transactions', bankTransactionsRoutes, `/api/bank-transactions${path}`, method, body, perms);

function ofx(acct: string, rows: Array<[string, string, number, string, string?, string?]>, curdef = 'EUR') {
  const body = rows
    .map(
      ([fitid, date, amount, name, memo, check]) =>
        `<STMTTRN>\n<TRNTYPE>${amount < 0 ? 'DEBIT' : 'CREDIT'}\n<DTPOSTED>${date}\n<TRNAMT>${amount.toFixed(2)}\n<FITID>${fitid}\n${check ? `<CHECKNUM>${check}\n` : ''}<NAME>${name}\n${memo ? `<MEMO>${memo}\n` : ''}</STMTTRN>`,
    )
    .join('\n');
  return `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX>\n<BANKMSGSRSV1>\n<STMTTRNRS>\n<STMTRS>\n<CURDEF>${curdef}\n<BANKACCTFROM>\n<BANKID>021000021\n<ACCTID>${acct}\n<ACCTTYPE>CHECKING\n</BANKACCTFROM>\n<BANKTRANLIST>\n<DTSTART>20260101\n<DTEND>20260131\n${body}\n</BANKTRANLIST>\n<LEDGERBAL>\n<BALAMT>1000.00\n<DTASOF>20260131\n</LEDGERBAL>\n</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>\n`;
}

async function lineByDescription(description: string) {
  const [row] = await db
    .select()
    .from(schema.bankTransactions)
    .where(and(eq(schema.bankTransactions.description, description), eq(schema.bankTransactions.bankAccountId, bankId)))
    .limit(1);
  if (!row) throw new Error(`no line ${description}`);
  return row;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name: 'Bank Lines BV',
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
    address: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id;

  const [ledger] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.entityId, entityId), eq(schema.accounts.subtype, 'bank')))
    .limit(1);
  bankLedgerId = ledger!.id;
  const bank = await call('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', 'POST', {
    name: 'Main',
    currency: 'EUR',
    ledgerAccountId: bankLedgerId,
    accountNumber: '9988776655',
    autoReconcile: false,
  });
  expect(bank.status).toBe(201);
  bankId = bank.data.id;
  const card = await call('/api/bank-accounts', bankAccountsRoutes, '/api/bank-accounts', 'POST', { name: 'Side', currency: 'EUR' });
  cardId = card.data.id;

  const now = new Date();
  await db.insert(schema.parties).values([
    { id: 'pty_bl_acme', kind: 'company', displayName: 'Acme Corp', iban: 'NL02RABO0123456789', createdAt: now, updatedAt: now },
    { id: 'pty_bl_energy', kind: 'company', displayName: 'Energie Leverancier BV', createdAt: now, updatedAt: now },
    { id: 'pty_bl_client', kind: 'company', displayName: 'Client Holding', createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.invoices).values([
    { id: 'inv_bl_1', entityId, contactId: 'pty_bl_acme', contactName: 'Acme Corp', invoiceNumber: 'INV-2001', status: 'finalized', issueDate: new Date('2026-01-05T00:00:00Z'), dueDate: new Date('2026-02-04T00:00:00Z'), currency: 'EUR', total: '121.00', balanceDue: '121.00', amountPaid: '0', createdAt: now, updatedAt: now },
    { id: 'inv_bl_2', entityId, contactId: 'pty_bl_client', contactName: 'Client Holding', invoiceNumber: 'INV-2002', status: 'sent', issueDate: new Date('2026-01-06T00:00:00Z'), dueDate: new Date('2026-02-05T00:00:00Z'), currency: 'EUR', total: '500.00', balanceDue: '500.00', amountPaid: '0', createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.bills).values({
    id: 'bill_bl_1', entityId, contactId: 'pty_bl_energy', contactName: 'Energie Leverancier BV', billNumber: 'B-77', externalReference: 'ENR-77', status: 'approved', issueDate: new Date('2026-01-03T00:00:00Z'), dueDate: new Date('2026-01-31T00:00:00Z'), currency: 'EUR', total: '50.00', balanceDue: '50.00', amountPaid: '0', createdAt: now, updatedAt: now,
  });
}, 120_000);

describe('import and preview', () => {
  it('previews an OFX file and imports it once', async () => {
    const file = ofx('9988776655', [
      ['F1', '20260110', 121, 'ACME CORP', 'Payment INV-2001'],
      ['F2', '20260111', -50, 'Energie Leverancier', 'ENR-77'],
      ['F3', '20260112', -12.5, 'Bank fee'],
      ['F4', '20260113', 75.25, 'Client Holding', 'Deposit', '1042'],
    ]);
    const preview = await lines('/import/preview', 'POST', { bankAccountId: bankId, content: file, fileName: 'jan.qfx', sampleSize: 2 });
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ format: 'qfx', needsCsvFormat: false, totalParsed: 4, duplicates: 0, problem: null, currency: 'EUR', closingBalance: 1000 });
    expect(preview.data.account).toMatchObject({ accountNumberLast4: '6655', accountType: 'checking' });
    expect(preview.data.account.accountNumber).toBeUndefined();
    expect(preview.data.sample).toHaveLength(2);

    const imported = await lines('/import', 'POST', { bankAccountId: bankId, content: file, fileName: 'jan.ofx' });
    expect(imported.status).toBe(201);
    expect(imported.data).toMatchObject({ format: 'ofx', totalParsed: 4, imported: 4, duplicates: 0, closingBalance: 1000, currency: 'EUR', warning: null });

    const again = await lines('/import', 'POST', { bankAccountId: bankId, content: file, fileName: 'jan.ofx' });
    expect(again.data).toMatchObject({ imported: 0, duplicates: 4 });
    const repeat = await lines('/import/preview', 'POST', { bankAccountId: bankId, content: file });
    expect(repeat.data.duplicates).toBe(4);
  });

  it('refuses a file for another account or currency unless told to import anyway', async () => {
    const other = ofx('1111222233', [['G1', '20260115', 10, 'Other']]);
    const refused = await lines('/import', 'POST', { bankAccountId: bankId, content: other, fileName: 'x.ofx' });
    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('ACCOUNT_MISMATCH');
    const forced = await lines('/import', 'POST', { bankAccountId: bankId, content: other, fileName: 'x.ofx', ignoreAccountMismatch: true });
    expect(forced.status).toBe(201);
    expect(forced.data.warning.code).toBe('ACCOUNT_MISMATCH');

    const dollars = ofx('9988776655', [['H1', '20260116', 10, 'Dollar']], 'USD');
    const currency = await lines('/import', 'POST', { bankAccountId: bankId, content: dollars, fileName: 'x.ofx' });
    expect(currency.status).toBe(409);
    expect(currency.error?.code).toBe('CURRENCY_MISMATCH');
    const preview = await lines('/import/preview', 'POST', { bankAccountId: bankId, content: dollars, fileName: 'x.ofx' });
    expect(preview.data.problem.code).toBe('CURRENCY_MISMATCH');
  });

  it('asks for a CSV layout, imports with it and remembers it', async () => {
    const csv = 'Posted Date,Details,Amount,Check Number\n01/20/2026,Coffee supplies,-8.40,\n01/21/2026,Refund,15.00,000123\n';
    const ask = await lines('/import', 'POST', { bankAccountId: cardId, content: csv, fileName: 'a.csv' });
    expect(ask.status).toBe(422);
    expect(ask.error?.code).toBe('CSV_FORMAT_REQUIRED');
    const proposal = ask.error?.details.proposal;
    expect(proposal.format.columns.date).toBe('Posted Date');

    const preview = await lines('/import/preview', 'POST', { bankAccountId: cardId, content: csv });
    expect(preview.data).toMatchObject({ format: 'csv', needsCsvFormat: true });
    const free = await lines('/import/preview', 'POST', { content: csv, csvFormat: proposal.format });
    expect(free.data).toMatchObject({ format: 'csv', totalParsed: 2, duplicates: null, problem: null });
    expect(free.data.proposal).toBeUndefined();

    const imported = await lines('/import', 'POST', { bankAccountId: cardId, content: csv, fileName: 'a.csv', csvFormat: proposal.format, rememberCsvFormat: true });
    expect(imported.status).toBe(201);
    expect(imported.data).toMatchObject({ imported: 2, csvFormatRemembered: true });
    const remembered = await lines('/import/preview', 'POST', { bankAccountId: cardId, content: csv });
    expect(remembered.data).toMatchObject({ needsCsvFormat: false, duplicates: 2 });
    expect(remembered.data.proposal).toBeUndefined();

    const bad = await lines('/import/preview', 'POST', { content: csv, csvFormat: { ...proposal.format, columns: { date: 'Missing', description: 'Details', amount: 'Amount' } } });
    expect(bad.data.errors[0].message).toBe('Date column "Missing" was not found in the header row');
  });

  it('reads MT940, CAMT.053, BAI2 and the Dutch bank CSVs', async () => {
    const mt940 = ':20:ABN AMRO BANK NV\n:25:NL91ABNA0417164300\n:28:00001/1\n:60F:C260101EUR1000,00\n:61:2601020102D25,50N071NONREF//BREF1\n:86:/CNTP/NL02RABO0123456789/RABONL2U/Energie BV/AMSTERDAM//REMI/USTD//Factuur 2026-01/EREF/E2E-1/\n:61:2601030103C100,00N078INV-7\n:86:>00SEPA OVERBOEKING>20Factuur>31NL02 RABO 0123 4567 89>32Klant\n:62F:C260103EUR1074,50\n-';
    const mt = await lines('/import/preview', 'POST', { bankAccountId: cardId, content: mt940 });
    expect(mt.data).toMatchObject({ format: 'mt940', totalParsed: 2, openingBalance: 1000, closingBalance: 1074.5 });

    const camt = `<?xml version="1.0"?><Document><BkToCstmrStmt><Stmt><Acct><Id><IBAN>NL91ABNA0417164300</IBAN></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">950.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><Amt Ccy="EUR">50.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-01-05</Dt></BookgDt><AcctSvcrRef>REF-1</AcctSvcrRef>
<NtryDtls><TxDtls><RmtInf><Ustrd>Rent January</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`;
    const camtImport = await lines('/import', 'POST', { bankAccountId: cardId, content: camt, fileName: 'jan.xml' });
    expect(camtImport.status).toBe(201);
    expect(camtImport.data).toMatchObject({ format: 'camt053', imported: 1 });

    const bai2 = '01,121000248,WELD,260301,0800,1,,,2/\n02,WELD,121000248,1,260228,,EUR,2/\n03,5555666677,EUR,010,150000,,,015,250000,,/\n16,475,12500,,0000001042,1042/\n16,142,22500,,REF1,,ACME CORP\n88,INV 2001/\n49,500000,3/\n03,1111222233,EUR,015,1000,,/\n49,1000,1/\n98,500000,1,5/\n99,500000,1,7/\n';
    const many = await lines('/import/preview', 'POST', { content: bai2, fileName: 'x.bai' });
    expect(many.data.totalParsed).toBe(0);
    expect(many.data.accounts).toHaveLength(2);
    expect(many.data.errors[0].message).toContain('This file holds 2 accounts');

    const ing = '"Datum","Naam / Omschrijving","Rekening","Tegenrekening","Code","Af Bij","Bedrag (EUR)","Mutatiesoort","Mededelingen"\n"20260105","Energie BV","NL91INGB0001234567","NL02RABO0123456789","IC","Af","25,50","Incasso","Kenmerk: ABC-1 Factuur"\n';
    const ingImport = await lines('/import', 'POST', { bankAccountId: bankId, content: ing, fileName: 'ing.csv' });
    expect(ingImport.data).toMatchObject({ format: 'csv', imported: 1 });
  });

  it('validates the file bodies and the account', async () => {
    expect((await lines('/import', 'POST', { bankAccountId: bankId, content: '', fileName: '' })).status).toBe(400);
    expect((await lines('/import', 'POST', { bankAccountId: bankId, content: 'x', fileName: 'x', format: 'pdf' })).status).toBe(400);
    expect((await lines('/import/preview', 'POST', { content: 'x', sampleSize: 0 })).status).toBe(400);
    expect((await lines('/import', 'POST', { bankAccountId: 'ba_missing', content: 'x', fileName: 'x' })).status).toBe(404);
    expect((await lines('/import/preview', 'POST', { bankAccountId: 'ba_missing', content: 'x' })).status).toBe(404);
    expect((await lines('/import', 'POST', { bankAccountId: bankId, content: 'x', fileName: 'x' }, ['banking:read'])).status).toBe(403);
  });
});

describe('listing', () => {
  it('pages and filters the lines', async () => {
    const all = await lines('?pageSize=3');
    expect(all.status).toBe(200);
    expect(all.data).toHaveLength(3);
    expect(all.pagination.hasMore).toBe(true);
    const second = await lines('?pageSize=3&page=2');
    expect(second.pagination.cursor).toBeNull();
    const main = await lines(`?bankAccountId=${bankId}&status=unreconciled&source=import`);
    expect(main.data.every((l: { bankAccountId: string }) => l.bankAccountId === bankId)).toBe(true);
    const search = await lines('?search=Energie');
    expect(search.data.length).toBeGreaterThan(0);
    const check = await lines('?search=1042');
    expect(check.data.length).toBeGreaterThan(0);
    const dated = await lines('?from=2026-01-11&to=2026-01-12');
    expect(dated.data.length).toBeGreaterThan(0);
    const byCheck = await lines('?checkNumber=1042&depositId=dep_none');
    expect(byCheck.data).toEqual([]);

    const open = await lines(`/unreconciled?bankAccountId=${bankId}`);
    expect(open.status).toBe(200);
    expect(open.data.length).toBeGreaterThan(0);
    const one = await lines(`/${open.data[0].id}`);
    expect(one.data.id).toBe(open.data[0].id);
    expect((await lines('/bt_missing')).status).toBe(404);
    expect((await lines('', 'GET', undefined, ['invoices:read'])).status).toBe(403);
  });
});

describe('matching', () => {
  it('suggests the invoice a line pays and records the payment', async () => {
    const line = await lineByDescription('ACME CORP - Payment INV-2001');
    const suggestions = await lines(`/${line.id}/suggestions`);
    expect(suggestions.status).toBe(200);
    expect(suggestions.data[0]).toMatchObject({ type: 'invoice', id: 'inv_bl_1', number: 'INV-2001' });

    const wrongKind = await lines(`/${line.id}/reconcile`, 'POST', { type: 'bill', entityId: 'bill_bl_1' });
    expect(wrongKind.status).toBe(400);
    expect((await lines(`/${line.id}/reconcile`, 'POST', { type: 'invoice' })).status).toBe(400);
    expect((await lines(`/${line.id}/reconcile`, 'POST', { type: 'invoice', entityId: 'inv_missing' })).status).toBe(400);

    const matched = await lines(`/${line.id}/reconcile`, 'POST', { type: 'invoice', entityId: 'inv_bl_1' });
    expect(matched.status).toBe(200);
    expect(matched.data).toMatchObject({ status: 'reconciled', paymentId: expect.stringMatching(/^pay/) });
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, 'inv_bl_1')).limit(1);
    expect(invoice?.balanceDue).toBe('0.00');

    const twice = await lines(`/${line.id}/reconcile`, 'POST', { type: 'invoice', entityId: 'inv_bl_1' });
    expect(twice.status).toBe(400);

    const undone = await lines(`/${line.id}/unreconcile`, 'POST');
    expect(undone.data).toEqual({ id: line.id, status: 'unreconciled' });
    const [reopened] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, 'inv_bl_1')).limit(1);
    expect(reopened?.balanceDue).toBe('121.00');
    expect((await lines(`/${line.id}/unreconcile`, 'POST')).status).toBe(400);
  });

  it('pays a bill from money going out', async () => {
    const line = await lineByDescription('Energie Leverancier - ENR-77');
    const suggestions = await lines(`/${line.id}/suggestions`);
    expect(suggestions.data[0]).toMatchObject({ type: 'bill', id: 'bill_bl_1' });
    const matched = await lines(`/${line.id}/reconcile`, 'POST', { type: 'bill', entityId: 'bill_bl_1' });
    expect(matched.status).toBe(200);
  });

  it('posts a line straight to an account, with tax, and reverses it on undo', async () => {
    const line = await lineByDescription('Bank fee');
    const [expense] = await db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.entityId, entityId), eq(schema.accounts.type, 'expense')))
      .limit(1);
    const [rate] = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId)).limit(1);
    expect((await lines(`/${line.id}/reconcile`, 'POST', { type: 'manual' })).status).toBe(400);
    expect((await lines(`/${line.id}/reconcile`, 'POST', { type: 'manual', categoryAccountId: bankLedgerId })).status).toBe(400);
    expect((await lines(`/${line.id}/reconcile`, 'POST', { type: 'manual', categoryAccountId: 'acc_missing' })).status).toBe(400);
    const posted = await lines(`/${line.id}/reconcile`, 'POST', { type: 'manual', categoryAccountId: expense!.id, taxRateId: rate?.id, contactId: 'pty_bl_energy' });
    expect(posted.status).toBe(200);
    expect(posted.data.journalEntryId).toMatch(/^je_/);
    const undone = await lines(`/${line.id}/unreconcile`, 'POST');
    expect(undone.status).toBe(200);
    const [entry] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, posted.data.journalEntryId)).limit(1);
    expect(entry?.status).toBe('reversed');
  });

  it('ties a line to a payment recorded earlier, and unlinks it', async () => {
    await recordPayment(db, {
      entityId,
      type: 'received',
      amount: 75.25,
      currency: 'EUR',
      date: new Date('2026-01-12T00:00:00Z'),
      paymentMethod: 'check',
      checkNumber: '1042',
      contactId: 'pty_bl_client',
      bankAccountId: bankId,
      depositTo: 'bank',
      allocations: [],
      userId: null,
    });
    const line = await lineByDescription('Client Holding - Deposit');
    const suggestions = await lines(`/${line.id}/suggestions`);
    const payment = suggestions.data.find((s: { type: string }) => s.type === 'payment');
    expect(payment).toMatchObject({ number: '1042' });
    expect((await lines(`/${line.id}/match-payment`, 'POST', { paymentId: 'pay_missing' })).status).toBe(400);
    expect((await lines(`/${line.id}/match-payment`, 'POST', {})).status).toBe(400);
    const linked = await lines(`/${line.id}/match-payment`, 'POST', { paymentId: payment.id });
    expect(linked.status).toBe(200);
    expect(linked.data).toMatchObject({ status: 'reconciled', paymentId: payment.id });
    const unlinked = await lines(`/${line.id}/unreconcile`, 'POST');
    expect(unlinked.status).toBe(200);
    expect((await lines('/bt_missing/match-payment', 'POST', { paymentId: payment.id })).status).toBe(404);
  });

  it('ties a line to a bank deposit, and unlinks it', async () => {
    const now = new Date();
    await db.insert(schema.bankDeposits).values({ id: 'dep_bl_1', entityId, bankAccountId: bankId, date: '2026-01-13', amount: '75.25', currency: 'EUR', status: 'posted', createdAt: now, updatedAt: now });
    const line = await lineByDescription('Client Holding - Deposit');
    const suggestions = await lines(`/${line.id}/suggestions`);
    expect(suggestions.data.some((s: { type: string }) => s.type === 'deposit')).toBe(true);
    expect((await lines(`/${line.id}/match-deposit`, 'POST', { depositId: 'dep_missing' })).status).toBe(400);
    const linked = await lines(`/${line.id}/match-deposit`, 'POST', { depositId: 'dep_bl_1' });
    expect(linked.status).toBe(200);
    expect(linked.data).toMatchObject({ status: 'reconciled', depositId: 'dep_bl_1' });
    expect((await lines(`/${line.id}/match-deposit`, 'POST', { depositId: 'dep_bl_1' })).status).toBe(400);
    const unlinked = await lines(`/${line.id}/unreconcile`, 'POST');
    expect(unlinked.status).toBe(200);
    expect((await lines('/bt_missing/match-deposit', 'POST', { depositId: 'dep_bl_1' })).status).toBe(404);
  });

  it('matches automatically, excludes, and guards the routes', async () => {
    const auto = await lines('/auto-reconcile', 'POST', { bankAccountId: bankId });
    expect(auto.status).toBe(200);
    expect(auto.data.reconciledCount).toBeGreaterThan(0);
    expect(auto.data.results.length).toBeGreaterThan(0);
    expect((await lines('/auto-reconcile', 'POST', { bankAccountId: 'ba_missing' })).status).toBe(404);
    expect((await lines('/auto-reconcile', 'POST', {})).status).toBe(400);

    const open = await lines(`/unreconciled?bankAccountId=${cardId}`);
    const excluded = await lines(`/${open.data[0].id}/exclude`, 'POST');
    expect(excluded.data).toEqual({ message: 'Transaction excluded' });
    const reincluded = await lines(`/${open.data[0].id}/unreconcile`, 'POST');
    expect(reincluded.status).toBe(200);
    expect((await lines('/bt_missing/exclude', 'POST')).status).toBe(404);
    expect((await lines('/bt_missing/unreconcile', 'POST')).status).toBe(404);
    expect((await lines('/bt_missing/reconcile', 'POST', { type: 'manual' })).status).toBe(404);
    expect((await lines('/bt_missing/suggestions')).status).toBe(404);
    expect((await lines(`/${open.data[0].id}/reconcile`, 'POST', { type: 'other' })).status).toBe(400);
    expect((await lines(`/${open.data[0].id}/exclude`, 'POST', undefined, ['banking:read'])).status).toBe(403);
  });
});
