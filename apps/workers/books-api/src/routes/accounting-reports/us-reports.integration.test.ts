/**
 * Phase 1 exit test (docs/plans/weldbooks-us.md): a US LLC (Schedule C) and a
 * US S corporation (1120-S) are set up through the API and run a month of
 * invoices, bills, partial payments, an unapplied payment and a manual entry;
 * accrual- and cash-basis reports match a hand-computed fixture. Also covers
 * fiscal-year defaults (month-based and 52–53 weeks), comparatives, month
 * columns, dimension filters, CSV and print export, the tax return worksheet
 * and the dimensions routes.
 *
 * The July 2026 fixture (both entities, 8% sales tax on invoices A and B):
 *
 *   Invoice A  Jul  3  consulting 1,000.00 + tax 80.00             = 1,080.00  paid in full Jul 15
 *   Invoice B  Jul 10  product 500.00 + services 300.00 + tax 64.00 =   864.00  half paid Jul 25 (432.00)
 *   Invoice C  Jul 20  services 400.00, no tax                      =   400.00  unpaid
 *   Bill 1     Jul  5  contract labor 600.00                        =   600.00  half paid Jul 18 (300.00)
 *   Bill 2     Jul 12  office supplies 200.00                       =   200.00  unpaid
 *   Payment    Jul 28  150.00 received, applied to nothing
 *   Manual     Jul 22  utilities 120.00 from the bank
 *
 *   Accrual  income 4010: 500, 4020: 1,700  = 2,200   expenses 6030: 600, 6110: 200, 6195: 120 = 920   net 1,280
 *   Cash     income 4010: 250, 4020: 1,150, 4120 (unapplied): 150 = 1,550
 *            expenses 6030: 300, 6195: 120 = 420      net 1,130
 *            (B's half payment: product 250, services 150, tax 32 of its 864)
 *   Sales tax payable  accrual 80 + 64 = 144   cash 80 + 32 = 112
 *   Bank 1,242 = 1,080 + 432 + 150 - 300 - 120
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { authGateStatuses } from '@weldsuite/worker-kit/testing/sweeps';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingReportsRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { accountingDimensionsRoutes } from '../accounting-dimensions';
import { billsRoutes } from '../bills';
import { invoicesRoutes } from '../invoices';
import { journalEntriesRoutes } from '../journal-entries';
import { paymentsRoutes } from '../payments';
import { salesTaxAgenciesRoutes } from '../sales-tax-agencies';
import { salesTaxJurisdictionsRoutes } from '../sales-tax-jurisdictions';

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

const report = (entityId: string, path: string) => call('/api/accounting-reports', accountingReportsRoutes, `/api/accounting-reports${path}`, { entityId });
const post = (mount: string, routes: Hono<any>, entityId: string, path: string, body?: unknown) => // eslint-disable-line @typescript-eslint/no-explicit-any
  call(mount, routes, `${mount}${path}`, { method: 'POST', entityId, body });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const row = (rows: any[], code: string) => rows.find((r) => r.accountCode === code);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const balances = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.accountCode || r.accountName, r.balance]));

interface Setup {
  id: string;
  acct: Record<string, string>;
  taxRateId: string;
  invoiceB: { id: string; journalEntryId: string };
  manualEntryId: string;
}

async function accountsByCode(entityId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  return Object.fromEntries(rows.map((a) => [a.code, a.id]));
}

/**
 * The sales tax engine taxes a US entity's invoices: register the state with one
 * state-level rate. The agency's liability stays on the chart's Sales Tax
 * Payable account (2200), which the report assertions read.
 */
async function registerSalesTax(entityId: string, acct: Record<string, string>, stateCode: string, rate: number) {
  const agency = await post('/api/sales-tax-agencies', salesTaxAgenciesRoutes, entityId, '', { stateCode, registeredFrom: '2026-01-01' });
  expect(agency.status).toBe(201);
  const jurisdiction = await post('/api/sales-tax-jurisdictions', salesTaxJurisdictionsRoutes, entityId, '', {
    agencyId: agency.data.id,
    level: 'state',
    name: 'State',
    rate: { rate, effectiveFrom: '2000-01-01' },
  });
  expect(jurisdiction.status).toBe(201);
  await db.update(schema.salesTaxAgencies).set({ liabilityAccountId: acct['2200'] }).where(eq(schema.salesTaxAgencies.id, agency.data.id));
}

const texas = { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' };

async function manualEntry(entityId: string, date: string, debit: string, credit: string, amount: string, acct: Record<string, string>) {
  const created = await post('/api/journal-entries', journalEntriesRoutes, entityId, '', {
    date,
    description: 'Manual entry',
    lines: [
      { accountId: acct[debit], debit: amount },
      { accountId: acct[credit], credit: amount },
    ],
  });
  expect(created.status).toBe(201);
  const posted = await post('/api/journal-entries', journalEntriesRoutes, entityId, `/${created.data.id}/post`);
  expect(posted.status).toBe(200);
  return created.data.id as string;
}

async function runMonth(body: Record<string, unknown>): Promise<Setup> {
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', { method: 'POST', body: { jurisdictionCode: 'US', ...body } });
  expect(created.status).toBe(201);
  const id = created.data.id as string;
  const acct = await accountsByCode(id);

  const taxRateId = `txr_st_${id}`;
  await db.insert(schema.taxRates).values({
    id: taxRateId,
    entityId: id,
    jurisdictionCode: 'US',
    name: 'Sales tax 8%',
    rate: '8.0000',
    type: 'sales',
    taxCategoryCode: 'standard',
    isDefault: false,
    isActive: true,
    ledgerAccountId: acct['2200'],
  });
  const billTo = (body.address as { state: string; postalCode: string }) ?? texas;
  await registerSalesTax(id, acct, billTo.state, 8);

  const invoice = async (issueDate: string, items: Array<{ description: string; unitPrice: string; accountId: string; taxRateId?: string; taxCode?: string }>) => {
    const res = await post('/api/invoices', invoicesRoutes, id, '', {
      contactId: 'pty_customer',
      issueDate,
      dueDate: '2026-08-31',
      billingAddress: billTo,
      items: items.map((i) => ({ quantity: '1', ...i })),
    });
    expect(res.status).toBe(201);
    const finalized = await post('/api/invoices', invoicesRoutes, id, `/${res.data.id}/finalize`);
    expect(finalized.status).toBe(200);
    return { id: res.data.id as string, journalEntryId: finalized.data.journalEntryId as string, total: res.data.total as string };
  };
  const bill = async (issueDate: string, description: string, unitPrice: string, accountId: string) => {
    const res = await post('/api/bills', billsRoutes, id, '', {
      contactId: 'pty_supplier',
      issueDate,
      dueDate: '2026-08-31',
      items: [{ description, quantity: '1', unitPrice, accountId }],
    });
    expect(res.status).toBe(201);
    const approved = await call('/api/bills', billsRoutes, `/api/bills/${res.data.id}/approve`, { method: 'PATCH', entityId: id });
    expect(approved.status).toBe(200);
    return res.data.id as string;
  };
  const pay = async (type: 'received' | 'sent', date: string, amount: string, allocation?: { invoiceId?: string; billId?: string }) => {
    const res = await post('/api/payments', paymentsRoutes, id, '', {
      type,
      amount,
      date,
      contactId: type === 'received' ? 'pty_customer' : 'pty_supplier',
      paymentMethod: 'check',
      ...(allocation ? { allocations: [{ ...allocation, amount }] } : {}),
    });
    expect(res.status).toBe(201);
    return res.data;
  };

  const invoiceA = await invoice('2026-07-03', [{ description: 'Consulting', unitPrice: '1000', accountId: acct['4020'], taxRateId }]);
  const invoiceB = await invoice('2026-07-10', [
    { description: 'Product', unitPrice: '500', accountId: acct['4010'], taxRateId },
    { description: 'Services', unitPrice: '300', accountId: acct['4020'], taxRateId },
  ]);
  await invoice('2026-07-20', [{ description: 'Retainer', unitPrice: '400', accountId: acct['4020'], taxCode: 'non_taxable' }]);
  expect(invoiceA.total).toBe('1080.00');
  expect(invoiceB.total).toBe('864.00');

  const bill1 = await bill('2026-07-05', 'Contract work', '600', acct['6030']);
  await bill('2026-07-12', 'Office supplies', '200', acct['6110']);

  await pay('received', '2026-07-15', '1080.00', { invoiceId: invoiceA.id });
  await pay('received', '2026-07-25', '432.00', { invoiceId: invoiceB.id });
  await pay('received', '2026-07-28', '150.00');
  await pay('sent', '2026-07-18', '300.00', { billId: bill1 });
  const manualEntryId = await manualEntry(id, '2026-07-22', '6195', '1000', '120.00', acct);

  return { id, acct, taxRateId, invoiceB, manualEntryId };
}

let llc: Setup;
let sCorp: Setup;
/** An LLC with manual entries only: July 2026 (income 1,000, utilities 120), June 2026 (utilities 100), July 2025 (utilities 90). */
let cmp: { id: string; acct: Record<string, string> };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.parties).values([
    { id: 'pty_customer', displayName: 'Northwind Traders', role: 'customer', billingAddress: { line1: '5 Pine St', city: 'Seattle', state: 'WA', postalCode: '98101', country: 'US' } },
    { id: 'pty_supplier', displayName: 'Contoso Contractors', role: 'supplier' },
  ]);
  const address = { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' };
  llc = await runMonth({ name: 'Acme Studio LLC', entityType: 'single_member_llc', accountingMethod: 'cash', taxIdentifiers: { einOrSsn: '12-3456789' }, address });
  sCorp = await runMonth({ name: 'Beta Software Inc', entityType: 's_corp', fiscalYearStart: 7, address: { ...address, state: 'CA' } });


  const gamma = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: { name: 'Gamma Consulting LLC', jurisdictionCode: 'US', entityType: 'single_member_llc', address },
  });
  const acct = await accountsByCode(gamma.data.id);
  cmp = { id: gamma.data.id, acct };
  await manualEntry(cmp.id, '2026-07-05', '1000', '4020', '1000.00', acct);
  await manualEntry(cmp.id, '2026-07-22', '6195', '1000', '120.00', acct);
  await manualEntry(cmp.id, '2026-06-10', '6195', '1000', '100.00', acct);
  await manualEntry(cmp.id, '2025-07-10', '6195', '1000', '90.00', acct);
}, 180_000);

describe('profit and loss on a month of US books', () => {
  const july = '?from=2026-07-01&to=2026-07-31';

  it('accrual basis recognises documents when they are issued', async () => {
    for (const setup of [llc, sCorp]) {
      const res = await report(setup.id, `/profit-loss${july}&basis=accrual`);
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ basis: 'accrual', period: { from: '2026-07-01', to: '2026-07-31' }, totalRevenue: '2200.00', totalExpenses: '920.00', netProfit: '1280.00' });
      expect(balances(res.data.revenue)).toEqual({ '4010': '500.00', '4020': '1700.00' });
      expect(balances(res.data.expenses)).toEqual({ '6030': '600.00', '6110': '200.00', '6195': '120.00' });
    }
  });

  it('cash basis recognises payments, spreading a partial payment over the lines and the tax', async () => {
    for (const setup of [llc, sCorp]) {
      const res = await report(setup.id, `/profit-loss${july}&basis=cash`);
      expect(res.status).toBe(200);
      expect(res.data).toMatchObject({ basis: 'cash', totalRevenue: '1550.00', totalExpenses: '420.00', netProfit: '1130.00' });
      // 1,000 of A + 150 of B's services (half of 300) + 150 unapplied income stay on the service and unapplied accounts
      expect(balances(res.data.revenue)).toEqual({ '4010': '250.00', '4020': '1150.00', '4120': '150.00' });
      expect(balances(res.data.expenses)).toEqual({ '6030': '300.00', '6195': '120.00' });
      expect(res.data.totals.income.values.current).toBe('1400.00');
      expect(res.data.totals.otherIncome.values.current).toBe('150.00');
      expect(res.data.totals.netProfit.values.current).toBe('1130.00');
    }
  });

  it('defaults to the entity accounting method, then accrual', async () => {
    expect((await report(llc.id, `/profit-loss${july}`)).data.basis).toBe('cash');
    expect((await report(sCorp.id, `/profit-loss${july}`)).data.basis).toBe('accrual');
    const bad = await report(llc.id, `/profit-loss${july}&basis=whenever`);
    expect(bad.status).toBe(400);
  });

  it('every payment and its sales tax is recognised exactly once when the documents are fully paid', async () => {
    // Over all of 2026 the cash totals are the July ones plus nothing; the paid share of tax is 112.00
    const bs = await report(llc.id, '/balance-sheet?asOf=2026-12-31&basis=cash');
    expect(balances(bs.data.liabilities)['2200']).toBe('112.00');
  });
});

describe('balance sheet', () => {
  it('cash basis has no receivables or payables and only the sales tax that was paid', async () => {
    const res = await report(llc.id, '/balance-sheet?asOf=2026-07-31&basis=cash');
    expect(res.status).toBe(200);
    // the money sits in the bank and undeposited funds accounts, whichever the payments went to
    expect(res.data.assets.map((r: { accountCode: string }) => r.accountCode).filter((code: string) => !['1000', '1050'].includes(code))).toEqual([]);
    expect(row(res.data.liabilities, '2000')).toBeUndefined();
    expect(row(res.data.assets, '1100')).toBeUndefined();
    expect(balances(res.data.liabilities)).toEqual({ '2200': '112.00' });
    expect(res.data).toMatchObject({ totalAssets: '1242.00', totalLiabilities: '112.00', totalEquity: '1130.00', totalLiabilitiesAndEquity: '1242.00', isBalanced: true, difference: '0.00' });
    const calculated = res.data.equity.filter((r: { virtual?: boolean }) => r.virtual);
    expect(calculated.map((r: { accountName: string; balance: string }) => [r.accountName, r.balance])).toEqual([
      ['Retained earnings (earlier years)', '0.00'],
      ['Net income (this fiscal year)', '1130.00'],
    ]);
  });

  it('accrual basis carries receivables, payables and all the sales tax', async () => {
    const res = await report(llc.id, '/balance-sheet?asOf=2026-07-31&basis=accrual');
    expect(row(res.data.assets, '1100').balance).toBe('682.00');
    expect(res.data.assets.map((r: { accountCode: string }) => r.accountCode).filter((code: string) => !['1000', '1050', '1100'].includes(code))).toEqual([]);
    expect(balances(res.data.liabilities)).toEqual({ '2000': '500.00', '2200': '144.00' });
    expect(res.data).toMatchObject({ totalAssets: '1924.00', totalLiabilities: '644.00', totalEquity: '1280.00', isBalanced: true });
  });

  it('earnings of earlier fiscal years show as retained earnings; a fiscal year starting in July restarts the current year', async () => {
    // Gamma (calendar year): the 2025 utilities of 90 are an earlier year's loss; 2026 so far is 1,000 - 120 - 100
    const gamma = await report(cmp.id, '/balance-sheet?asOf=2026-07-31&basis=accrual');
    expect(gamma.data.equity.find((r: { accountName: string }) => r.accountName.startsWith('Retained'))?.balance).toBe('-90.00');
    expect(gamma.data.equity.find((r: { accountName: string }) => r.accountName.startsWith('Net income'))?.balance).toBe('780.00');
    expect(gamma.data).toMatchObject({ totalAssets: '690.00', totalEquity: '690.00', isBalanced: true });
    // Beta's fiscal year began on 1 July: all of July is "this fiscal year"
    const beta = await report(sCorp.id, '/balance-sheet?asOf=2026-07-31&basis=accrual');
    expect(beta.data.equity.find((r: { accountName: string }) => r.accountName.startsWith('Net income'))?.balance).toBe('1280.00');
    expect(beta.data.equity.find((r: { accountName: string }) => r.accountName.startsWith('Retained'))?.balance).toBe('0.00');
  });
});

describe('trial balance and general ledger', () => {
  it('both bases balance', async () => {
    for (const basis of ['accrual', 'cash']) {
      const tb = await report(sCorp.id, `/trial-balance?from=2026-07-01&to=2026-07-31&basis=${basis}`);
      expect(tb.status).toBe(200);
      expect(tb.data.isBalanced).toBe(true);
      expect(tb.data.totalDebit).toBe(tb.data.totalCredit);
    }
    const cash = await report(sCorp.id, '/trial-balance?from=2026-07-01&to=2026-07-31&basis=cash');
    expect(row(cash.data.accounts, '1100')).toBeUndefined();
    expect(row(cash.data.accounts, '4120')).toMatchObject({ creditBalance: '150.00', debitBalance: '0.00' });
    // the cash accounts together hold what was received and paid
    const cashAccounts = cash.data.accounts.filter((r: { accountCode: string }) => ['1000', '1050'].includes(r.accountCode));
    expect(cashAccounts.reduce((total: number, r: { values: { current: string } }) => total + Number(r.values.current), 0)).toBeCloseTo(1242, 2);
  });

  it('the sales tax account lists the payments that recognised it on cash basis', async () => {
    const cash = await report(llc.id, `/general-ledger?accountId=${llc.acct['2200']}&from=2026-07-01&to=2026-07-31&basis=cash`);
    expect(cash.status).toBe(200);
    expect(cash.data).toMatchObject({ basis: 'cash', openingBalance: '0.00', closingBalance: '-112.00', totalCredit: '112.00' });
    expect(cash.data.lines.map((l: { credit: string; runningBalance: string }) => [l.credit, l.runningBalance])).toEqual([
      ['80.00', '-80.00'],
      ['32.00', '-112.00'],
    ]);
    expect(cash.data.lines[1].paymentId).toMatch(/^pay_/);

    const accrual = await report(llc.id, `/general-ledger?accountId=${llc.acct['2200']}&from=2026-07-01&to=2026-07-31&basis=accrual`);
    expect(accrual.data.lines.map((l: { credit: string }) => l.credit)).toEqual(['80.00', '64.00']);
    expect(accrual.data.closingBalance).toBe('-144.00');
  });

  it('the opening balance carries what was booked before the period, and pages split the lines', async () => {
    // Service revenue on cash basis: 1,000 of invoice A on the 15th, 150 of invoice B on the 25th
    const late = await report(llc.id, `/general-ledger?accountId=${llc.acct['4020']}&from=2026-07-20&to=2026-07-31&basis=cash`);
    expect(late.data).toMatchObject({ openingBalance: '-1000.00', closingBalance: '-1150.00', totalCredit: '150.00' });
    expect(late.data.lines.map((l: { runningBalance: string }) => l.runningBalance)).toEqual(['-1150.00']);

    const second = await report(llc.id, `/general-ledger?accountId=${llc.acct['4020']}&from=2026-07-01&to=2026-07-31&basis=cash&pageSize=1&page=2`);
    expect(second.data.pagination).toMatchObject({ totalCount: 2, totalPages: 2, hasMore: false, page: 2 });
    expect(second.data.lines).toHaveLength(1);
    expect(second.data.lines[0]).toMatchObject({ credit: '150.00', runningBalance: '-1150.00' });
    const first = await report(llc.id, `/general-ledger?accountId=${llc.acct['4020']}&from=2026-07-01&to=2026-07-31&basis=cash&pageSize=1&page=1`);
    expect(first.data.pagination.hasMore).toBe(true);
    const unknown = await report(llc.id, '/general-ledger?accountId=acc_missing');
    expect(unknown.status).toBe(404);
    expect((await report(llc.id, '/general-ledger')).status).toBe(400);
  });
});

describe('fiscal years', () => {
  it('default ranges start at the fiscal year start, not 1 January', async () => {
    const calendar = await report(llc.id, '/profit-loss?to=2026-02-10');
    expect(calendar.data.period).toEqual({ from: '2026-01-01', to: '2026-02-10' });
    const july = await report(sCorp.id, '/profit-loss?to=2026-02-10');
    expect(july.data.period).toEqual({ from: '2025-07-01', to: '2026-02-10' });
    const afterStart = await report(sCorp.id, '/trial-balance?to=2026-08-15');
    expect(afterStart.data.period).toEqual({ from: '2026-07-01', to: '2026-08-15' });
  });

  it('with no dates at all the range runs from the fiscal year start to today', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-02-10T18:00:00Z'));
      expect((await report(sCorp.id, '/profit-loss')).data.period).toEqual({ from: '2025-07-01', to: '2026-02-10' });
      expect((await report(llc.id, '/revenue-by-customer')).data.period).toEqual({ from: '2026-01-01', to: '2026-02-10' });
      const bs = await report(sCorp.id, '/balance-sheet');
      expect(bs.data.asOf).toBe('2026-02-10');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a 52–53-week year runs from the day after the last year ended', async () => {
    const res = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      body: {
        name: 'Retail Co',
        jurisdictionCode: 'US',
        entityType: 'c_corp',
        // the last Saturday of June
        fiscalYearConfig: { type: 'fifty_two_fifty_three', endMonth: 6, weekday: 6, rule: 'last' },
      },
    });
    expect(res.data.fiscalYearConfig).toMatchObject({ endMonth: 6 });
    const p = await report(res.data.id, '/profit-loss?to=2026-02-10');
    expect(p.data.period).toEqual({ from: '2025-06-29', to: '2026-02-10' });
    // FY2026 ends on the last Saturday of June 2026
    const worksheet = await report(res.data.id, '/tax-worksheet?year=2026');
    expect(worksheet.data.period).toEqual({ from: '2025-06-29', to: '2026-06-27' });
    expect(worksheet.data.form).toBe('f1120');
  });

  it('rejects bad dates', async () => {
    expect((await report(llc.id, '/profit-loss?from=2026-13-01')).status).toBe(400);
    expect((await report(llc.id, '/profit-loss?from=2026-08-01&to=2026-07-01')).status).toBe(400);
  });
});

describe('comparative and split columns', () => {
  it('prior period adds the previous month with deltas, over the union of accounts', async () => {
    const res = await report(cmp.id, '/profit-loss?from=2026-07-01&to=2026-07-31&basis=accrual&compare=prior_period');
    expect(res.data.columns).toEqual([
      { key: 'current', label: '2026-07-01 to 2026-07-31', from: '2026-07-01', to: '2026-07-31' },
      { key: 'prior', label: '2026-06-01 to 2026-06-30', from: '2026-06-01', to: '2026-06-30' },
    ]);
    const utilities = row(res.data.expenses, '6195');
    expect(utilities.values).toEqual({ current: '120.00', prior: '100.00' });
    expect(utilities.delta).toEqual({ amount: '20.00', percent: 20 });
    // a revenue account with no activity in June is still a row, with a zero prior
    expect(row(res.data.revenue, '4020')).toMatchObject({ values: { current: '1000.00', prior: '0.00' }, delta: { amount: '1000.00', percent: null } });
    expect(res.data.totals.netProfit).toEqual({ values: { current: '880.00', prior: '-100.00' }, delta: { amount: '980.00', percent: 980 } });
    // the scalar fields keep describing the current column
    expect(res.data.netProfit).toBe('880.00');
  });

  it('prior year moves the range back a year', async () => {
    const res = await report(cmp.id, '/profit-loss?from=2026-07-01&to=2026-07-31&basis=accrual&compare=prior_year');
    expect(res.data.columns[1]).toMatchObject({ key: 'prior', from: '2025-07-01', to: '2025-07-31' });
    expect(row(res.data.expenses, '6195')).toMatchObject({ values: { current: '120.00', prior: '90.00' }, delta: { amount: '30.00', percent: 33.3 } });
  });

  it('a balance sheet compares two dates, a trial balance two periods', async () => {
    const bs = await report(cmp.id, '/balance-sheet?asOf=2026-07-31&basis=accrual&compare=prior_year');
    expect(bs.data.columns.map((c: { to: string }) => c.to)).toEqual(['2026-07-31', '2025-07-31']);
    expect(row(bs.data.assets, '1000').values).toEqual({ current: '690.00', prior: '-90.00' });
    expect(bs.data.totals.assets.delta).toEqual({ amount: '780.00', percent: 866.7 });
    const june = await report(cmp.id, '/balance-sheet?asOf=2026-07-31&basis=accrual&compare=prior_period');
    expect(june.data.columns[1].to).toBe('2026-06-30');
    expect(row(june.data.assets, '1000').values).toEqual({ current: '690.00', prior: '-190.00' });

    const tb = await report(cmp.id, '/trial-balance?from=2026-07-01&to=2026-07-31&basis=accrual&compare=prior_period');
    expect(row(tb.data.accounts, '6195').values).toEqual({ current: '120.00', prior: '100.00' });
  });

  it('months give a column per month and a total', async () => {
    const res = await report(cmp.id, '/profit-loss?from=2026-06-01&to=2026-07-31&basis=accrual&periods=months');
    expect(res.data.columns.map((c: { key: string }) => c.key)).toEqual(['2026-06', '2026-07', 'total']);
    expect(row(res.data.expenses, '6195').values).toEqual({ '2026-06': '100.00', '2026-07': '120.00', total: '220.00' });
    expect(row(res.data.revenue, '4020').values).toEqual({ '2026-06': '0.00', '2026-07': '1000.00', total: '1000.00' });
    expect(res.data.totalExpenses).toBe('220.00');
    expect((await report(cmp.id, '/profit-loss?periods=months&compare=prior_year')).status).toBe(400);
  });

  it('quarters follow the fiscal year', async () => {
    const res = await report(sCorp.id, '/profit-loss?from=2026-07-01&to=2027-03-31&basis=accrual&periods=quarters');
    expect(res.data.columns.map((c: { from: string; to: string }) => [c.from, c.to])).toEqual([
      ['2026-07-01', '2026-09-30'],
      ['2026-10-01', '2026-12-31'],
      ['2027-01-01', '2027-03-31'],
      ['2026-07-01', '2027-03-31'],
    ]);
    expect(res.data.revenue[0].values).toMatchObject({ total: expect.any(String) });
  });

  it('cash flow keeps { period, monthly, totals } and compares', async () => {
    await db.insert(schema.bankAccounts).values({ id: 'ba_cf', entityId: llc.id, name: 'Checking', currency: 'USD', ledgerAccountId: llc.acct['1000'] });
    await db.insert(schema.bankTransactions).values([
      { id: 'bt_cf1', entityId: llc.id, bankAccountId: 'ba_cf', date: new Date('2026-07-15'), amount: '1080.00', status: 'unreconciled', description: 'Northwind' },
      { id: 'bt_cf2', entityId: llc.id, bankAccountId: 'ba_cf', date: new Date('2026-07-18'), amount: '-300.00', status: 'unreconciled', description: 'Contoso' },
      { id: 'bt_cf3', entityId: llc.id, bankAccountId: 'ba_cf', date: new Date('2026-06-02'), amount: '-100.00', status: 'unreconciled', description: 'Power' },
    ]);
    const res = await report(llc.id, '/cash-flow?from=2026-07-01&to=2026-07-31&compare=prior_period');
    expect(res.status).toBe(200);
    expect(res.data.period).toEqual({ from: '2026-07-01', to: '2026-07-31' });
    expect(res.data.monthly).toEqual([{ month: '2026-07', inflows: '1080.00', outflows: '-300.00', net: '780.00' }]);
    expect(res.data.totals).toEqual({ inflows: '1080.00', outflows: '-300.00', net: '780.00' });
    expect(res.data.comparison.mode).toBe('prior_period');
    expect(res.data.comparison.totals).toEqual({ inflows: '0.00', outflows: '-100.00', net: '-100.00' });
    expect(res.data.comparison.delta.net).toEqual({ amount: '880.00', percent: 880 });
    expect(res.data).not.toHaveProperty('months');
  });
});

describe('class and location filters', () => {
  let retail: string;
  let studio: string;

  beforeAll(async () => {
    const mk = async (dimension: 'class' | 'location', name: string) => {
      const r = await post('/api/accounting-dimensions', accountingDimensionsRoutes, llc.id, '', { dimension, name });
      expect(r.status).toBe(201);
      return r.data.id as string;
    };
    retail = await mk('class', 'Retail');
    studio = await mk('location', 'Studio');
    // Tag invoice B's product line with Retail, and the manual utilities line with the Studio location.
    await db
      .update(schema.journalLines)
      .set({ classId: retail })
      .where(and(eq(schema.journalLines.journalEntryId, llc.invoiceB.journalEntryId), eq(schema.journalLines.accountId, llc.acct['4010'])));
    await db
      .update(schema.journalLines)
      .set({ locationId: studio })
      .where(and(eq(schema.journalLines.journalEntryId, llc.manualEntryId), eq(schema.journalLines.accountId, llc.acct['6195'])));
  });

  it('filters accrual lines by class', async () => {
    const res = await report(llc.id, `/profit-loss?from=2026-07-01&to=2026-07-31&basis=accrual&classId=${retail}`);
    expect(balances(res.data.revenue)).toEqual({ '4010': '500.00' });
    expect(res.data.expenses).toEqual([]);
    expect(res.data.netProfit).toBe('500.00');
  });

  it('cash basis keeps the dimension of the document lines it recognises', async () => {
    const res = await report(llc.id, `/profit-loss?from=2026-07-01&to=2026-07-31&basis=cash&classId=${retail}`);
    expect(balances(res.data.revenue)).toEqual({ '4010': '250.00' });
    expect(res.data.netProfit).toBe('250.00');
  });

  it('filters by location, and the unapplied cash line has no dimension', async () => {
    const accrual = await report(llc.id, `/profit-loss?from=2026-07-01&to=2026-07-31&basis=accrual&locationId=${studio}`);
    expect(balances(accrual.data.expenses)).toEqual({ '6195': '120.00' });
    const cash = await report(llc.id, `/profit-loss?from=2026-07-01&to=2026-07-31&basis=cash&locationId=${studio}`);
    expect(cash.data.revenue).toEqual([]);
    expect(balances(cash.data.expenses)).toEqual({ '6195': '120.00' });
  });
});

describe('other reports', () => {
  it('revenue by customer and expense by category follow the basis', async () => {
    const accrual = await report(llc.id, '/revenue-by-customer?from=2026-07-01&to=2026-07-31&basis=accrual');
    expect(accrual.data.customers).toEqual([{ contactId: 'pty_customer', contactName: 'Northwind Traders', totalRevenue: '2200.00' }]);
    const cash = await report(llc.id, '/revenue-by-customer?from=2026-07-01&to=2026-07-31&basis=cash');
    // the unapplied 150 belongs to the customer who paid it
    expect(cash.data).toMatchObject({ grandTotal: '1550.00' });
    expect(cash.data.customers[0]).toMatchObject({ contactId: 'pty_customer', totalRevenue: '1550.00' });

    const expenses = await report(llc.id, '/expense-by-category?from=2026-07-01&to=2026-07-31&basis=cash');
    expect(expenses.data.categories.map((c: { accountCode: string; totalExpense: string }) => [c.accountCode, c.totalExpense])).toEqual([
      ['6030', '300.00'],
      ['6195', '120.00'],
    ]);
  });

  it('ages open documents and ignores drafts', async () => {
    const draft = await post('/api/invoices', invoicesRoutes, llc.id, '', {
      contactId: 'pty_customer',
      issueDate: '2026-07-30',
      dueDate: '2026-08-30',
      items: [{ description: 'Draft', quantity: '1', unitPrice: '999', accountId: llc.acct['4020'] }],
    });
    expect(draft.status).toBe(201);

    const ar = await report(llc.id, '/aged-receivables?asOf=2026-09-15');
    // B's open 432.00 and C's 400.00, both due 31 August: 15 days late
    expect(ar.data.total).toBe('832.00');
    expect(ar.data.buckets['1-30']).toEqual({ total: '832.00', count: 2 });
    expect(ar.data.contacts).toEqual([expect.objectContaining({ contactId: 'pty_customer', total: '832.00', '1-30': '832.00' })]);
    expect(ar.data.documents).toHaveLength(2);

    const ap = await report(llc.id, '/aged-payables?asOf=2026-07-31');
    expect(ap.data.total).toBe('500.00');
    expect(ap.data.buckets.current).toBe('500.00');
    expect(ap.data.bucketCounts.current).toBe(2);
  });
});

describe('export', () => {
  it('csv downloads the report as a table', async () => {
    const res = await report(llc.id, '/profit-loss?from=2026-07-01&to=2026-07-31&basis=cash&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('profit-and-loss-2026-07-01_2026-07-31.csv');
    const lines = res.text.replace('\uFEFF', '').split('\r\n');
    expect(lines.slice(0, 5)).toEqual(['Profit and loss', 'Acme Studio LLC', 'Basis: Cash', 'Period: 2026-07-01 to 2026-07-31', 'Amounts in USD']);
    expect(lines).toContain('Code,Name,2026-07-01 to 2026-07-31');
    expect(lines).toContain('4020,  Service revenue,1150.00');
    expect(lines).toContain('4120,  Unapplied cash payment income,150.00');
    expect(lines).toContain(',Net income,1130.00');
  });

  it('csv carries comparative columns and deltas', async () => {
    const res = await report(cmp.id, '/profit-loss?from=2026-07-01&to=2026-07-31&basis=accrual&compare=prior_period&format=csv');
    const lines = res.text.replace('\uFEFF', '').split('\r\n');
    expect(lines).toContain('Code,Name,2026-07-01 to 2026-07-31,2026-06-01 to 2026-06-30,Change,Change %');
    expect(lines).toContain('6195,  Utilities,120.00,100.00,20.00,20%');
  });

  it('every financial report can be exported', async () => {
    const paths = [
      '/balance-sheet?asOf=2026-07-31',
      '/trial-balance?from=2026-07-01&to=2026-07-31',
      `/general-ledger?accountId=${llc.acct['2200']}&from=2026-07-01&to=2026-07-31`,
      '/cash-flow?from=2026-07-01&to=2026-07-31',
      '/revenue-by-customer?from=2026-07-01&to=2026-07-31',
      '/expense-by-category?from=2026-07-01&to=2026-07-31',
      '/aged-receivables?asOf=2026-07-31',
      '/aged-payables?asOf=2026-07-31',
      '/tax-worksheet?year=2026',
    ];
    for (const path of paths) {
      const csv = await report(llc.id, `${path}${path.includes('?') ? '&' : '?'}format=csv`);
      expect(csv.status, path).toBe(200);
      expect(csv.headers.get('content-type'), path).toContain('text/csv');
      expect(csv.text.split('\r\n').length, path).toBeGreaterThan(7);
      const print = await report(llc.id, `${path}${path.includes('?') ? '&' : '?'}format=print`);
      expect(print.status, path).toBe(200);
      expect(print.data.table.rows.length, path).toBeGreaterThan(0);
    }
    expect((await report(llc.id, '/profit-loss?format=xml')).status).toBe(400);
  });

  it('print gives a document with the entity header and the paper size', async () => {
    const res = await report(llc.id, '/profit-loss?from=2026-07-01&to=2026-07-31&basis=cash&format=print');
    expect(res.data).toMatchObject({
      kind: 'report',
      report: 'profit_loss',
      title: 'Profit and loss',
      paper: 'letter',
      basis: 'cash',
      periodLabel: 'Period: 2026-07-01 to 2026-07-31',
      currency: 'USD',
      entity: { name: 'Acme Studio LLC', taxId: '12-3456789', jurisdictionCode: 'US' },
    });
    expect(res.data.table.columns).toEqual([{ key: 'current', label: '2026-07-01 to 2026-07-31', numeric: true }]);
    expect(res.data.table.rows.at(-1)).toMatchObject({ kind: 'total', label: 'Net income', values: { current: '1130.00' } });
  });
});

describe('tax return worksheet', () => {
  it('groups a Schedule C entity\'s trial balance by return line, on cash basis', async () => {
    const res = await report(llc.id, '/tax-worksheet?year=2026&basis=cash');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ form: 'sch_c', formLabel: 'Schedule C (Form 1040)', taxYear: 2026, basis: 'cash', period: { from: '2026-01-01', to: '2026-12-31' } });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = Object.fromEntries(res.data.sections.flatMap((s: any) => s.lines.map((l: any) => [l.code, l])));
    expect(lines['sch_c.1']).toMatchObject({ line: '1', amount: '1400.00', side: 'credit' });
    expect(lines['sch_c.1'].accounts.map((a: { code: string; amount: string }) => [a.code, a.amount])).toEqual([
      ['4010', '250.00'],
      ['4020', '1150.00'],
    ]);
    expect(lines['sch_c.6'].amount).toBe('150.00');
    expect(lines['sch_c.11'].amount).toBe('300.00');
    expect(lines['sch_c.25'].amount).toBe('120.00');
    expect(lines['sch_c.8'].amount).toBe('0.00');
    // lines no account maps to stay on the form
    expect(lines['sch_c.30']).toMatchObject({ amount: '0.00', accounts: [] });

    expect(res.data.summary).toMatchObject({
      totalIncome: '1400.00',
      totalOtherIncome: '150.00',
      totalDeductions: '420.00',
      netIncomeFromLines: '1130.00',
      reconciles: true,
    });
    expect(res.data.unmapped).toEqual([]);
    const sections = res.data.sections.map((s: { key: string }) => s.key);
    expect(sections.indexOf('income')).toBeLessThan(sections.indexOf('deduction'));
    expect(sections).toContain('not_deductible');
  });

  it('signs follow the form: contra accounts read positive on their own line, meals are 50% deductible', async () => {
    // Sales discount (debit-natural revenue) maps to Schedule C line 2; 200 of meals map to 24b
    await manualEntry(cmp.id, '2026-08-05', '4040', '1000', '25.00', cmp.acct);
    await manualEntry(cmp.id, '2026-08-06', '6185', '1000', '200.00', cmp.acct);
    const res = await report(cmp.id, '/tax-worksheet?year=2026&basis=accrual');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = Object.fromEntries(res.data.sections.flatMap((s: any) => s.lines.map((l: any) => [l.code, l])));
    expect(lines['sch_c.2']).toMatchObject({ amount: '25.00', side: 'debit' });
    expect(lines['sch_c.24b']).toMatchObject({ amount: '200.00', deductiblePercent: 50, deductibleAmount: '100.00', nonDeductibleAmount: '100.00' });
    // income section: gross receipts less the discount
    const income = res.data.sections.find((s: { key: string }) => s.key === 'income');
    expect(income.total).toBe('975.00');
    // 1,000 - 25 - utilities of June and July (220) - meals 200
    expect(res.data.summary).toMatchObject({ netIncomePerBooks: '555.00', netIncomeFromLines: '555.00', reconciles: true });
  });

  it('lists accounts without a tax line separately and reports the difference', async () => {
    const [account] = await db.select().from(schema.accounts).where(and(eq(schema.accounts.entityId, llc.id), eq(schema.accounts.code, '6195')));
    await db.update(schema.accounts).set({ taxLine: null }).where(eq(schema.accounts.id, account.id));
    const res = await report(llc.id, '/tax-worksheet?year=2026&basis=cash');
    expect(res.data.unmapped).toEqual([expect.objectContaining({ accountId: account.id, code: '6195', reason: 'none', amount: '120.00' })]);
    expect(res.data.summary).toMatchObject({ netIncomePerBooks: '1130.00', unmappedNetIncome: '-120.00', netIncomeFromLines: '1250.00', reconciles: true });

    // a line of another return counts as unmapped too, with its reason
    await db.update(schema.accounts).set({ taxLine: 'f1120s.16' }).where(eq(schema.accounts.id, account.id));
    const other = await report(llc.id, '/tax-worksheet?year=2026&basis=cash');
    expect(other.data.unmapped[0]).toMatchObject({ code: '6195', reason: 'other_form', taxLine: 'f1120s.16' });
    await db.update(schema.accounts).set({ taxLine: 'sch_c.25' }).where(eq(schema.accounts.id, account.id));
  });

  it('an S corporation gets 1120-S lines and a Schedule L with beginning and ending balances', async () => {
    // fiscal year July 2026 to June 2027 is FY2027
    const res = await report(sCorp.id, '/tax-worksheet?year=2027&basis=accrual');
    expect(res.data).toMatchObject({ form: 'f1120s', taxYear: 2026, period: { from: '2026-07-01', to: '2027-06-30' } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = Object.fromEntries(res.data.sections.flatMap((s: any) => s.lines.map((l: any) => [l.code, l])));
    expect(lines['f1120s.1a'].amount).toBe('2200.00');
    expect(lines['f1120s.20'].amount).toBe('920.00');
    expect(lines['f1120s.l1']).toMatchObject({ amount: '1242.00', beginningAmount: '0.00' });
    expect(lines['f1120s.l2a'].amount).toBe('682.00');
    expect(lines['f1120s.l16'].amount).toBe('500.00');
    expect(res.data.summary).toMatchObject({ netIncomeFromLines: '1280.00', netIncomePerBooks: '1280.00', reconciles: true });
    const schL = res.data.sections.find((s: { key: string }) => s.key === 'balance_sheet');
    expect(schL.total).toBeNull();
  });

  it('is for US entities with a return', async () => {
    const nl = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', { method: 'POST', body: { name: 'Bedrijf BV', jurisdictionCode: 'NL' } });
    const res = await report(nl.data.id, '/tax-worksheet?year=2026');
    expect(res.status).toBe(400);
    expect((await report(llc.id, '/tax-worksheet?year=99')).status).toBe(400);
  });

  it('csv lists the accounts behind each line', async () => {
    const res = await report(llc.id, '/tax-worksheet?year=2026&basis=cash&format=csv');
    const lines = res.text.replace('\uFEFF', '').split('\r\n');
    expect(lines[0]).toBe('Tax return worksheet: Schedule C (Form 1040)');
    expect(lines).toContain('Code,Name,Line,Amount,Beginning of year,Deductible');
    expect(lines).toContain('sch_c.1,Gross receipts or sales,1,1400.00,,');
    expect(lines).toContain(',  4010 Product sales,,250.00,,');
  });
});

describe('dimensions', () => {
  it('create, list, update and delete a class with a parent', async () => {
    const parent = await post('/api/accounting-dimensions', accountingDimensionsRoutes, sCorp.id, '', { dimension: 'class', name: 'Services', code: 'SVC' });
    expect(parent.status).toBe(201);
    expect(parent.data).toMatchObject({ dimension: 'class', name: 'Services', code: 'SVC', isActive: true, parentId: null });

    const child = await post('/api/accounting-dimensions', accountingDimensionsRoutes, sCorp.id, '', { dimension: 'class', name: 'Consulting', parentId: parent.data.id });
    expect(child.status).toBe(201);

    // a duplicate code, a parent of another dimension, and a cycle are refused
    expect((await post('/api/accounting-dimensions', accountingDimensionsRoutes, sCorp.id, '', { dimension: 'class', name: 'Dup', code: 'SVC' })).status).toBe(409);
    const location = await post('/api/accounting-dimensions', accountingDimensionsRoutes, sCorp.id, '', { dimension: 'location', name: 'Berlin' });
    expect((await post('/api/accounting-dimensions', accountingDimensionsRoutes, sCorp.id, '', { dimension: 'class', name: 'X', parentId: location.data.id })).status).toBe(400);
    const cycle = await call('/api/accounting-dimensions', accountingDimensionsRoutes, `/api/accounting-dimensions/${parent.data.id}`, { method: 'PATCH', entityId: sCorp.id, body: { parentId: child.data.id } });
    expect(cycle.status).toBe(400);
    expect(cycle.error?.message).toMatch(/circular/);

    const list = await call('/api/accounting-dimensions', accountingDimensionsRoutes, '/api/accounting-dimensions?dimension=class', { entityId: sCorp.id });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.text).data.map((d: { name: string }) => d.name)).toEqual(['Consulting', 'Services']);
    expect(JSON.parse(list.text).pagination).toMatchObject({ totalCount: 2, hasMore: false, cursor: null });

    const updated = await call('/api/accounting-dimensions', accountingDimensionsRoutes, `/api/accounting-dimensions/${child.data.id}`, { method: 'PATCH', entityId: sCorp.id, body: { name: 'Advisory', isActive: false } });
    expect(updated.data).toMatchObject({ name: 'Advisory', isActive: false });
    const active = await call('/api/accounting-dimensions', accountingDimensionsRoutes, '/api/accounting-dimensions?isActive=true&dimension=class', { entityId: sCorp.id });
    expect(JSON.parse(active.text).data.map((d: { name: string }) => d.name)).toEqual(['Services']);

    // a parent with children can't go; a leaf can
    const blocked = await call('/api/accounting-dimensions', accountingDimensionsRoutes, `/api/accounting-dimensions/${parent.data.id}`, { method: 'DELETE', entityId: sCorp.id });
    expect(blocked.status).toBe(409);
    expect((await call('/api/accounting-dimensions', accountingDimensionsRoutes, `/api/accounting-dimensions/${child.data.id}`, { method: 'DELETE', entityId: sCorp.id })).status).toBe(204);
    expect((await call('/api/accounting-dimensions', accountingDimensionsRoutes, `/api/accounting-dimensions/${child.data.id}`, { entityId: sCorp.id })).status).toBe(404);
  });

  it('pages with a cursor, scoped to the entity', async () => {
    for (const name of ['Alpha', 'Bravo', 'Charlie']) {
      await post('/api/accounting-dimensions', accountingDimensionsRoutes, llc.id, '', { dimension: 'location', name });
    }
    const first = JSON.parse((await call('/api/accounting-dimensions', accountingDimensionsRoutes, '/api/accounting-dimensions?dimension=location&limit=2', { entityId: llc.id })).text);
    expect(first.data.map((d: { name: string }) => d.name)).toEqual(['Alpha', 'Bravo']);
    expect(first.pagination).toMatchObject({ totalCount: 4, hasMore: true });
    const second = JSON.parse((await call('/api/accounting-dimensions', accountingDimensionsRoutes, `/api/accounting-dimensions?dimension=location&limit=2&cursor=${encodeURIComponent(first.pagination.cursor)}`, { entityId: llc.id })).text);
    expect(second.data.map((d: { name: string }) => d.name)).toEqual(['Charlie', 'Studio']);
    expect(second.pagination.hasMore).toBe(false);
    // the other entity doesn't see them
    const other = JSON.parse((await call('/api/accounting-dimensions', accountingDimensionsRoutes, '/api/accounting-dimensions?dimension=location', { entityId: sCorp.id })).text);
    expect(other.data.map((d: { name: string }) => d.name)).toEqual(['Berlin']);
    expect((await call('/api/accounting-dimensions', accountingDimensionsRoutes, '/api/accounting-dimensions?cursor=nope', { entityId: llc.id })).status).toBe(400);
  });

  it('a value on a booking can only be deactivated', async () => {
    const list = JSON.parse((await call('/api/accounting-dimensions', accountingDimensionsRoutes, '/api/accounting-dimensions?dimension=class', { entityId: llc.id })).text);
    const retail = list.data.find((d: { name: string }) => d.name === 'Retail');
    const res = await call('/api/accounting-dimensions', accountingDimensionsRoutes, `/api/accounting-dimensions/${retail.id}`, { method: 'DELETE', entityId: llc.id });
    expect(res.status).toBe(409);
    expect(res.error?.message).toMatch(/deactivate/);
  });

  it('refuses callers without the accounts permissions', async () => {
    for (const r of await authGateStatuses({ mount: '/api/accounting-dimensions', router: accountingDimensionsRoutes, prefix: 'accounts' })) {
      expect(r.status, r.label).toBe(403);
    }
  });
});

describe('a voided payment', () => {
  it('never happened on cash basis', async () => {
    const before = await report(sCorp.id, '/profit-loss?from=2026-07-01&to=2026-07-31&basis=cash');
    const invoiceC = (await db.select().from(schema.invoices).where(and(eq(schema.invoices.entityId, sCorp.id), eq(schema.invoices.status, 'sent'))))[0];
    const paid = await post('/api/payments', paymentsRoutes, sCorp.id, '', {
      type: 'received',
      amount: '100.00',
      date: '2026-07-29',
      contactId: 'pty_customer',
      allocations: [{ invoiceId: invoiceC.id, amount: '100.00' }],
    });
    expect(paid.status).toBe(201);
    const during = await report(sCorp.id, '/profit-loss?from=2026-07-01&to=2026-07-31&basis=cash');
    expect(Number(during.data.totalRevenue)).toBeCloseTo(Number(before.data.totalRevenue) + 100, 2);

    const voided = await call('/api/payments', paymentsRoutes, `/api/payments/${paid.data.id}`, { method: 'DELETE', entityId: sCorp.id });
    expect(voided.status).toBe(204);
    const after = await report(sCorp.id, '/profit-loss?from=2026-07-01&to=2026-07-31&basis=cash');
    expect(after.data.totalRevenue).toBe(before.data.totalRevenue);
    const bs = await report(sCorp.id, '/balance-sheet?asOf=2026-07-31&basis=cash');
    expect(bs.data).toMatchObject({ totalAssets: '1242.00', isBalanced: true });
  });
});

describe('rounding and payments across invoices', () => {
  let id: string;
  let acct: Record<string, string>;
  let invoiceId: string;

  beforeAll(async () => {
    const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
      method: 'POST',
      body: { name: 'Odd Cents Co', jurisdictionCode: 'US', entityType: 'sole_proprietorship', accountingMethod: 'cash' },
    });
    id = created.data.id;
    acct = await accountsByCode(id);
    await db.insert(schema.taxRates).values({
      id: 'txr_odd',
      entityId: id,
      jurisdictionCode: 'US',
      name: 'Sales tax 8.25%',
      rate: '8.2500',
      type: 'sales',
      taxCategoryCode: 'standard',
      isActive: true,
      ledgerAccountId: acct['2200'],
    });
    await registerSalesTax(id, acct, 'TX', 8.25);
  });

  const invoice = async (items: Array<{ unitPrice: string; accountId: string; taxRateId?: string; taxCode?: string }>) => {
    const res = await post('/api/invoices', invoicesRoutes, id, '', {
      contactId: 'pty_customer',
      issueDate: '2026-08-01',
      dueDate: '2026-09-01',
      billingAddress: texas,
      items: items.map((i, n) => ({ description: `Line ${n + 1}`, quantity: '1', ...i })),
    });
    expect(res.status).toBe(201);
    await post('/api/invoices', invoicesRoutes, id, `/${res.data.id}/finalize`);
    return res.data as { id: string; total: string };
  };
  const pay = (date: string, amount: string, allocations: Array<{ invoiceId: string; amount: string }>) =>
    post('/api/payments', paymentsRoutes, id, '', { type: 'received', amount, date, contactId: 'pty_customer', allocations });

  it('three installments recognise every line and the tax exactly, and the sheet balances after each one', async () => {
    const created = await invoice([
      { unitPrice: '33.33', accountId: acct['4010'], taxRateId: 'txr_odd' },
      { unitPrice: '33.33', accountId: acct['4020'], taxRateId: 'txr_odd' },
      { unitPrice: '33.34', accountId: acct['4030'], taxRateId: 'txr_odd' },
    ]);
    invoiceId = created.id;
    expect(created.total).toBe('108.25');

    expect((await pay('2026-08-02', '36.08', [{ invoiceId, amount: '36.08' }])).status).toBe(201);
    const afterFirst = await report(id, '/balance-sheet?asOf=2026-08-02&basis=cash');
    expect(afterFirst.data).toMatchObject({ totalAssets: '36.08', isBalanced: true });
    const firstPl = await report(id, '/profit-loss?from=2026-08-01&to=2026-08-02&basis=cash');
    expect(Number(firstPl.data.totalRevenue) + Number(balances(afterFirst.data.liabilities)['2200'])).toBeCloseTo(36.08, 2);

    expect((await pay('2026-08-03', '36.08', [{ invoiceId, amount: '36.08' }])).status).toBe(201);
    expect((await pay('2026-08-04', '36.09', [{ invoiceId, amount: '36.09' }])).status).toBe(201);

    const pl = await report(id, '/profit-loss?from=2026-08-01&to=2026-08-31&basis=cash');
    expect(balances(pl.data.revenue)).toEqual({ '4010': '33.33', '4020': '33.33', '4030': '33.34' });
    const bs = await report(id, '/balance-sheet?asOf=2026-08-31&basis=cash');
    expect(balances(bs.data.liabilities)).toEqual({ '2200': '8.25' });
    expect(bs.data).toMatchObject({ totalAssets: '108.25', isBalanced: true });
    // the accrual books agree once the invoice is paid in full
    const accrual = await report(id, '/profit-loss?from=2026-08-01&to=2026-08-31&basis=accrual');
    expect(accrual.data.totalRevenue).toBe(pl.data.totalRevenue);
  });

  it('one payment across two invoices recognises each share, and what is left over is unapplied', async () => {
    const x = await invoice([{ unitPrice: '100', accountId: acct['4020'], taxCode: 'non_taxable' }]);
    const y = await invoice([{ unitPrice: '150', accountId: acct['4020'], taxCode: 'non_taxable' }]);
    const paid = await pay('2026-08-10', '300.00', [
      { invoiceId: x.id, amount: '100.00' },
      { invoiceId: y.id, amount: '150.00' },
    ]);
    expect(paid.status).toBe(201);

    const pl = await report(id, '/profit-loss?from=2026-08-10&to=2026-08-10&basis=cash');
    expect(balances(pl.data.revenue)).toEqual({ '4020': '250.00', '4120': '50.00' });
    expect(pl.data.totalRevenue).toBe('300.00');
    const bs = await report(id, '/balance-sheet?asOf=2026-08-10&basis=cash');
    expect(bs.data).toMatchObject({ totalAssets: '408.25', isBalanced: true });
  });
});
