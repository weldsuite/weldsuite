/**
 * Every accounting report route on books built straight in the database
 * (documents, payments, allocations and their journal entries) next to manual
 * entries posted through the journal: accrual and cash basis, comparatives,
 * month and quarter columns, dimension filters, aging, the tax summary, the
 * general ledger, cash flow, the tax return worksheet, CSV and print exports,
 * and the refusals. It mounts only the ledger and the reports, so it runs in
 * the `books: reports` conformance suite; us-reports runs the same reports on
 * documents created through the sales, purchases and sales-tax routes.
 *
 * The Dutch entity's March 2026:
 *
 *   Invoice A  Mar  3  revenue 8000 1,000 (class A, location 1) + VAT 210  paid in full Mar 15
 *   Invoice B  Mar 10  revenue 8010   500 (class B)              + VAT 105  half paid Mar 25 (302.50)
 *   Credit note Mar 12 8000 50 on the customer of A
 *   Bill 1     Mar  5  purchases 4000 300 (location 1) + input VAT 63          paid Mar 20
 *   Payments   Mar 28  100.00 received, Mar 27 40.00 sent, applied to nothing; Mar 29 50.00 to B, voided
 *   Manual     Feb 15 revenue 500; Mar 12 other income 10; Mar 14 loan 5,000; Mar 16 fixed asset 1,000;
 *              Mar 18 equity 1,000; Mar 21 bank to savings 200; Mar 31 bank costs 25
 *
 *   Accrual  revenue 950 + 500 + 10 = 1,460   expenses 300 + 25 = 325   net 1,135
 *   Cash     revenue 1,000 + 250 + 10 + 100 (unapplied) = 1,360
 *            expenses 300 + 25 + 40 (unapplied) = 365                    net 995
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingReportsRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { journalEntriesRoutes } from '../journal-entries';

let db: Database;

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { code: string; message: string };
  text: string;
  headers: Headers;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; entityId?: string; perms?: string[] } = {}): Promise<Result> {
  const { request } = createTestApp(mount, routes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.entityId ? { 'X-Accounting-Entity-Id': opts.entityId } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  let json: { data?: unknown; error?: { code: string; message: string } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // CSV
  }
  return { status: res.status, data: json.data, error: json.error, text, headers: res.headers };
}

const report = (entityId: string, path: string, perms?: string[]) =>
  call('/api/accounting-reports', accountingReportsRoutes, `/api/accounting-reports${path}`, { entityId, perms });

async function accountsByCode(entityId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  return Object.fromEntries(rows.map((a) => [a.code, a.id]));
}

async function manualEntry(entityId: string, acct: Record<string, string>, date: string, debit: string, credit: string, amount: string) {
  const created = await call('/api/journal-entries', journalEntriesRoutes, '/api/journal-entries', {
    method: 'POST',
    entityId,
    body: { date, description: 'Manual entry', lines: [{ accountId: acct[debit], debit: amount }, { accountId: acct[credit], credit: amount }] },
  });
  expect(created.status).toBe(201);
  const posted = await call('/api/journal-entries', journalEntriesRoutes, `/api/journal-entries/${created.data.id}/post`, { method: 'POST', entityId });
  expect(posted.status).toBe(200);
}

interface Line {
  account: string;
  debit?: string;
  credit?: string;
  contactId?: string;
  classId?: string;
  locationId?: string;
  taxRateId?: string;
  taxAmount?: string;
}

let entrySeq = 0;
/** A posted entry written straight to the journal, as a document or payment posts it. */
async function book(
  entityId: string,
  acct: Record<string, string>,
  date: string,
  source: { type: string; id: string; status?: string; reversalOfId?: string },
  lines: Line[],
): Promise<string> {
  entrySeq += 1;
  const id = `je_rep_${entrySeq}`;
  const total = lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0).toFixed(2);
  await db.insert(schema.journalEntries).values({
    id,
    entityId,
    entryNumber: `JE-R${String(entrySeq).padStart(3, '0')}`,
    date: new Date(`${date}T00:00:00.000Z`),
    description: `${source.type} ${source.id}`,
    status: source.status ?? 'posted',
    sourceType: source.type,
    sourceId: source.id,
    reversalOfId: source.reversalOfId ?? null,
    totalDebit: total,
    totalCredit: total,
  });
  await db.insert(schema.journalLines).values(
    lines.map((l, i) => ({
      id: `${id}_${i}`,
      entityId,
      journalEntryId: id,
      accountId: acct[l.account],
      description: `${source.id} line ${i + 1}`,
      debit: l.debit ?? '0',
      credit: l.credit ?? '0',
      contactId: l.contactId ?? null,
      classId: l.classId ?? null,
      locationId: l.locationId ?? null,
      taxRateId: l.taxRateId ?? null,
      taxAmount: l.taxAmount ?? null,
      sortOrder: i,
    })),
  );
  return id;
}

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

let nl: { id: string; acct: Record<string, string> };
let llc: { id: string; acct: Record<string, string> };
let sCorp: { id: string; acct: Record<string, string> };

async function buildDutchBooks() {
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: {
      name: 'Rapport BV',
      jurisdictionCode: 'NL',
      timezone: 'UTC',
      vatNumber: 'NL123456789B01',
      taxIdentifiers: { registrationNumber: '12345678' },
      address: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 LG', country: 'NL' },
    },
  });
  expect(created.status).toBe(201);
  const id = created.data.id as string;
  const acct = await accountsByCode(id);
  nl = { id, acct };
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, id));
  const vatId = rates.find((r) => Number(r.rate) === 21)?.id;
  expect(vatId).toBeDefined();

  await manualEntry(id, acct, '2026-02-15', '1100', '8000', '500.00');
  await manualEntry(id, acct, '2025-03-10', '1100', '8000', '300.00');
  await manualEntry(id, acct, '2026-03-12', '1100', '8100', '10.00');
  await manualEntry(id, acct, '2026-03-14', '1100', '2000', '5000.00');
  await manualEntry(id, acct, '2026-03-16', '0200', '1100', '1000.00');
  await manualEntry(id, acct, '2026-03-18', '1100', '0510', '1000.00');
  await manualEntry(id, acct, '2026-03-21', '1200', '1100', '200.00');
  await manualEntry(id, acct, '2026-03-31', '4650', '1100', '25.00');

  const invoice = (rowId: string, fields: Partial<typeof schema.invoices.$inferInsert>) => ({
    id: rowId,
    entityId: id,
    contactId: 'pty_rep_c',
    contactName: 'Northwind Traders',
    currency: 'EUR',
    exchangeRate: '1',
    issueDate: day('2026-03-03'),
    dueDate: day('2026-04-02'),
    total: '0',
    balanceDue: '0',
    ...fields,
  });
  await db.insert(schema.invoices).values([
    invoice('inv_rep_a', { invoiceNumber: 'INV-A', status: 'paid', total: '1210.00', balanceDue: '0.00' }),
    invoice('inv_rep_b', {
      invoiceNumber: 'INV-B',
      contactId: 'pty_rep_x',
      contactName: 'Zeta Retail',
      status: 'sent',
      issueDate: day('2026-03-10'),
      dueDate: day('2026-04-09'),
      total: '605.00',
      balanceDue: '302.50',
    }),
    invoice('inv_rep_c', { invoiceNumber: 'INV-C', status: 'sent', issueDate: day('2026-04-01'), dueDate: day('2026-05-01'), total: '121.00', balanceDue: '21.00' }),
    invoice('inv_rep_d', { invoiceNumber: 'DRAFT', status: 'draft', total: '999.00', balanceDue: '999.00' }),
    invoice('cn_rep_1', { invoiceNumber: 'CN-1', type: 'credit_note', status: 'finalized', issueDate: day('2026-03-12'), dueDate: day('2026-03-12'), total: '50.00', balanceDue: '50.00' }),
    invoice('inv_rep_e', {
      invoiceNumber: 'INV-E',
      contactId: 'pty_rep_z',
      contactName: null,
      status: 'sent',
      currency: 'USD',
      exchangeRate: '1.100000',
      issueDate: day('2026-01-01'),
      dueDate: day('2026-01-15'),
      total: '110.00',
      balanceDue: '110.00',
    }),
  ]);
  const bill = (rowId: string, fields: Partial<typeof schema.bills.$inferInsert>) => ({
    id: rowId,
    entityId: id,
    contactId: 'pty_rep_s',
    currency: 'EUR',
    exchangeRate: '1',
    issueDate: day('2026-03-05'),
    dueDate: day('2026-03-01'),
    total: '0',
    balanceDue: '0',
    ...fields,
  });
  await db.insert(schema.bills).values([
    bill('bill_rep_1', { billNumber: 'B-1', status: 'paid', total: '363.00', balanceDue: '0.00' }),
    bill('bill_rep_2', { billNumber: 'B-2', status: 'approved', total: '121.00', balanceDue: '121.00' }),
    bill('bill_rep_3', { billNumber: 'BC-1', type: 'credit_note', status: 'approved', dueDate: day('2026-05-15'), total: '20.00', balanceDue: '20.00' }),
  ]);

  await book(id, acct, '2026-03-03', { type: 'invoice', id: 'inv_rep_a' }, [
    { account: '1300', debit: '1210.00', contactId: 'pty_rep_c' },
    { account: '8000', credit: '1000.00', contactId: 'pty_rep_c', classId: 'cls_rep_a', locationId: 'loc_rep_1' },
    { account: '1710', credit: '210.00', contactId: 'pty_rep_c', taxRateId: vatId, taxAmount: '210.00' },
  ]);
  await book(id, acct, '2026-03-10', { type: 'invoice', id: 'inv_rep_b' }, [
    { account: '1300', debit: '605.00', contactId: 'pty_rep_x' },
    { account: '8010', credit: '500.00', contactId: 'pty_rep_x', classId: 'cls_rep_b' },
    { account: '1710', credit: '105.00', contactId: 'pty_rep_x', taxRateId: vatId, taxAmount: '105.00' },
  ]);
  await book(id, acct, '2026-04-01', { type: 'invoice', id: 'inv_rep_c' }, [
    { account: '1300', debit: '121.00', contactId: 'pty_rep_c' },
    { account: '8020', credit: '100.00', contactId: 'pty_rep_c' },
    { account: '1710', credit: '21.00', contactId: 'pty_rep_c', taxRateId: vatId, taxAmount: '21.00' },
  ]);
  await book(id, acct, '2026-03-12', { type: 'credit_note', id: 'cn_rep_1' }, [
    { account: '8000', debit: '50.00', contactId: 'pty_rep_c' },
    { account: '1300', credit: '50.00', contactId: 'pty_rep_c' },
  ]);
  await book(id, acct, '2026-03-05', { type: 'bill', id: 'bill_rep_1' }, [
    { account: '4000', debit: '300.00', contactId: 'pty_rep_s', locationId: 'loc_rep_1' },
    { account: '1730', debit: '63.00', contactId: 'pty_rep_s', taxRateId: vatId, taxAmount: '63.00' },
    { account: '1600', credit: '363.00', contactId: 'pty_rep_s' },
  ]);

  const payment = (rowId: string, fields: Partial<typeof schema.payments.$inferInsert>) => ({
    id: rowId,
    entityId: id,
    type: 'received',
    currency: 'EUR',
    exchangeRate: '1',
    contactId: 'pty_rep_c',
    amount: '0',
    date: day('2026-03-15'),
    ...fields,
  });
  await db.insert(schema.payments).values([
    payment('pay_rep_1', { amount: '1210.00', reference: 'REF-1' }),
    payment('pay_rep_2', { amount: '302.50', date: day('2026-03-25'), contactId: 'pty_rep_x' }),
    payment('pay_rep_3', { amount: '100.00', date: day('2026-03-28'), contactId: 'pty_rep_x', reference: 'PREPAY' }),
    payment('pay_rep_4', { type: 'sent', amount: '363.00', date: day('2026-03-20'), contactId: 'pty_rep_s' }),
    payment('pay_rep_5', { amount: '50.00', date: day('2026-03-29'), contactId: 'pty_rep_x', deletedAt: day('2026-03-30') }),
    payment('pay_rep_6', { amount: '100.00', date: day('2026-04-02'), invoiceId: 'inv_rep_c' }),
    payment('pay_rep_7', { amount: '220.00', currency: 'USD', exchangeRate: '1.100000', date: day('2026-04-05'), contactId: 'pty_rep_z' }),
    payment('pay_rep_8', { type: 'sent', amount: '40.00', date: day('2026-03-27'), contactId: 'pty_rep_s' }),
  ]);
  await db.insert(schema.paymentAllocations).values([
    { id: 'pal_rep_1', entityId: id, paymentId: 'pay_rep_1', invoiceId: 'inv_rep_a', amount: '1210.00' },
    { id: 'pal_rep_2', entityId: id, paymentId: 'pay_rep_2', invoiceId: 'inv_rep_b', amount: '302.50' },
    { id: 'pal_rep_4', entityId: id, paymentId: 'pay_rep_4', billId: 'bill_rep_1', amount: '363.00' },
    { id: 'pal_rep_5', entityId: id, paymentId: 'pay_rep_5', invoiceId: 'inv_rep_b', amount: '50.00' },
  ]);
  await book(id, acct, '2026-03-15', { type: 'payment', id: 'pay_rep_1' }, [
    { account: '1100', debit: '1210.00', contactId: 'pty_rep_c' },
    { account: '1300', credit: '1210.00', contactId: 'pty_rep_c' },
  ]);
  await book(id, acct, '2026-03-25', { type: 'payment', id: 'pay_rep_2' }, [
    { account: '1100', debit: '302.50', contactId: 'pty_rep_x' },
    { account: '1300', credit: '302.50', contactId: 'pty_rep_x' },
  ]);
  await book(id, acct, '2026-03-28', { type: 'payment', id: 'pay_rep_3' }, [
    { account: '1100', debit: '100.00', contactId: 'pty_rep_x' },
    { account: '1300', credit: '100.00', contactId: 'pty_rep_x' },
  ]);
  await book(id, acct, '2026-03-20', { type: 'payment', id: 'pay_rep_4' }, [
    { account: '1600', debit: '363.00', contactId: 'pty_rep_s' },
    { account: '1100', credit: '363.00', contactId: 'pty_rep_s' },
  ]);
  const voided = await book(id, acct, '2026-03-29', { type: 'payment', id: 'pay_rep_5', status: 'reversed' }, [
    { account: '1100', debit: '50.00', contactId: 'pty_rep_x' },
    { account: '1300', credit: '50.00', contactId: 'pty_rep_x' },
  ]);
  await book(id, acct, '2026-03-30', { type: 'payment', id: 'pay_rep_5', reversalOfId: voided }, [
    { account: '1300', debit: '50.00', contactId: 'pty_rep_x' },
    { account: '1100', credit: '50.00', contactId: 'pty_rep_x' },
  ]);
  await book(id, acct, '2026-04-02', { type: 'payment', id: 'pay_rep_6' }, [
    { account: '1100', debit: '100.00', contactId: 'pty_rep_c' },
    { account: '1300', credit: '100.00', contactId: 'pty_rep_c' },
  ]);
  await book(id, acct, '2026-04-05', { type: 'payment', id: 'pay_rep_7' }, [
    { account: '1100', debit: '200.00', contactId: 'pty_rep_z' },
    { account: '1300', credit: '200.00', contactId: 'pty_rep_z' },
  ]);
  await book(id, acct, '2026-03-27', { type: 'payment', id: 'pay_rep_8' }, [
    { account: '1600', debit: '40.00', contactId: 'pty_rep_s' },
    { account: '1100', credit: '40.00', contactId: 'pty_rep_s' },
  ]);
}

const usAddress = { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' };

async function buildUsBooks(body: Record<string, unknown>) {
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: { jurisdictionCode: 'US', address: usAddress, ...body },
  });
  expect(created.status).toBe(201);
  const id = created.data.id as string;
  // Accounts a preparer still has to map: none, another form's line, a line that doesn't exist.
  await db.insert(schema.accounts).values([
    { id: `acc_um_${id.slice(-10)}`, entityId: id, code: '6990', name: 'Unmapped costs', type: 'expense', subtype: 'operating_expense', normalSide: 'debit', taxLine: null },
    { id: `acc_of_${id.slice(-10)}`, entityId: id, code: '6991', name: 'Other form costs', type: 'expense', subtype: 'operating_expense', normalSide: 'debit', taxLine: 'f1120.26' },
    { id: `acc_uk_${id.slice(-10)}`, entityId: id, code: '6992', name: 'Unknown line costs', type: 'expense', subtype: 'operating_expense', normalSide: 'debit', taxLine: 'sch_c.zz' },
  ]);
  const acct = await accountsByCode(id);
  await manualEntry(id, acct, '2026-07-05', '1000', '4020', '1000.00');
  await manualEntry(id, acct, '2026-07-22', '6195', '1000', '120.00');
  await manualEntry(id, acct, '2026-07-23', '6185', '1000', '80.00');
  await manualEntry(id, acct, '2026-07-24', '4050', '1000', '50.00');
  await manualEntry(id, acct, '2026-07-25', '6990', '1000', '30.00');
  await manualEntry(id, acct, '2026-07-26', '6991', '1000', '20.00');
  await manualEntry(id, acct, '2026-07-27', '6992', '1000', '10.00');
  await manualEntry(id, acct, '2025-07-10', '6195', '1000', '90.00');
  await manualEntry(id, acct, '2025-06-10', '1000', '3000', '2500.00');
  await manualEntry(id, acct, '2026-07-28', '1530', '1000', '600.00');
  await manualEntry(id, acct, '2026-07-29', '6040', '1590', '60.00');
  return { id, acct };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.parties).values([
    { id: 'pty_rep_c', displayName: 'Northwind Traders', role: 'customer' },
    { id: 'pty_rep_x', displayName: 'Zeta Retail', role: 'customer' },
    { id: 'pty_rep_z', displayName: 'Overseas Buyer Inc', role: 'customer' },
    { id: 'pty_rep_s', displayName: 'Contoso Supplies', role: 'supplier' },
  ]);
  await buildDutchBooks();
  llc = await buildUsBooks({ name: 'Acme Studio LLC', entityType: 'single_member_llc', accountingMethod: 'cash', taxIdentifiers: { einOrSsn: '12-3456789' } });
  sCorp = await buildUsBooks({ name: 'Beta Software Inc', entityType: 's_corp', fiscalYearStart: 7 });
}, 180_000);

const march = 'from=2026-03-01&to=2026-03-31';

describe('profit and loss', () => {
  it('accrual recognises documents when they are booked, credit notes included', async () => {
    const res = await report(nl.id, `/profit-loss?${march}&basis=accrual`);
    expect(res.status).toBe(200);
    expect(res.data.basis).toBe('accrual');
    expect(res.data.totalRevenue).toBe('1460.00');
    expect(res.data.totalExpenses).toBe('325.00');
    expect(res.data.netProfit).toBe('1135.00');
    expect(res.data.totals.costOfGoodsSold.values.current).toBe('300.00');
  });

  it('cash recognises payments, spreads a partial one and books what no document claims as unapplied', async () => {
    const res = await report(nl.id, `/profit-loss?${march}&basis=cash`);
    expect(res.status).toBe(200);
    expect(res.data.totalRevenue).toBe('1360.00');
    expect(res.data.totalExpenses).toBe('365.00');
    expect(res.data.netProfit).toBe('995.00');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unapplied = res.data.revenue.find((r: any) => r.accountId === 'virtual:unapplied_cash_payment_income');
    expect(unapplied).toMatchObject({ balance: '100.00', section: 'other_income' });
  });

  it('defaults to the workspace setting, then accrual', async () => {
    const res = await report(nl.id, `/profit-loss?${march}`);
    expect(res.status).toBe(200);
    expect(res.data.basis).toBe('accrual');
  });

  it('compares with the prior period and the prior year', async () => {
    const period = await report(nl.id, `/profit-loss?${march}&compare=prior_period`);
    expect(period.status).toBe(200);
    expect(period.data.columns.map((c: { key: string }) => c.key)).toEqual(['current', 'prior']);
    expect(period.data.totals.totalRevenue.values.prior).toBe('500.00');
    expect(period.data.totals.totalRevenue.delta.amount).toBe('960.00');
    const year = await report(nl.id, `/profit-loss?${march}&compare=prior_year&basis=cash`);
    expect(year.status).toBe(200);
    expect(year.data.totals.totalRevenue.values.prior).toBe('300.00');
  });

  it('splits into months and quarters with a total', async () => {
    const months = await report(nl.id, '/profit-loss?from=2026-01-15&to=2026-04-30&periods=months&basis=cash');
    expect(months.status).toBe(200);
    expect(months.data.columns.map((c: { key: string }) => c.key)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04', 'total']);
    const quarters = await report(nl.id, '/profit-loss?from=2025-01-01&to=2026-06-30&periods=quarters');
    expect(quarters.status).toBe(200);
    expect(quarters.data.columns).toHaveLength(7);
  });

  it('filters by class and location on both bases', async () => {
    const accrual = await report(nl.id, `/profit-loss?${march}&classId=cls_rep_a`);
    expect(accrual.data.totalRevenue).toBe('1000.00');
    const cash = await report(nl.id, `/profit-loss?${march}&classId=cls_rep_b&basis=cash`);
    expect(cash.data.totalRevenue).toBe('250.00');
    const location = await report(nl.id, `/profit-loss?${march}&locationId=loc_rep_1&basis=cash`);
    expect(location.status).toBe(200);
    expect(location.data.totalExpenses).toBe('300.00');
  });

  it('refuses bad parameters', async () => {
    for (const query of [
      `${march}&compare=prior_period&periods=months`,
      `${march}&basis=modified`,
      `${march}&format=xml`,
      `${march}&format=`,
      'from=2026-04-01&to=2026-03-01',
      'from=2026-13-01',
      `${march}&periods=weeks`,
      `${march}&compare=last_year`,
      'from=2015-01-01&to=2026-12-31&periods=months',
    ]) {
      const res = await report(nl.id, `/profit-loss?${query}`);
      expect(res.status, query).toBe(400);
    }
  });

  it('needs an entity and the reports permission', async () => {
    expect((await report('ent_missing', `/profit-loss?${march}`)).status).toBe(400);
    expect((await report(nl.id, `/profit-loss?${march}`, ['journal:read'])).status).toBe(403);
    const deleted = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      body: { name: 'Gone BV', jurisdictionCode: 'NL', timezone: 'UTC' },
    });
    await db.update(schema.entities).set({ deletedAt: new Date() }).where(eq(schema.entities.id, deleted.data.id));
    expect((await report(deleted.data.id, `/profit-loss?${march}`)).status).toBe(400);
  });
});

describe('balance sheet', () => {
  it('balances on accrual, with the calculated equity rows', async () => {
    const res = await report(nl.id, '/balance-sheet?asOf=2026-03-31');
    expect(res.status).toBe(200);
    expect(res.data.isBalanced).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calculated = res.data.equity.filter((r: any) => r.virtual);
    expect(calculated).toHaveLength(2);
  });

  it('cash basis leaves receivables and payables out', async () => {
    const res = await report(nl.id, '/balance-sheet?asOf=2026-03-31&basis=cash');
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(res.data.assets.find((r: any) => r.accountCode === '1300')).toBeUndefined();
  });

  it('compares with a year and a period earlier', async () => {
    for (const query of [
      'asOf=2026-03-31&compare=prior_year',
      'asOf=2026-03-31&compare=prior_period',
      'asOf=2026-03-15&compare=prior_period',
      'asOf=2026-03-31&compare=prior_period&from=2026-03-01',
      'asOf=2026-03-31T12:00:00.000Z',
      '',
    ]) {
      const res = await report(nl.id, `/balance-sheet?${query}`);
      expect(res.status, query).toBe(200);
    }
  });

  it('refuses a bad date', async () => {
    expect((await report(nl.id, '/balance-sheet?asOf=yesterday')).status).toBe(400);
    expect((await report(nl.id, '/balance-sheet?asOf=2026-03-31&from=soon')).status).toBe(400);
  });
});

describe('trial balance', () => {
  it('balances on both bases and compares two periods', async () => {
    for (const query of [march, `${march}&basis=cash`, `${march}&compare=prior_period`, `${march}&compare=prior_year&basis=cash`]) {
      const res = await report(nl.id, `/trial-balance?${query}`);
      expect(res.status, query).toBe(200);
      expect(res.data.isBalanced, query).toBe(true);
    }
  });
});

describe('aging', () => {
  it('ages open invoices in base currency; credit notes reduce them; drafts stay out', async () => {
    const res = await report(nl.id, '/aged-receivables?asOf=2026-04-30');
    expect(res.status).toBe(200);
    // B 302.50 + C 21 + E 110 USD at 1.1 (100) - CN 50
    expect(res.data.total).toBe('373.50');
    expect(res.data.buckets['90+']).toEqual({ total: '100.00', count: 1 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(res.data.contacts.map((c: any) => c.contactName)).toEqual(['Northwind Traders', 'Overseas Buyer Inc', 'Zeta Retail']);
  });

  it('ages open bills with plain bucket totals and their counts', async () => {
    const res = await report(nl.id, '/aged-payables?asOf=2026-04-30');
    expect(res.status).toBe(200);
    expect(res.data.total).toBe('101.00');
    expect(res.data.buckets['31-60']).toBe('121.00');
    expect(res.data.bucketCounts.current).toBe(1);
  });

  it('ages as of today without a date, and refuses a bad one', async () => {
    expect((await report(nl.id, '/aged-receivables')).status).toBe(200);
    expect((await report(nl.id, '/aged-payables')).status).toBe(200);
    expect((await report(nl.id, '/aged-payables?asOf=2026-02-30')).status).toBe(400);
  });
});

describe('tax summary', () => {
  it('adds up the tax per rate of the period', async () => {
    const res = await report(nl.id, `/vat-summary?${march}`);
    expect(res.status).toBe(200);
    expect(res.data.breakdown).toHaveLength(1);
    expect(Number(res.data.breakdown[0].totalTax)).toBe(378);
    expect((await report(nl.id, '/vat-summary?from=2026-04-01&to=2026-03-01')).status).toBe(400);
  });
});

describe('general ledger', () => {
  it('lists an account with its opening and running balance, page by page', async () => {
    const all = await report(nl.id, `/general-ledger?accountId=${nl.acct['1100']}&${march}`);
    expect(all.status).toBe(200);
    expect(all.data.openingBalance).toBe('800.00');
    const page = await report(nl.id, `/general-ledger?accountId=${nl.acct['1100']}&${march}&page=2&pageSize=3`);
    expect(page.status).toBe(200);
    expect(page.data.lines).toHaveLength(3);
    expect(page.data.pagination).toMatchObject({ page: 2, pageSize: 3, hasMore: true });
    for (const query of ['page=0&pageSize=0', 'page=x&pageSize=9999', 'page=&pageSize=']) {
      expect((await report(nl.id, `/general-ledger?accountId=${nl.acct['1100']}&${march}&${query}`)).status).toBe(200);
    }
  });

  it('on cash basis lists the payments that recognised a line, and the virtual unapplied accounts', async () => {
    const tax = await report(nl.id, `/general-ledger?accountId=${nl.acct['1710']}&from=2026-03-01&to=2026-04-30&basis=cash`);
    expect(tax.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(tax.data.lines.every((l: any) => l.paymentId)).toBe(true);
    const unapplied = await report(nl.id, '/general-ledger?accountId=virtual:unapplied_cash_payment_income&from=2026-03-01&to=2026-04-30&basis=cash');
    expect(unapplied.status).toBe(200);
    expect(unapplied.data.totalCredit).toBe('300.00');
  });

  it('needs an account of the entity', async () => {
    expect((await report(nl.id, `/general-ledger?${march}`)).status).toBe(400);
    expect((await report(nl.id, `/general-ledger?accountId=acc_nope&${march}`)).status).toBe(404);
    expect((await report(nl.id, `/general-ledger?accountId=${llc.acct['1000']}&${march}`)).status).toBe(404);
  });
});

describe('cash flow', () => {
  it('groups the movements of the cash accounts by what the other side was for', async () => {
    const res = await report(nl.id, `/cash-flow?${march}`);
    expect(res.status).toBe(200);
    expect(res.data.openingBalance).toBe('800.00');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activity = (key: string) => res.data.activities.find((a: any) => a.activity === key);
    expect(activity('investing').outflows).toBe('1000.00');
    expect(activity('financing').inflows).toBe('6000.00');
    expect(res.data.monthly.map((m: { month: string }) => m.month)).toEqual(['2026-03']);
  });

  it('compares with the prior period and year', async () => {
    const period = await report(nl.id, `/cash-flow?${march}&compare=prior_period`);
    expect(period.status).toBe(200);
    expect(period.data.comparison.mode).toBe('prior_period');
    const year = await report(nl.id, `/cash-flow?${march}&compare=prior_year`);
    expect(year.status).toBe(200);
    expect((await report(nl.id, `/cash-flow?${march}&compare=never`)).status).toBe(400);
  });
});

describe('revenue by customer and expense by category', () => {
  it('follow the basis', async () => {
    const accrual = await report(nl.id, `/revenue-by-customer?${march}`);
    expect(accrual.status).toBe(200);
    expect(accrual.data.grandTotal).toBe('1450.00');
    const cash = await report(nl.id, `/revenue-by-customer?${march}&basis=cash`);
    expect(cash.status).toBe(200);
    expect(cash.data.customers[0]).toMatchObject({ contactId: 'pty_rep_c', contactName: 'Northwind Traders' });
    const expenses = await report(nl.id, `/expense-by-category?${march}&basis=cash`);
    expect(expenses.status).toBe(200);
    expect(expenses.data.grandTotal).toBe('365.00');
    expect((await report(nl.id, `/expense-by-category?${march}`)).data.grandTotal).toBe('325.00');
  });
});

describe('tax return worksheet', () => {
  it('groups a Schedule C entity\'s accounts by return line', async () => {
    const res = await report(llc.id, '/tax-worksheet?year=2026');
    expect(res.status).toBe(200);
    expect(res.data.form).toBe('sch_c');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(res.data.unmapped.map((u: any) => u.reason)).toEqual(['none', 'other_form', 'unknown_line']);
  });

  it('gives an S corporation a Schedule L with beginning balances and the result not closed', async () => {
    const res = await report(sCorp.id, '/tax-worksheet?year=2027&basis=accrual');
    expect(res.status).toBe(200);
    expect(res.data.form).toBe('f1120s');
    expect(res.data.period).toEqual({ from: '2026-07-01', to: '2027-06-30' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sections = res.data.sections.map((s: any) => s.key);
    expect(sections).toContain('balance_sheet');
  });

  it('takes explicit dates, the current year, and every account', async () => {
    for (const query of ['from=2026-01-01&to=2026-12-31', '', 'includeZero=true', 'year=2026&basis=cash']) {
      const res = await report(llc.id, `/tax-worksheet?${query}`);
      expect(res.status, query).toBe(200);
    }
    expect((await report(sCorp.id, '/tax-worksheet?includeZero=true')).status).toBe(200);
  });

  it('is for US entities, with a four-digit year', async () => {
    expect((await report(nl.id, '/tax-worksheet?year=2026')).status).toBe(400);
    expect((await report(llc.id, '/tax-worksheet?year=1999')).status).toBe(400);
    expect((await report(llc.id, '/tax-worksheet?year=soon')).status).toBe(400);
  });
});

describe('export', () => {
  it('every report downloads as csv', async () => {
    for (const path of [
      `/profit-loss?${march}`,
      `/profit-loss?${march}&compare=prior_year`,
      '/profit-loss?from=2026-01-01&to=2026-03-31&periods=months&basis=cash',
      '/balance-sheet?asOf=2026-03-31&compare=prior_period',
      `/trial-balance?${march}`,
      `/trial-balance?${march}&compare=prior_period`,
      '/aged-receivables?asOf=2026-04-30',
      '/aged-payables?asOf=2026-04-30',
      `/vat-summary?${march}`,
      `/general-ledger?accountId=${nl.acct['1100']}&${march}`,
      `/cash-flow?${march}`,
      `/revenue-by-customer?${march}`,
      `/expense-by-category?${march}`,
    ]) {
      const res = await report(nl.id, `${path}&format=csv`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain('text/csv');
      expect(res.text.split('\r\n').length, path).toBeGreaterThan(7);
    }
    const sheet = await report(llc.id, '/tax-worksheet?year=2026&format=csv');
    expect(sheet.status).toBe(200);
    expect(sheet.headers.get('content-disposition')).toBe('attachment; filename="tax-worksheet-sch_c-2026-01-01_2026-12-31.csv"');
  });

  it('print gives a document with the entity header and the paper size', async () => {
    const res = await report(nl.id, `/profit-loss?${march}&format=print`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ kind: 'report', paper: 'a4', basis: 'accrual', currency: 'EUR' });
    expect(res.data.entity.taxId).toBe('NL123456789B01');
    for (const path of ['/aged-receivables?asOf=2026-04-30', `/cash-flow?${march}`, `/vat-summary?${march}`]) {
      const printed = await report(nl.id, `${path}&format=print`);
      expect(printed.status, path).toBe(200);
      expect(printed.data.basis, path).toBeNull();
    }
    const us = await report(llc.id, '/tax-worksheet?year=2026&format=print');
    expect(us.status).toBe(200);
    expect(us.data).toMatchObject({ paper: 'letter' });
    expect(us.data.entity.taxId).toBe('12-3456789');
    expect((await report(sCorp.id, '/balance-sheet?asOf=2026-07-31&format=print')).status).toBe(200);
  });
});
