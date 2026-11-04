/**
 * POST /api/accounting-settings/posting-catch-up (pglite, a Dutch entity):
 * every step of the catch-up on legacy data, as a dry run, for real and a
 * second time. Tax-ledger rows for a posted invoice and a manual entry (and
 * its reversal), a credit note posted with the invoice's sign corrected, an
 * unposted invoice and bill booked keeping their status, an unposted payment
 * posted with its allocation, a matched bank line turned into a payment; and
 * what is skipped: a closed period, a line account of another entity, an
 * unknown bank account, a matched document with nothing open. Also the
 * refusals: no entity, a bad body, permissions.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../accounting-entities';
import { accountingSettingsRoutes } from './index';

let db: Database;
let entityId: string;
const acc: Record<string, string> = {};
let hoog: string;
let voorbelasting: string;

async function call(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routes: Hono<any>,
  mount: string,
  path: string,
  opts: { method?: string; body?: unknown; perms?: string[]; entity?: boolean } = {},
) {
  const { request } = createTestApp(mount, routes, {
    context: { permissions: permissions(...(opts.perms ?? ['*'])), tenantDb: db },
  });
  const res = await request(`${mount}${path}`, {
    method: opts.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.entity === false || !entityId ? {} : { 'X-Accounting-Entity-Id': entityId }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json()) as { data?: any; error?: { message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, ...json };
}

const catchUp = (body: unknown, opts: { perms?: string[]; entity?: boolean } = {}) =>
  call(accountingSettingsRoutes, '/api/accounting-settings', '/posting-catch-up', { body, ...opts });

const at = (day: string) => new Date(`${day}T00:00:00.000Z`);
const breakdown = (rateId: string, name: string, taxable: number, tax: number) => [
  { taxRateId: rateId, taxRateName: name, taxRate: 21, taxableAmount: taxable, taxAmount: tax },
];

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const created = await call(accountingEntitiesRoutes, '/api/accounting-entities', '', {
    body: { name: 'Inhaal BV', jurisdictionCode: 'NL', address: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' } },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id;
  for (const a of await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId))) acc[a.code] = a.id;
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  hoog = rates.find((r) => r.name === 'BTW Hoog 21%')!.id;
  voorbelasting = rates.find((r) => r.name === 'BTW Voorbelasting 21%')!.id;

  await db.insert(schema.parties).values([
    { id: 'pty_cu_c', displayName: 'Klant BV', role: 'customer' },
    { id: 'pty_cu_s', displayName: 'Leverancier BV', role: 'supplier' },
  ]);
  await db.insert(schema.bankAccounts).values({ id: 'ba_cu', entityId, name: 'Hoofdrekening', ledgerAccountId: acc['1100'], isDefault: true });
  await db.insert(schema.fiscalPeriods).values({
    id: 'fp_cu_closed', entityId, name: 'Januari 2025', type: 'month', startDate: '2025-01-01', endDate: '2025-01-31', status: 'closed',
  });

  const invoice = (id: string, values: Partial<typeof schema.invoices.$inferInsert>) => ({
    id, entityId, contactId: 'pty_cu_c', contactName: 'Klant BV', type: 'standard', currency: 'EUR', dueDate: at('2099-12-31'), ...values,
  }) as typeof schema.invoices.$inferInsert;
  await db.insert(schema.invoices).values([
    // Posted by the old finalize: an entry with a key, but no tax-ledger rows.
    invoice('inv_cu_tax', {
      invoiceNumber: 'INV-T1', status: 'finalized', issueDate: at('2026-03-01'), journalEntryId: 'je_cu_inv',
      subtotal: '100.00', taxTotal: '21.00', total: '121.00', balanceDue: '121.00', taxBreakdown: breakdown(hoog, 'BTW Hoog 21%', 100, 21),
    }),
    // A credit note the old code posted like an invoice: receivable debited.
    invoice('inv_cu_cn', {
      invoiceNumber: 'CN-1', type: 'credit_note', status: 'finalized', issueDate: at('2026-03-05'), journalEntryId: 'je_cu_cn',
      subtotal: '50.00', taxTotal: '10.50', total: '60.50', balanceDue: '60.50', taxBreakdown: breakdown(hoog, 'BTW Hoog 21%', 50, 10.5),
    }),
    // Sent without being finalized: booked, keeping its status, then paid from the bank line.
    invoice('inv_cu_sent', {
      invoiceNumber: 'INV-S1', status: 'sent', issueDate: at('2026-03-15'),
      subtotal: '200.00', taxTotal: '42.00', total: '242.00', balanceDue: '242.00', taxBreakdown: breakdown(hoog, 'BTW Hoog 21%', 200, 42),
    }),
    // Paid in a closed period: skipped.
    invoice('inv_cu_locked', {
      invoiceNumber: 'INV-L1', status: 'paid', issueDate: at('2025-01-15'),
      subtotal: '10.00', taxTotal: '2.10', total: '12.10', balanceDue: '0.00', taxBreakdown: breakdown(hoog, 'BTW Hoog 21%', 10, 2.1),
    }),
  ]);
  const item = (id: string, invoiceId: string, lineTotal: string) => ({
    id, entityId, invoiceId, description: 'Advies', quantity: '1', unitPrice: lineTotal, lineTotal, taxRateId: hoog,
  });
  await db.insert(schema.invoiceItems).values([
    item('ii_cu_1', 'inv_cu_tax', '100.00'),
    item('ii_cu_2', 'inv_cu_cn', '50.00'),
    item('ii_cu_3', 'inv_cu_sent', '200.00'),
    item('ii_cu_4', 'inv_cu_locked', '10.00'),
  ]);

  const bill = (id: string, values: Partial<typeof schema.bills.$inferInsert>) => ({
    id, entityId, contactId: 'pty_cu_s', contactName: 'Leverancier BV', currency: 'EUR', issueDate: at('2026-03-16'), dueDate: at('2026-04-16'), ...values,
  }) as typeof schema.bills.$inferInsert;
  await db.insert(schema.bills).values([
    bill('bill_cu_ok', {
      billNumber: 'B-1', status: 'approved', subtotal: '100.00', taxTotal: '21.00', total: '121.00', balanceDue: '121.00',
      taxBreakdown: breakdown(voorbelasting, 'BTW Voorbelasting 21%', 100, 21),
    }),
    // A line account of another entity: skipped.
    bill('bill_cu_bad', { billNumber: 'B-2', status: 'approved', subtotal: '10.00', total: '10.00', balanceDue: '10.00' }),
    // Already paid in full (and booked): a bank line matched to it has nothing to settle.
    bill('bill_cu_zero', { billNumber: 'B-3', status: 'paid', total: '5.00', balanceDue: '0.00', journalEntryId: 'je_cu_elsewhere' }),
  ]);
  await db.insert(schema.billItems).values([
    { id: 'bi_cu_1', entityId, billId: 'bill_cu_ok', description: 'Kantoor', quantity: '1', unitPrice: '100', lineTotal: '100.00', taxRateId: voorbelasting },
    { id: 'bi_cu_2', entityId, billId: 'bill_cu_bad', description: 'Vreemd', quantity: '1', unitPrice: '10', lineTotal: '10.00', accountId: 'acc_other_entity' },
  ]);

  await db.insert(schema.journalEntries).values([
    { id: 'je_cu_inv', entityId, entryNumber: 'JE-OLD-1', date: at('2026-03-01'), status: 'posted', postingKey: 'invoice:inv_cu_tax:issue', sourceType: 'invoice', sourceId: 'inv_cu_tax', totalDebit: '121.00', totalCredit: '121.00' },
    { id: 'je_cu_cn', entityId, entryNumber: 'JE-OLD-2', date: at('2026-03-05'), status: 'posted', sourceType: 'credit_note', sourceId: 'inv_cu_cn', totalDebit: '60.50', totalCredit: '60.50' },
    { id: 'je_cu_man', entityId, entryNumber: 'JE-OLD-3', date: at('2026-03-10'), status: 'reversed', sourceType: 'manual', totalDebit: '121.00', totalCredit: '121.00' },
    { id: 'je_cu_man_rev', entityId, entryNumber: 'JE-OLD-4', date: at('2026-03-12'), status: 'posted', reversalOfId: 'je_cu_man', totalDebit: '121.00', totalCredit: '121.00' },
  ]);
  const jl = (id: string, journalEntryId: string, code: string, debit: string, credit: string, extra: Record<string, unknown> = {}) => ({
    id, entityId, journalEntryId, accountId: acc[code], debit, credit, currency: 'EUR', ...extra,
  });
  await db.insert(schema.journalLines).values([
    jl('jl_cu_1', 'je_cu_inv', '1300', '121.00', '0'),
    jl('jl_cu_2', 'je_cu_inv', '8000', '0', '100.00'),
    jl('jl_cu_3', 'je_cu_inv', '1700', '0', '21.00'),
    jl('jl_cu_4', 'je_cu_cn', '1300', '60.50', '0'),
    jl('jl_cu_5', 'je_cu_cn', '8000', '0', '50.00'),
    jl('jl_cu_6', 'je_cu_cn', '1700', '0', '10.50'),
    jl('jl_cu_7', 'je_cu_man', '1100', '121.00', '0'),
    jl('jl_cu_8', 'je_cu_man', '8000', '0', '100.00', { taxRateId: hoog, taxAmount: '21.00', contactId: 'pty_cu_c' }),
    jl('jl_cu_9', 'je_cu_man', '1700', '0', '21.00'),
    jl('jl_cu_10', 'je_cu_man_rev', '1100', '0', '121.00'),
    jl('jl_cu_11', 'je_cu_man_rev', '8000', '100.00', '0', { taxRateId: hoog, taxAmount: '21.00' }),
    jl('jl_cu_12', 'je_cu_man_rev', '1700', '21.00', '0'),
  ]);

  await db.insert(schema.payments).values([
    // Recorded before payments were posted: settles part of the posted invoice.
    { id: 'pay_cu_old', entityId, type: 'received', amount: '50.00', currency: 'EUR', exchangeRate: '1', date: at('2026-03-20'), contactId: 'pty_cu_c', invoiceId: 'inv_cu_tax', reference: 'OLD-1', paymentMethod: 'bank_transfer' },
    // A bank account that doesn't exist: skipped.
    { id: 'pay_cu_bad', entityId, type: 'sent', amount: '10.00', currency: 'EUR', date: at('2026-03-21'), contactId: 'pty_cu_s', bankAccountId: 'ba_missing', reference: 'BAD-1' },
  ]);
  await db.insert(schema.bankTransactions).values([
    { id: 'btx_cu_match', entityId, bankAccountId: 'ba_cu', date: at('2026-03-25'), amount: '242.00', description: 'Klant BV INV-S1', reference: 'BANK-1', status: 'reconciled', reconciledInvoiceId: 'inv_cu_sent' },
    { id: 'btx_cu_none', entityId, bankAccountId: 'ba_cu', date: at('2026-03-26'), amount: '-5.00', description: 'Leverancier', status: 'reconciled', reconciledBillId: 'bill_cu_zero' },
  ]);
}, 60_000);

const skippedIds = (data: { skipped: Array<{ id: string }> }) => data.skipped.map((s) => s.id).sort();

describe('POST /api/accounting-settings/posting-catch-up', () => {
  it('previews by default without writing anything', async () => {
    const preview = await catchUp({});
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({ dryRun: true, invoices: 1, creditNotesCorrected: 1, bills: 1, payments: 1, bankTransactions: 1, taxLines: 3 });
    expect(skippedIds(preview.data)).toEqual(['bill_cu_bad', 'btx_cu_none', 'inv_cu_locked', 'pay_cu_bad']);
    const locked = preview.data.skipped.find((s: { id: string }) => s.id === 'inv_cu_locked');
    expect(locked).toMatchObject({ type: 'invoice', number: 'INV-L1' });
    expect(await db.select().from(schema.taxLines)).toHaveLength(0);
    const [sent] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, 'inv_cu_sent'));
    expect(sent.journalEntryId).toBeNull();
  });

  it('books everything that can be booked', async () => {
    const run = await catchUp({ dryRun: false });
    expect(run.status).toBe(200);
    expect(run.data).toMatchObject({ dryRun: false, invoices: 1, creditNotesCorrected: 1, bills: 1, payments: 1, bankTransactions: 1, taxLines: 3 });
    expect(skippedIds(run.data)).toEqual(['bill_cu_bad', 'btx_cu_none', 'inv_cu_locked', 'pay_cu_bad']);

    const manual = await db.select().from(schema.taxLines).where(eq(schema.taxLines.sourceId, 'je_cu_man'));
    expect(manual.map((r) => r.taxAmount).sort()).toEqual(['-21.00', '21.00']);

    const [cn] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, 'inv_cu_cn'));
    expect(cn.journalEntryId).not.toBe('je_cu_cn');
    const [old] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, 'je_cu_cn'));
    expect(old.status).toBe('reversed');

    const [sent] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, 'inv_cu_sent'));
    expect(sent).toMatchObject({ status: 'paid', balanceDue: '0.00' });
    const [line] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'btx_cu_match'));
    expect(line.reconciledPaymentId).toMatch(/^pay_/);

    const [bill] = await db.select().from(schema.bills).where(eq(schema.bills.id, 'bill_cu_ok'));
    expect(bill.status).toBe('approved');
    expect(bill.journalEntryId).toMatch(/^je_/);

    const allocations = await db.select().from(schema.paymentAllocations).where(eq(schema.paymentAllocations.paymentId, 'pay_cu_old'));
    expect(allocations).toHaveLength(1);
    const audit = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.action, 'posting_catch_up'), eq(schema.auditLog.entityId, entityId)));
    expect(audit).toHaveLength(1);
  });

  it('finds nothing left the second time', async () => {
    const again = await catchUp({ dryRun: true });
    expect(again.data).toMatchObject({ invoices: 0, creditNotesCorrected: 0, bills: 0, payments: 0, bankTransactions: 0, taxLines: 0 });
    expect(skippedIds(again.data)).toEqual(['bill_cu_bad', 'btx_cu_none', 'inv_cu_locked', 'pay_cu_bad']);
  });

  it('refuses a bad body, no entity and missing permissions', async () => {
    expect((await catchUp({ dryRun: 'yes' })).status).toBe(400);
    expect((await catchUp({ dryRun: null })).status).toBe(400);
    const noEntity = await catchUp({}, { entity: false });
    expect(noEntity.status).toBe(400);
    expect(noEntity.error?.message).toBe('No accounting entity resolved');
    expect((await catchUp({}, { perms: ['accounts:read'] })).status).toBe(403);
  });
});
