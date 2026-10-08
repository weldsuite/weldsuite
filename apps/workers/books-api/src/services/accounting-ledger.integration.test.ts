/**
 * End-to-end ledger behaviour on a Dutch entity (pglite): every document
 * posts once, atomically, with its tax-ledger rows; payments settle and void
 * cleanly; credit notes mirror invoices; the VAT return reads the tax ledger;
 * lock dates hold; recurring generation can't double-bill; the daily sweep
 * marks overdue invoices; the catch-up books legacy documents.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../routes/accounting-entities';
import { invoicesRoutes } from '../routes/invoices';
import { billsRoutes } from '../routes/bills';
import { vatReturnsRoutes } from '../routes/vat-returns';
import { journalEntriesRoutes } from '../routes/journal-entries';
import { recurringInvoicesRoutes } from '../routes/recurring-invoices';
import { accountingSettingsRoutes } from '../routes/accounting-settings';
import { paymentsRoutes } from '../routes/payments';
import { bankTransactionsRoutes } from '../routes/bank-transactions';
import { generateRecurringInvoice, RecurringAlreadyGeneratedError } from './accounting-recurring';
import { postJournalEntry, PostingError } from './accounting-posting';
import { sweepTenant } from '../cron/books-sweep';

let db: Database;
let entityId: string;
const accountId: Record<string, string> = {};
const rateId: Record<string, string> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, method = 'GET', body?: unknown) {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const res = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(entityId ? { 'X-Accounting-Entity-Id': entityId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = res.status === 204 ? null : ((await res.json()) as { data?: Record<string, unknown>; error?: { message: string } });
  return { status: res.status, data: json?.data as Record<string, unknown>, error: json?.error };
}

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({ code: schema.accounts.code, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return rows
    .map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit) }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.debit - b.debit);
}

async function balanceOf(code: string) {
  const [row] = await db.select({ balance: schema.accounts.currentBalance }).from(schema.accounts)
    .where(eq(schema.accounts.id, accountId[code])).limit(1);
  return Number(row?.balance ?? 0);
}

async function createInvoice(issueDate: string, unitPrice = '100', dueDate = '2099-12-31') {
  const res = await call('/api/invoices', invoicesRoutes, '/api/invoices', 'POST', {
    contactId: 'pty_customer',
    issueDate,
    dueDate,
    items: [{ description: 'Consulting', quantity: '1', unitPrice, taxRateId: rateId.hoog }],
  });
  expect(res.status).toBe(201);
  return res.data.id as string;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name: 'Ledger BV',
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id as string;

  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  for (const a of accounts) accountId[a.code] = a.id;
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  const byName = (name: string) => rates.find((r) => r.name === name)!.id;
  rateId.hoog = byName('BTW Hoog 21%');
  rateId.voorbelasting = byName('BTW Voorbelasting 21%');
  rateId.inkoopEu = byName('BTW Inkoop EU');

  await db.insert(schema.parties).values([
    { id: 'pty_customer', displayName: 'Klant BV', role: 'customer', billingAddress: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 AB', country: 'NL' } },
    { id: 'pty_supplier', displayName: 'Leverancier BV', role: 'supplier' },
  ]);
}, 60_000);

describe('ledger foundations', () => {
  let invoiceId: string;
  let paymentId: string;

  it('finalizing an invoice posts receivable, revenue and VAT once, with tax-ledger rows', async () => {
    invoiceId = await createInvoice('2026-07-10');
    const res = await call('/api/invoices', invoicesRoutes, `/api/invoices/${invoiceId}/finalize`, 'POST');
    expect(res.status).toBe(200);
    const journalEntryId = res.data.journalEntryId as string;

    expect(await entryLines(journalEntryId)).toEqual([
      { code: '1300', debit: 121, credit: 0 },
      { code: '1700', debit: 0, credit: 21 },
      { code: '8000', debit: 0, credit: 100 },
    ]);
    const [entry] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, journalEntryId));
    expect(entry.postingKey).toBe(`invoice:${invoiceId}:issue`);

    const taxRows = await db.select().from(schema.taxLines).where(eq(schema.taxLines.journalEntryId, journalEntryId));
    expect(taxRows).toHaveLength(1);
    expect(taxRows[0]).toMatchObject({ direction: 'sales', taxableAmount: '100.00', taxAmount: '21.00', taxDate: '2026-07-10' });

    const again = await call('/api/invoices', invoicesRoutes, `/api/invoices/${invoiceId}/finalize`, 'POST');
    expect(again.status).toBe(400);
    const entries = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.sourceId, invoiceId));
    expect(entries).toHaveLength(1);
  });

  it('approving a bill posts expense, deductible input VAT and the payable', async () => {
    const created = await call('/api/bills', billsRoutes, '/api/bills', 'POST', {
      contactId: 'pty_supplier',
      issueDate: '2026-07-11',
      dueDate: '2026-08-11',
      items: [{ description: 'Office supplies', quantity: '1', unitPrice: '100', taxRateId: rateId.voorbelasting, accountId: accountId['4310'] }],
    });
    expect(created.status).toBe(201);
    expect(created.data.total).toBe('121.00');

    const approved = await call('/api/bills', billsRoutes, `/api/bills/${created.data.id}/approve`, 'PATCH');
    expect(approved.status).toBe(200);
    expect(await entryLines(approved.data.journalEntryId as string)).toEqual([
      { code: '1600', debit: 0, credit: 121 },
      { code: '1730', debit: 21, credit: 0 },
      { code: '4310', debit: 100, credit: 0 },
    ]);
  });

  it('an EU acquisition is self-assessed: VAT stays out of the bill total and nets in the ledger', async () => {
    const created = await call('/api/bills', billsRoutes, '/api/bills', 'POST', {
      contactId: 'pty_supplier',
      issueDate: '2026-07-12',
      dueDate: '2026-08-12',
      items: [{ description: 'SaaS licence', quantity: '1', unitPrice: '100', taxRateId: rateId.inkoopEu, accountId: accountId['4340'] }],
    });
    expect(created.status).toBe(201);
    expect(created.data.total).toBe('100.00');

    const approved = await call('/api/bills', billsRoutes, `/api/bills/${created.data.id}/approve`, 'PATCH');
    expect(approved.status).toBe(200);
    expect(await entryLines(approved.data.journalEntryId as string)).toEqual([
      { code: '1600', debit: 0, credit: 100 },
      { code: '1700', debit: 0, credit: 21 },
      { code: '1730', debit: 21, credit: 0 },
      { code: '4340', debit: 100, credit: 0 },
    ]);
  });

  it('the VAT return is calculated from the tax ledger, invoice tax included', async () => {
    const res = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', {
      periodType: 'quarterly',
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
    });
    expect(res.status).toBe(201);
    expect(res.data.rubrieken).toMatchObject({ r1a: 100, r1b: 21, r4b: 100, r5a: 21, r5b: 21, r5c: 0 });
  });

  it('recording a payment posts it and settles the invoice; voiding reverses both', async () => {
    const paid = await call('/api/invoices', invoicesRoutes, `/api/invoices/${invoiceId}/record-payment`, 'POST', {
      amount: '121.00',
      date: '2026-07-20',
      paymentMethod: 'bank_transfer',
    });
    expect(paid.status).toBe(201);
    expect(paid.data.status).toBe('paid');
    paymentId = paid.data.paymentId as string;
    expect(await entryLines(paid.data.journalEntryId as string)).toEqual([
      { code: '1100', debit: 121, credit: 0 },
      { code: '1300', debit: 0, credit: 121 },
    ]);
    const allocations = await db.select().from(schema.paymentAllocations).where(eq(schema.paymentAllocations.paymentId, paymentId));
    expect(allocations).toHaveLength(1);
    expect(await balanceOf('1300')).toBe(0);

    const voided = await call('/api/payments', paymentsRoutes, `/api/payments/${paymentId}`, 'DELETE');
    expect(voided.status).toBe(204);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    expect(invoice).toMatchObject({ status: 'sent', amountPaid: '0.00', balanceDue: '121.00' });
    expect(await balanceOf('1300')).toBe(121);
    expect(await balanceOf('1100')).toBe(0);
  });

  it('a credit note posts the invoice mirrored, with negative tax-ledger rows', async () => {
    const created = await call('/api/invoices', invoicesRoutes, `/api/invoices/${invoiceId}/credit-note`, 'POST');
    expect(created.status).toBe(201);
    const finalized = await call('/api/invoices', invoicesRoutes, `/api/invoices/${created.data.id}/finalize`, 'POST');
    expect(finalized.status).toBe(200);
    const journalEntryId = finalized.data.journalEntryId as string;
    expect(await entryLines(journalEntryId)).toEqual([
      { code: '1300', debit: 0, credit: 121 },
      { code: '1700', debit: 21, credit: 0 },
      { code: '8000', debit: 100, credit: 0 },
    ]);
    const taxRows = await db.select().from(schema.taxLines).where(eq(schema.taxLines.journalEntryId, journalEntryId));
    expect(taxRows[0]).toMatchObject({ taxableAmount: '-100.00', taxAmount: '-21.00' });
    expect(await balanceOf('1300')).toBe(0);
  });

  it('a manual entry with tax posts tax-ledger rows; reversing it nets them to zero', async () => {
    const created = await call('/api/journal-entries', journalEntriesRoutes, '/api/journal-entries', 'POST', {
      date: '2026-07-15',
      lines: [
        { accountId: accountId['4310'], debit: '121', taxRateId: rateId.voorbelasting, taxAmount: '21' },
        { accountId: accountId['1100'], credit: '121' },
      ],
    });
    expect(created.status).toBe(201);
    const entryId = created.data.id as string;
    expect((await call('/api/journal-entries', journalEntriesRoutes, `/api/journal-entries/${entryId}/post`, 'POST')).status).toBe(200);
    const reversed = await call('/api/journal-entries', journalEntriesRoutes, `/api/journal-entries/${entryId}/reverse`, 'POST');
    expect(reversed.status).toBe(201);

    const rows = await db.select().from(schema.taxLines).where(and(eq(schema.taxLines.entityId, entityId), eq(schema.taxLines.sourceId, entryId)));
    expect(rows.map((r) => Number(r.taxAmount)).sort()).toEqual([-21, 21]);
    const [original] = await db.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, entryId));
    expect(original.status).toBe('reversed');
  });

  it('refuses unbalanced entries, foreign accounts, and posts a key only once', async () => {
    await expect(postJournalEntry(db, {
      entityId,
      date: new Date('2026-07-16'),
      description: 'unbalanced',
      sourceType: 'manual',
      lockKind: 'general',
      lines: [{ accountId: accountId['4310'], debit: 10 }, { accountId: accountId['1100'], credit: 9 }],
    })).rejects.toThrow(PostingError);

    const posted = await postJournalEntry(db, {
      entityId,
      date: new Date('2026-07-16'),
      description: 'once',
      sourceType: 'manual',
      postingKey: 'test:once',
      lockKind: 'general',
      lines: [{ accountId: accountId['4310'], debit: 10 }, { accountId: accountId['1100'], credit: 10 }],
    });
    const again = await postJournalEntry(db, {
      entityId,
      date: new Date('2026-07-16'),
      description: 'once',
      sourceType: 'manual',
      postingKey: 'test:once',
      lockKind: 'general',
      lines: [{ accountId: accountId['4310'], debit: 10 }, { accountId: accountId['1100'], credit: 10 }],
    });
    expect(again).toMatchObject({ journalEntryId: posted.journalEntryId, alreadyPosted: true });
  });

  it('lock dates refuse postings on or before them unless an exception is active', async () => {
    await db.update(schema.entities).set({ salesLockDate: '2026-07-31' }).where(eq(schema.entities.id, entityId));
    const lockedInvoice = await createInvoice('2026-07-25');
    const refused = await call('/api/invoices', invoicesRoutes, `/api/invoices/${lockedInvoice}/finalize`, 'POST');
    expect(refused.status).toBe(400);
    expect(refused.error?.message).toMatch(/locked up to and including 2026-07-31/);

    await db.insert(schema.lockDateExceptions).values({
      id: 'lde_test',
      entityId,
      lockType: 'sales',
      userId: null,
      endsAt: new Date(Date.now() + 60 * 60 * 1000),
      reason: 'Late invoice',
    });
    const allowed = await call('/api/invoices', invoicesRoutes, `/api/invoices/${lockedInvoice}/finalize`, 'POST');
    expect(allowed.status).toBe(200);
    await db.update(schema.entities).set({ salesLockDate: null }).where(eq(schema.entities.id, entityId));
  });

  it('recurring generation finalizes with tax and can never bill a period twice', async () => {
    await db.insert(schema.recurringInvoices).values({
      id: 'ri_ledger',
      entityId,
      contactId: 'pty_customer',
      frequency: 'monthly',
      nextIssueDate: new Date('2026-08-01'),
      status: 'active',
      autoFinalize: true,
      templateData: { items: [{ description: 'Retainer', quantity: 1, unitPrice: 200, taxRateId: rateId.hoog }] },
    });
    const generated = await call('/api/recurring-invoices', recurringInvoicesRoutes, '/api/recurring-invoices/ri_ledger/generate', 'POST');
    expect(generated.status).toBe(201);
    expect(generated.data.journalEntryId).toMatch(/^je_/);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, generated.data.invoiceId as string));
    expect(invoice).toMatchObject({ taxTotal: '42.00', total: '242.00', status: 'sent' });

    const stale = { ...(await db.select().from(schema.recurringInvoices).where(eq(schema.recurringInvoices.id, 'ri_ledger')))[0], nextIssueDate: new Date('2026-08-01') };
    await expect(generateRecurringInvoice(db, stale, { userId: null })).rejects.toThrow(RecurringAlreadyGeneratedError);
  });

  it('matching a bank line to an invoice records a posted payment; unreconcile voids it', async () => {
    const invoice = await createInvoice('2026-08-02', '200');
    await call('/api/invoices', invoicesRoutes, `/api/invoices/${invoice}/finalize`, 'POST');
    await db.insert(schema.bankAccounts).values({ id: 'ba_ledger', entityId, name: 'ING', currency: 'EUR', ledgerAccountId: accountId['1100'] });
    await db.insert(schema.bankTransactions).values({
      id: 'bt_ledger', entityId, bankAccountId: 'ba_ledger', date: new Date('2026-08-05'), amount: '242.00', status: 'unreconciled', description: 'Klant BV',
    });

    const matched = await call('/api/bank-transactions', bankTransactionsRoutes, '/api/bank-transactions/bt_ledger/reconcile', 'POST', { type: 'invoice', entityId: invoice });
    expect(matched.status).toBe(200);
    expect(await entryLines(matched.data.journalEntryId as string)).toEqual([
      { code: '1100', debit: 242, credit: 0 },
      { code: '1300', debit: 0, credit: 242 },
    ]);
    const [paid] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice));
    expect(paid.status).toBe('paid');
    const [line] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_ledger'));
    expect(line).toMatchObject({ status: 'reconciled', reconciledPaymentId: matched.data.paymentId });

    const undone = await call('/api/bank-transactions', bankTransactionsRoutes, '/api/bank-transactions/bt_ledger/unreconcile', 'POST');
    expect(undone.status).toBe(200);
    const [reopened] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoice));
    expect(reopened).toMatchObject({ status: 'sent', balanceDue: '242.00' });
    const [released] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.id, 'bt_ledger'));
    expect(released).toMatchObject({ status: 'unreconciled', reconciledPaymentId: null, journalEntryId: null });
  });

  it('the daily sweep marks finalized invoices past due as overdue', async () => {
    const pastDue = await createInvoice('2026-07-01', '50', '2026-07-15');
    await call('/api/invoices', invoicesRoutes, `/api/invoices/${pastDue}/finalize`, 'POST');
    const result = await sweepTenant(db, new Date('2026-09-01T03:00:00Z'));
    expect(result.overdue).toBeGreaterThanOrEqual(1);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, pastDue));
    expect(invoice.status).toBe('overdue');
  });

  it('the catch-up books a legacy sent invoice, previewing first and keeping its status', async () => {
    const legacy = await createInvoice('2026-07-05');
    await db.update(schema.invoices).set({ status: 'paid' }).where(eq(schema.invoices.id, legacy));

    const preview = await call('/api/accounting-settings', accountingSettingsRoutes, '/api/accounting-settings/posting-catch-up', 'POST', { dryRun: true });
    expect(preview.status).toBe(200);
    expect(preview.data.invoices).toBeGreaterThanOrEqual(1);
    const [untouched] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, legacy));
    expect(untouched.journalEntryId).toBeNull();

    const run = await call('/api/accounting-settings', accountingSettingsRoutes, '/api/accounting-settings/posting-catch-up', 'POST', { dryRun: false });
    expect(run.status).toBe(200);
    const [booked] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, legacy));
    expect(booked.journalEntryId).toMatch(/^je_/);
    expect(booked.status).toBe('paid');

    const second = await call('/api/accounting-settings', accountingSettingsRoutes, '/api/accounting-settings/posting-catch-up', 'POST', { dryRun: true });
    expect(second.data.invoices).toBe(0);
  });
});
