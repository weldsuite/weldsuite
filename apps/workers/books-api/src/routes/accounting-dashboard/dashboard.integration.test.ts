/**
 * The dashboard's figures come from the ledger and from posted documents in
 * the entity's base currency: revenue and expenses are the P&L (net of VAT,
 * manual entries included, drafts left out), receivables and payables are the
 * aged documents (credit notes reduce them, foreign amounts are converted, an
 * overdue figure leaves credit notes out).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingDashboardRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { accountingReportsRoutes } from '../accounting-reports';
import { journalEntriesRoutes } from '../journal-entries';

let db: Database;
let entityId: string;
const acct: Record<string, string> = {};

/* eslint-disable @typescript-eslint/no-explicit-any */
async function call(mount: string, routes: Hono<any>, path: string, method = 'GET', body?: unknown) {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(entityId ? { 'X-Accounting-Entity-Id': entityId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.status === 204 ? null : ((await res.json()) as { data?: any; error?: { message: string } });
  return { status: res.status, data: json?.data, error: json?.error };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function manualEntry(date: Date, debit: string, credit: string, amount: string) {
  const created = await call('/api/journal-entries', journalEntriesRoutes, '/api/journal-entries', 'POST', {
    date: date.toISOString().slice(0, 10),
    description: 'Manual entry',
    lines: [
      { accountId: acct[debit], debit: amount },
      { accountId: acct[credit], credit: amount },
    ],
  });
  expect(created.status).toBe(201);
  const posted = await call('/api/journal-entries', journalEntriesRoutes, `/api/journal-entries/${created.data.id}/post`, 'POST');
  expect(posted.status).toBe(200);
}

const now = new Date();
const day = 24 * 60 * 60 * 1000;
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12));
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));
const lastMonthInThisYear = lastMonth.getUTCFullYear() === now.getUTCFullYear();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name: 'Dashboard BV',
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id as string;
  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  for (const a of accounts) acct[a.code] = a.id;

  // Ledger: this month 1,000 revenue + 10 other income, 300 purchases, a 25 bank cost journal; last month 500 revenue.
  await manualEntry(monthStart, '1100', '8000', '1000.00');
  await manualEntry(monthStart, '1100', '8100', '10.00');
  await manualEntry(monthStart, '4000', '1100', '300.00');
  await manualEntry(monthStart, '4650', '1100', '25.00');
  await manualEntry(lastMonth, '1100', '8000', '500.00');

  await db.insert(schema.parties).values({ id: 'pty_dash', displayName: 'Klant BV', role: 'customer' });
  const invoice = (id: string, fields: Partial<typeof schema.invoices.$inferInsert>) => ({
    id,
    entityId,
    contactId: 'pty_dash',
    contactName: 'Klant BV',
    issueDate: monthStart,
    dueDate: new Date(now.getTime() - 5 * day),
    currency: 'EUR',
    exchangeRate: '1',
    total: '0',
    balanceDue: '0',
    ...fields,
  });
  await db.insert(schema.invoices).values([
    invoice('inv_open', { invoiceNumber: 'INV-1', status: 'finalized', total: '1210.00', balanceDue: '1210.00' }),
    invoice('inv_draft', { invoiceNumber: 'DRAFT', status: 'draft', total: '500.00', balanceDue: '500.00' }),
    invoice('inv_credit', { invoiceNumber: 'CN-1', type: 'credit_note', status: 'finalized', total: '100.00', balanceDue: '100.00' }),
    invoice('inv_usd', {
      invoiceNumber: 'INV-2',
      status: 'sent',
      currency: 'USD',
      exchangeRate: '2.000000',
      total: '200.00',
      balanceDue: '200.00',
      dueDate: new Date(now.getTime() + 10 * day),
    }),
    invoice('inv_paid', { invoiceNumber: 'INV-3', status: 'paid', total: '300.00', balanceDue: '0.00' }),
  ]);
  const bill = (id: string, fields: Partial<typeof schema.bills.$inferInsert>) => ({
    id,
    entityId,
    contactId: 'pty_dash',
    issueDate: monthStart,
    dueDate: new Date(now.getTime() - 5 * day),
    currency: 'EUR',
    exchangeRate: '1',
    total: '0',
    balanceDue: '0',
    ...fields,
  });
  await db.insert(schema.bills).values([
    bill('bill_open', { billNumber: 'B-1', status: 'approved', total: '600.00', balanceDue: '600.00' }),
    bill('bill_draft', { billNumber: 'B-2', status: 'draft', total: '999.00', balanceDue: '999.00' }),
    bill('bill_credit', { billNumber: 'BC-1', type: 'credit_note', status: 'approved', total: '50.00', balanceDue: '50.00' }),
  ]);
}, 60_000);

describe('GET /api/accounting-dashboard', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dashboard: any;

  beforeAll(async () => {
    const res = await call('/api/accounting-dashboard', accountingDashboardRoutes, '/api/accounting-dashboard');
    expect(res.status).toBe(200);
    dashboard = res.data;
  });

  it('revenue, expenses and profit are the ledger P&L: drafts out, manual journals in, other income counted', () => {
    expect(dashboard.currency).toBe('EUR');
    expect(dashboard.revenue.month).toBe('1010.00');
    expect(dashboard.expenses.month).toBe('325.00');
    expect(dashboard.profit.month).toBe('685.00');
    const yearRevenue = lastMonthInThisYear ? '1510.00' : '1010.00';
    expect(dashboard.revenue.year).toBe(yearRevenue);
    expect(dashboard.profit.year).toBe((Number(yearRevenue) - 325).toFixed(2));
  });

  it('counts the posted standard invoices of the month only', () => {
    // inv_open, inv_usd and inv_paid; the draft and the credit note are not counted.
    expect(dashboard.revenue.invoiceCount).toBe(3);
  });

  it('receivables are posted documents in base currency, credit notes reduce them and are never overdue', () => {
    // 1,210 + 200 USD at 2.0 (= 100) - 100 credit note; the draft and the paid invoice are out.
    expect(dashboard.receivables.outstanding).toBe('1210.00');
    expect(dashboard.receivables.outstandingCount).toBe(3);
    expect(dashboard.receivables.overdue).toBe('1210.00');
    expect(dashboard.receivables.overdueCount).toBe(1);
  });

  it('payables are posted bills less credit notes', () => {
    expect(dashboard.payables.outstanding).toBe('550.00');
    expect(dashboard.payables.outstandingCount).toBe(2);
    expect(dashboard.payables.overdue).toBe('600.00');
    expect(dashboard.payables.overdueCount).toBe(1);
  });

  it('upcoming due lists posted invoices in base currency, no credit notes', () => {
    expect(dashboard.upcomingDue).toHaveLength(1);
    expect(dashboard.upcomingDue[0]).toMatchObject({ id: 'inv_usd', balanceDue: '100.00' });
  });

  it('the monthly trend is the ledger revenue per month, ending with this month', () => {
    expect(dashboard.monthlyRevenue).toHaveLength(12);
    expect(dashboard.monthlyRevenue[11]).toEqual({ month: monthStart.toISOString().slice(0, 7), total: '1010.00' });
    expect(dashboard.monthlyRevenue[10]).toEqual({ month: lastMonth.toISOString().slice(0, 7), total: '500.00' });
  });

  it('keeps the response shape the platform and mobile apps read', () => {
    expect(Object.keys(dashboard)).toEqual(
      expect.arrayContaining(['revenue', 'expenses', 'profit', 'receivables', 'payables', 'bankAccounts', 'recentPayments', 'upcomingDue', 'pendingDocuments', 'monthlyRevenue']),
    );
    expect(dashboard.revenue).toHaveProperty('invoiceCount');
    expect(dashboard.receivables).toEqual(
      expect.objectContaining({ outstanding: expect.any(String), outstandingCount: expect.any(Number), overdue: expect.any(String), overdueCount: expect.any(Number) }),
    );
  });
});

describe('NL profit & loss sections', () => {
  it('shows operating revenue as income, purchases as cost of goods sold and only 81xx-84xx as other income', async () => {
    const from = monthStart.toISOString().slice(0, 10);
    const to = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const res = await call('/api/accounting-reports', accountingReportsRoutes, `/api/accounting-reports/profit-loss?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
    const value = (key: string) => res.data.totals[key].values.current;
    expect(value('income')).toBe('1000.00');
    expect(value('costOfGoodsSold')).toBe('300.00');
    expect(value('grossProfit')).toBe('700.00');
    expect(value('expenses')).toBe('25.00');
    expect(value('otherIncome')).toBe('10.00');
    expect(value('netProfit')).toBe('685.00');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const section = (code: string) => [...res.data.revenue, ...res.data.expenses].find((r: any) => r.accountCode === code)?.section;
    expect(section('8000')).toBe('income');
    expect(section('8100')).toBe('other_income');
    expect(section('4000')).toBe('cost_of_goods_sold');
  });
});
