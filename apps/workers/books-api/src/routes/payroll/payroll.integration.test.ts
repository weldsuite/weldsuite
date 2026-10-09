/**
 * Payroll journal import on pglite: the CSV summary and general-ledger shapes
 * (balance checks, one entry per payroll, duplicates, reversal, saved
 * mapping) and the Gusto connection and sync against recorded fixtures.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { decryptField, keyringFromEnv } from '@weldsuite/db/lib/crypto';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { payrollRoutes } from './index';

let db: Database;
let entityId: string;
let accounts: Record<string, string>;
const sent: Array<{ eventType: string; data: Record<string, unknown> }> = [];
const env = {
  DATABASE_ENCRYPTION_KEY: 'cd'.repeat(32),
  ENTITY_EVENTS: { send: async (message: { eventType: string; data: Record<string, unknown> }) => void sent.push(message) },
};

interface Result {
  status: number;
  data: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  error?: { code: string; message: string; details?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  pagination?: { totalCount: number; hasMore: boolean };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; entityId?: string; perms?: string[] } = {}): Promise<Result> {
  const { request } = createTestApp(mount, routes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
    env,
  });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.entityId ? { 'X-Accounting-Entity-Id': opts.entityId } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = text ? (JSON.parse(text) as { data?: unknown; error?: Result['error']; pagination?: Result['pagination'] }) : {};
  return { status: res.status, data: ('data' in json ? json.data : {}) as Record<string, any>, error: json.error, pagination: json.pagination }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const payroll = (path: string, opts: Omit<Parameters<typeof call>[3], 'entityId'> = {}) =>
  call('/api/payroll', payrollRoutes, `/api/payroll${path}`, { ...opts, entityId });

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({ code: schema.accounts.code, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return rows.map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) })).sort((a, b) => a.code.localeCompare(b.code));
}

const SUMMARY_MAPPING = {
  shape: 'summary',
  columns: {
    payDate: 'Pay Date',
    grossWages: 'Gross Pay',
    employerTaxes: 'Employer Taxes',
    employeeTaxes: 'Employee Taxes',
    employeeDeductions: 'Deductions',
    employerBenefits: 'Employer Benefits',
    netPay: 'Net Pay',
  },
  accounts: {} as Record<string, string>,
};

const SUMMARY_CSV = [
  'Pay Date,Gross Pay,Employer Taxes,Employee Taxes,Deductions,Employer Benefits,Net Pay',
  '01/15/2026,"10,000.00",765.00,"2,100.00",400.00,300.00,"7,500.00"',
  '01/31/2026,"10,000.00",765.00,"2,100.00",400.00,300.00,"7,500.00"',
].join('\r\n');

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const res = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: {
      name: 'Payroll LLC',
      jurisdictionCode: 'US',
      entityType: 'single_member_llc',
      taxIdentifiers: { einOrSsn: '123456789' },
      address: { line1: '1 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701' },
    },
  });
  expect(res.status).toBe(201);
  entityId = res.data.id;
  const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  accounts = Object.fromEntries(rows.map((a) => [a.code, a.id]));
  SUMMARY_MAPPING.accounts = { net_pay: accounts['1000'] };
}, 120_000);

describe('CSV import, summary shape', () => {
  it('builds one balanced entry per payroll row from the account roles and the mapped bank account', async () => {
    const res = await payroll('/imports/csv', { method: 'POST', body: { csv: SUMMARY_CSV, mapping: SUMMARY_MAPPING, sourceFileName: 'payroll-jan.csv' } });
    expect(res.status).toBe(201);
    expect(res.data.imports).toHaveLength(2);
    const first = res.data.imports[0];
    expect(first.payDate).toBe('2026-01-15');
    expect(first.summary).toMatchObject({ gross_wages: 10000, employer_taxes: 765, employee_taxes: 2100, employee_deductions: 400, employer_benefits: 300, net_pay: 7500 });
    // Employer benefits go to the wages account when no benefits account is mapped; every liability to payroll liabilities.
    expect(await entryLines(first.journalEntryId)).toEqual([
      { code: '1000', debit: 0, credit: 7500 },
      { code: '2300', debit: 0, credit: 3565 },
      { code: '6175', debit: 765, credit: 0 },
      { code: '6200', debit: 10300, credit: 0 },
    ]);
    const [entry] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, first.journalEntryId));
    expect(entry).toMatchObject({ postingKey: `payroll:${first.importId}`, sourceType: 'payroll', sourceId: first.importId, status: 'posted' });
    expect(entry.date.toISOString().slice(0, 10)).toBe('2026-01-15');
    expect(sent.filter((m) => m.eventType === 'payroll_import:created')).toHaveLength(2);

    const list = await payroll('/imports');
    expect(list.status).toBe(200);
    expect(list.pagination?.totalCount).toBe(2);
    expect(list.data[0].payDate).toBe('2026-01-31');
    const detail = await payroll(`/imports/${first.importId}`);
    expect(detail.data).toMatchObject({ source: 'csv', status: 'posted', sourceFileName: 'payroll-jan.csv' });
    expect(detail.data.lines).toHaveLength(4);
  });

  it('importing the same file again posts nothing', async () => {
    const res = await payroll('/imports/csv', { method: 'POST', body: { csv: SUMMARY_CSV, mapping: SUMMARY_MAPPING } });
    expect(res.status).toBe(201);
    expect(res.data.imports).toEqual([]);
    expect(res.data.duplicates).toHaveLength(2);
    const entries = await db.select().from(schema.journalEntries).where(and(eq(schema.journalEntries.entityId, entityId), eq(schema.journalEntries.sourceType, 'payroll')));
    expect(entries).toHaveLength(2);
  });

  it('deleting an import reverses its entry, keeps the import as reversed, and frees nothing', async () => {
    const list = await payroll('/imports?status=posted');
    const target = list.data.find((row: { payDate: string }) => row.payDate === '2026-01-15') as { id: string; journalEntryId: string };
    const res = await payroll(`/imports/${target.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('reversed');

    const [original] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, target.journalEntryId));
    expect(original.status).toBe('reversed');
    const [reversal] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.reversalOfId, target.journalEntryId));
    expect(reversal).toBeTruthy();
    expect(await entryLines(reversal.id)).toEqual([
      { code: '1000', debit: 7500, credit: 0 },
      { code: '2300', debit: 3565, credit: 0 },
      { code: '6175', debit: 0, credit: 765 },
      { code: '6200', debit: 0, credit: 10300 },
    ]);
    expect(sent.some((m) => m.eventType === 'payroll_import:deleted')).toBe(true);

    expect((await payroll(`/imports/${target.id}`, { method: 'DELETE' })).status).toBe(400);
    // The reversed payroll is still "imported"; a batch label imports it again.
    const same = await payroll('/imports/csv', { method: 'POST', body: { csv: SUMMARY_CSV, mapping: SUMMARY_MAPPING } });
    expect(same.data.duplicates.map((d: { status: string }) => d.status).sort()).toEqual(['posted', 'reversed']);
    const again = await payroll('/imports/csv', { method: 'POST', body: { csv: SUMMARY_CSV, mapping: SUMMARY_MAPPING, batchLabel: 'redo' } });
    expect(again.data.imports).toHaveLength(2);
  });

  it('refuses a payroll that does not balance, listing the row', async () => {
    const csv = ['Pay Date,Gross Pay,Employer Taxes,Employee Taxes,Deductions,Employer Benefits,Net Pay', '02/15/2026,"10,000.00",765.00,"2,100.00",400.00,300.00,"7,000.00"'].join('\n');
    const res = await payroll('/imports/csv', { method: 'POST', body: { csv, mapping: SUMMARY_MAPPING } });
    expect(res.status).toBe(400);
    expect(res.error?.message).toMatch(/row 2/);
    expect(res.error?.message).toMatch(/does not balance/);
    expect(res.error?.details.problems).toHaveLength(1);

    const noBank = await payroll('/imports/csv', {
      method: 'POST',
      body: { csv: SUMMARY_CSV, mapping: { ...SUMMARY_MAPPING, accounts: {} }, batchLabel: 'x' },
    });
    expect(noBank.status).toBe(400);
    expect(noBank.error?.message).toMatch(/net_pay/);

    const wrongColumn = await payroll('/imports/csv', { method: 'POST', body: { csv: SUMMARY_CSV, mapping: { ...SUMMARY_MAPPING, columns: { ...SUMMARY_MAPPING.columns, netPay: 'Take Home' } } } });
    expect(wrongColumn.status).toBe(400);
    expect(wrongColumn.error?.message).toMatch(/Take Home/);
  });

  it('a dry run builds the entries and posts nothing; a saved mapping is used when none is sent', async () => {
    const before = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entityId, entityId));
    const csv = ['Pay Date,Gross Pay,Employer Taxes,Employee Taxes,Deductions,Employer Benefits,Net Pay', '03/13/2026,5000,382.50,1000,100,0,3900'].join('\n');
    const dry = await payroll('/imports/csv', { method: 'POST', body: { csv, mapping: SUMMARY_MAPPING, dryRun: true } });
    expect(dry.status).toBe(200);
    expect(dry.data.imports[0]).toMatchObject({ importId: null, journalEntryId: null, payDate: '2026-03-13', totalDebit: 5382.5 });
    expect(await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.entityId, entityId))).toHaveLength(before.length);

    expect((await payroll('/imports/csv', { method: 'POST', body: { csv } })).status).toBe(400);
    expect((await payroll('/csv-mapping')).data).toBeNull();
    const saved = await payroll('/csv-mapping', { method: 'PUT', body: SUMMARY_MAPPING });
    expect(saved.status).toBe(200);
    expect((await payroll('/csv-mapping')).data).toMatchObject({ shape: 'summary', columns: { payDate: 'Pay Date' }, accounts: { net_pay: accounts['1000'] } });
    const viaSaved = await payroll('/imports/csv', { method: 'POST', body: { csv } });
    expect(viaSaved.status).toBe(201);
    expect(viaSaved.data.imports).toHaveLength(1);
    // The saved mapping is a pseudo connection and stays out of the connection list.
    expect((await payroll('/connections')).data).toEqual([]);
  });

  it('is gated by the journal permissions', async () => {
    expect((await payroll('/imports', { perms: [] })).status).toBe(403);
    expect((await payroll('/imports/csv', { perms: ['journal:read'], method: 'POST', body: { csv: 'a' } })).status).toBe(403);
    expect((await payroll('/imports/some_id', { perms: ['journal:read', 'journal:create'], method: 'DELETE' })).status).toBe(403);
  });
});

describe('CSV import, general-ledger shape', () => {
  const GL_CSV = [
    'Date,Account,Debit,Credit,Memo',
    '2026-04-15,Wages and salaries,"8,000.00",,Gross wages',
    '2026-04-15,6175,612.00,,Employer taxes',
    '2026-04-15,Payroll liabilities,,"2,112.00",Taxes and withholdings',
    '2026-04-15,Checking,,"6,500.00",Net pay',
    '2026-04-30,Wages and salaries,"8,000.00",,Gross wages',
    '2026-04-30,Checking,,"8,000.00",Net pay',
  ].join('\n');
  const GL_MAPPING = { shape: 'gl', columns: { date: 'Date', account: 'Account', debit: 'Debit', credit: 'Credit', memo: 'Memo' }, accounts: {} };

  it('groups rows by date and matches accounts by name or code', async () => {
    const res = await payroll('/imports/csv', { method: 'POST', body: { csv: GL_CSV, mapping: GL_MAPPING } });
    expect(res.status).toBe(201);
    expect(res.data.imports.map((i: { payDate: string }) => i.payDate)).toEqual(['2026-04-15', '2026-04-30']);
    expect(await entryLines(res.data.imports[0].journalEntryId)).toEqual([
      { code: '1000', debit: 0, credit: 6500 },
      { code: '2300', debit: 0, credit: 2112 },
      { code: '6175', debit: 612, credit: 0 },
      { code: '6200', debit: 8000, credit: 0 },
    ]);
  });

  it('refuses an unbalanced date and an account it cannot match', async () => {
    const unbalanced = await payroll('/imports/csv', {
      method: 'POST',
      body: { csv: ['Date,Account,Debit,Credit', '2026-05-15,6200,100,', '2026-05-15,1000,,90'].join('\n'), mapping: GL_MAPPING },
    });
    expect(unbalanced.status).toBe(400);
    expect(unbalanced.error?.message).toMatch(/2026-05-15: The payroll does not balance/);

    const unknown = await payroll('/imports/csv', {
      method: 'POST',
      body: { csv: ['Date,Account,Debit,Credit', '2026-05-15,Mystery account,100,', '2026-05-15,1000,,100'].join('\n'), mapping: GL_MAPPING },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.error?.message).toMatch(/Mystery account/);

    const mapped = await payroll('/imports/csv', {
      method: 'POST',
      body: { csv: ['Date,Account,Debit,Credit', '2026-05-15,Mystery account,100,', '2026-05-15,1000,,100'].join('\n'), mapping: { ...GL_MAPPING, accounts: { 'Mystery account': accounts['6200'] } } },
    });
    expect(mapped.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Gusto (recorded fixtures; the real API is not called)

const COMPANY = { uuid: 'company-1', name: 'Payroll LLC', trade_name: 'Payroll' };

function gustoTotals(overrides: Record<string, string> = {}) {
  return {
    company_debit: '11000.00',
    net_pay_debit: '7500.00',
    tax_debit: '3565.00',
    reimbursement_debit: '0.00',
    child_support_debit: '0.00',
    reimbursements: '0.00',
    net_pay: '7500.00',
    gross_pay: '10000.00',
    employee_bonuses: '0.00',
    employee_commissions: '0.00',
    employee_cash_tips: '0.00',
    employee_paycheck_tips: '0.00',
    additional_earnings: '0.00',
    owners_draw: '0.00',
    check_amount: '0.00',
    employer_taxes: '765.00',
    employee_taxes: '2100.00',
    benefits: '300.00',
    employee_benefits_deductions: '250.00',
    deferred_payroll_taxes: '0.00',
    other_deductions: '150.00',
    ...overrides,
  };
}

const PAYROLLS = [
  { payroll_uuid: 'pay-1', processed: true, check_date: '2026-02-13', off_cycle: false, pay_period: { start_date: '2026-02-01', end_date: '2026-02-15' }, totals: gustoTotals() },
  { payroll_uuid: 'pay-2', processed: true, check_date: '2026-02-27', off_cycle: false, pay_period: { start_date: '2026-02-16', end_date: '2026-02-28' }, totals: gustoTotals({ gross_pay: '12000.00', net_pay: '9100.00', employee_taxes: '2500.00', employer_taxes: '918.00', benefits: '0.00', employee_benefits_deductions: '250.00', other_deductions: '150.00' }) },
  { payroll_uuid: 'pay-3', processed: false, check_date: '2026-03-13', pay_period: { start_date: '2026-03-01', end_date: '2026-03-15' }, totals: gustoTotals() },
  { payroll_uuid: 'pay-4', processed: true, check_date: '2026-03-13', pay_period: { start_date: '2026-03-01', end_date: '2026-03-15' }, totals: gustoTotals({ net_pay: '7000.00' }) },
];

interface FetchCall {
  url: URL;
  headers: Record<string, string>;
}

function stubGusto(options: { companyStatus?: number; payrolls?: unknown[] } = {}) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      if (/^\/v1\/companies\/[^/]+$/.test(url.pathname)) {
        if (options.companyStatus && options.companyStatus !== 200) return new Response('{"errors":[]}', { status: options.companyStatus });
        return Response.json(COMPANY);
      }
      if (url.pathname.endsWith('/payrolls')) return Response.json(options.payrolls ?? PAYROLLS);
      return new Response('not found', { status: 404 });
    }),
  );
  return calls;
}

describe('Gusto', () => {
  let connectionId: string;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checks the token against the company, stores it encrypted and never returns it', async () => {
    const calls = stubGusto();
    const res = await payroll('/connections', {
      method: 'POST',
      body: { provider: 'gusto', accessToken: 'gusto-secret-token-123', companyId: 'company-1', environment: 'demo' },
    });
    expect(res.status).toBe(201);
    connectionId = res.data.id;
    expect(res.data).toMatchObject({ provider: 'gusto', providerCompanyId: 'company-1', status: 'active', hasCredentials: true, environment: 'demo' });
    expect(JSON.stringify(res.data)).not.toContain('gusto-secret-token-123');
    expect(res.data).not.toHaveProperty('credentialsEncrypted');

    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin).toBe('https://api.gusto-demo.com');
    expect(calls[0].url.pathname).toBe('/v1/companies/company-1');
    expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer gusto-secret-token-123', 'X-Gusto-API-Version': '2024-04-01' });

    const [row] = await db.select().from(schema.payrollConnections).where(eq(schema.payrollConnections.id, connectionId));
    expect(row.credentialsEncrypted).not.toContain('gusto-secret-token-123');
    expect(JSON.parse(await decryptField(row.credentialsEncrypted!, keyringFromEnv(env)))).toEqual({ accessToken: 'gusto-secret-token-123', environment: 'demo' });
    expect(sent.some((m) => m.eventType === 'payroll_connection:created' && JSON.stringify(m.data).includes('secret'))).toBe(false);

    const list = await payroll('/connections');
    expect(list.data).toHaveLength(1);
    expect(JSON.stringify(list.data)).not.toContain('credentialsEncrypted');
    expect((await payroll('/connections', { method: 'POST', body: { provider: 'gusto', accessToken: 'gusto-secret-token-123', companyId: 'company-1' } })).status).toBe(400);
  });

  it('refuses a token Gusto rejects', async () => {
    stubGusto({ companyStatus: 401 });
    const res = await payroll('/connections', { method: 'POST', body: { provider: 'gusto', accessToken: 'expired-token-xyz', companyId: 'company-9' } });
    expect(res.status).toBe(400);
    expect(res.error?.message).toMatch(/rejected the access token/);
    expect((await payroll('/connections')).data).toHaveLength(1);
  });

  it('needs the net pay account mapped before it syncs', async () => {
    stubGusto();
    const res = await payroll(`/connections/${connectionId}/sync`, { method: 'POST', body: {} });
    expect(res.status).toBe(400);
    expect(res.error?.message).toMatch(/net pay/);

    const bad = await payroll(`/connections/${connectionId}/mapping`, { method: 'PUT', body: { accountMapping: { net_pay: 'acc_elsewhere' } } });
    expect(bad.status).toBe(400);
    const unknown = await payroll(`/connections/${connectionId}/mapping`, { method: 'PUT', body: { accountMapping: { bonus: accounts['1000'] } } });
    expect(unknown.status).toBe(400);
    const ok = await payroll(`/connections/${connectionId}/mapping`, { method: 'PUT', body: { accountMapping: { net_pay: accounts['1000'] } } });
    expect(ok.status).toBe(200);
  });

  it('imports the processed payrolls it has not seen: one already imported, one unprocessed, one that does not balance', async () => {
    // pay-1 came in earlier (an earlier sync, say).
    await db.insert(schema.payrollImports).values({ id: 'pri_earlier', entityId, source: 'gusto', externalId: 'pay-1', payDate: '2026-02-13', status: 'posted', connectionId });
    const calls = stubGusto();
    const res = await payroll(`/connections/${connectionId}/sync`, { method: 'POST', body: { from: '2026-02-01', to: '2026-03-31' } });
    expect(res.status).toBe(200);
    expect(res.data.fetched).toBe(4);
    expect(res.data.imported.map((i: { externalId: string }) => i.externalId)).toEqual(['pay-2']);
    expect(res.data.skipped.map((s: { externalId: string; reason: string }) => [s.externalId, s.reason])).toEqual([
      ['pay-1', 'Already imported'],
      ['pay-3', 'The payroll is not processed yet'],
    ]);
    expect(res.data.failed).toHaveLength(1);
    expect(res.data.failed[0]).toMatchObject({ externalId: 'pay-4' });
    expect(res.data.failed[0].error).toMatch(/does not balance/);

    const request = calls.find((c) => c.url.pathname.endsWith('/payrolls'))!;
    expect(request.url.searchParams.get('include')).toBe('totals');
    expect(request.url.searchParams.get('start_date')).toBe('2026-02-01');
    expect(request.url.searchParams.get('end_date')).toBe('2026-03-31');
    expect(request.url.searchParams.get('processing_statuses')).toBe('processed');
    expect(request.headers['X-Gusto-API-Version']).toBe('2024-04-01');

    // pay-2: gross 12,000 = net 9,100 + taxes 2,500 + deductions 400. Employer taxes 918.
    const imported = res.data.imported[0];
    expect(await entryLines(imported.journalEntryId)).toEqual([
      { code: '1000', debit: 0, credit: 9100 },
      { code: '2300', debit: 0, credit: 3818 },
      { code: '6175', debit: 918, credit: 0 },
      { code: '6200', debit: 12000, credit: 0 },
    ]);
    const [row] = await db.select().from(schema.payrollImports).where(eq(schema.payrollImports.id, imported.importId));
    expect(row).toMatchObject({ source: 'gusto', externalId: 'pay-2', payDate: '2026-02-27', periodStart: '2026-02-16', periodEnd: '2026-02-28', connectionId, status: 'posted' });
    expect(row.summary).toMatchObject({ gross_wages: 12000, net_pay: 9100 });

    const [connection] = await db.select().from(schema.payrollConnections).where(eq(schema.payrollConnections.id, connectionId));
    expect(connection.lastSyncedAt).toBeTruthy();
    expect(connection.lastError).toMatch(/1 payroll/);
  });

  it('a second sync finds everything already imported', async () => {
    stubGusto();
    const res = await payroll(`/connections/${connectionId}/sync`, { method: 'POST', body: { from: '2026-02-01', to: '2026-03-31' } });
    expect(res.data.imported).toEqual([]);
    expect(res.data.skipped.filter((s: { reason: string }) => s.reason === 'Already imported')).toHaveLength(2);
    const imports = await db.select().from(schema.payrollImports).where(eq(schema.payrollImports.source, 'gusto'));
    expect(imports).toHaveLength(2);
  });

  it('answers a Gusto outage with a 502 and keeps the error on the connection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream down', { status: 503 })));
    const res = await payroll(`/connections/${connectionId}/sync`, { method: 'POST', body: { from: '2026-02-01', to: '2026-02-28' } });
    expect(res.status).toBe(502);
    const [connection] = await db.select().from(schema.payrollConnections).where(eq(schema.payrollConnections.id, connectionId));
    expect(connection).toMatchObject({ status: 'error' });
    expect(connection.lastError).toMatch(/503/);
  });

  it('disconnecting wipes the token and keeps the imported payrolls', async () => {
    const res = await payroll(`/connections/${connectionId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [connection] = await db.select().from(schema.payrollConnections).where(eq(schema.payrollConnections.id, connectionId));
    expect(connection).toMatchObject({ status: 'disconnected', credentialsEncrypted: null });
    expect((await payroll('/connections')).data).toEqual([]);
    expect(await db.select().from(schema.payrollImports).where(eq(schema.payrollImports.source, 'gusto'))).toHaveLength(2);
    expect((await payroll(`/connections/${connectionId}/sync`, { method: 'POST', body: {} })).status).toBe(404);
  });
});
