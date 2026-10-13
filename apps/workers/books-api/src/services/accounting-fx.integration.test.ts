/**
 * Foreign-currency documents on a EUR entity (pglite): the exchange rate of the
 * document date is resolved and stored, posting is in base currency at that rate
 * (foreign units per base unit), posting is refused without a rate, a typed rate
 * overrides, and a payment at another rate books the realised FX gain or loss.
 * Also: finalize leaves an invoice `finalized` until it is sent, and a sales
 * document refuses a purchase-only tax rate (and the other way round).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../routes/accounting-entities';
import { invoicesRoutes } from '../routes/invoices';
import { billsRoutes } from '../routes/bills';
import { paymentsRoutes } from '../routes/payments';

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

const invoices = (path: string, method = 'GET', body?: unknown) => call('/api/invoices', invoicesRoutes, `/api/invoices${path}`, method, body);
const bills = (path: string, method = 'GET', body?: unknown) => call('/api/bills', billsRoutes, `/api/bills${path}`, method, body);
const payments = (path: string, method = 'GET', body?: unknown) => call('/api/payments', paymentsRoutes, `/api/payments${path}`, method, body);

async function entryLines(journalEntryId: string) {
  const rows = await db
    .select({
      code: schema.accounts.code,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
      currency: schema.journalLines.currency,
      exchangeRate: schema.journalLines.exchangeRate,
    })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.journalLines.accountId, schema.accounts.id))
    .where(eq(schema.journalLines.journalEntryId, journalEntryId));
  return rows
    .map((r) => ({ code: r.code, debit: Number(r.debit), credit: Number(r.credit), currency: r.currency, rate: Number(r.exchangeRate) }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.debit - b.debit);
}

async function balanceOf(code: string) {
  const [row] = await db.select({ balance: schema.accounts.currentBalance }).from(schema.accounts)
    .where(eq(schema.accounts.id, accountId[code])).limit(1);
  return Number(row?.balance ?? 0);
}

const usdInvoice = (extra: Record<string, unknown> = {}) => ({
  contactId: 'pty_customer',
  currency: 'USD',
  issueDate: '2026-07-10',
  dueDate: '2099-12-31',
  items: [{ description: 'Consulting', quantity: '1', unitPrice: '1000' }],
  ...extra,
});

const usdBill = (extra: Record<string, unknown> = {}) => ({
  contactId: 'pty_supplier',
  currency: 'USD',
  issueDate: '2026-07-10',
  dueDate: '2099-12-31',
  items: [{ description: 'Hosting', quantity: '1', unitPrice: '1000', accountId: accountId['4310'] }],
  ...extra,
});

beforeAll(async () => {
  // No network in the suite: the ECB feed is "unreachable".
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

  const handle = await createPgliteDb();
  db = handle.db;

  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name: 'FX BV',
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
    address: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 AB', country: 'NL' },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id as string;

  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  for (const a of accounts) accountId[a.code] = a.id;
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  const byName = (name: string) => rates.find((r) => r.name === name)!;
  rateId.hoog = byName('BTW Hoog 21%').id;
  rateId.voorbelasting = byName('BTW Voorbelasting 21%').id;
  rateId.salesOnly = byName('BTW ICL goederen').id;

  await db.insert(schema.parties).values([
    { id: 'pty_customer', displayName: 'Customer Inc', role: 'customer', billingAddress: { line1: 'Main St 1', city: 'Austin', postalCode: '73301', country: 'US' } },
    { id: 'pty_supplier', displayName: 'Hosting Inc', role: 'supplier' },
  ]);
  // 1 EUR = 1.25 USD from the first of July, 1.50 USD from the 15th.
  await db.insert(schema.fxRates).values([
    { id: 'fxr_a', date: '2026-07-01', fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.25', source: 'manual' },
    { id: 'fxr_b', date: '2026-07-15', fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.5', source: 'manual' },
  ]);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('invoice finalize and send', () => {
  it('finalize leaves the invoice finalized, send makes it sent, and a resend keeps it sent', async () => {
    const created = await invoices('', 'POST', { contactId: 'pty_customer', issueDate: '2026-07-10', dueDate: '2099-12-31', items: [{ description: 'Work', unitPrice: '100' }] });
    expect(created.status).toBe(201);
    const id = created.data.id as string;

    const finalized = await invoices(`/${id}/finalize`, 'POST');
    expect(finalized.status).toBe(200);
    expect(finalized.data.status).toBe('finalized');
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    expect(row).toMatchObject({ status: 'finalized', sentAt: null });

    const sent = await invoices(`/${id}/send`, 'PATCH');
    expect(sent.status).toBe(200);
    expect(sent.data.status).toBe('sent');
    const [afterSend] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    expect(afterSend.status).toBe('sent');
    expect(afterSend.sentAt).not.toBeNull();

    const resent = await invoices(`/${id}/send`, 'PATCH');
    expect(resent.status).toBe(200);
    expect(resent.data.status).toBe('sent');
  });

  it('sending a draft finalizes it and marks it sent in one go', async () => {
    const created = await invoices('', 'POST', { contactId: 'pty_customer', issueDate: '2026-07-10', dueDate: '2099-12-31', items: [{ description: 'Work', unitPrice: '50' }] });
    const sent = await invoices(`/${created.data.id}/send`, 'PATCH');
    expect(sent.status).toBe(200);
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, created.data.id as string));
    expect(row.status).toBe('sent');
    expect(row.journalEntryId).toMatch(/^je_/);
  });
});

describe('foreign-currency invoices', () => {
  it('stores the rate of the issue date and posts the base-currency amounts at it', async () => {
    const created = await invoices('', 'POST', usdInvoice());
    expect(created.status).toBe(201);
    expect(created.data.exchangeRate).toBe('1.250000');
    const id = created.data.id as string;

    const finalized = await invoices(`/${id}/finalize`, 'POST');
    expect(finalized.status).toBe(200);
    // 1000 USD at 1.25 USD per EUR = 800.00 EUR, not 1000.
    expect(await entryLines(finalized.data.journalEntryId as string)).toEqual([
      { code: '1300', debit: 800, credit: 0, currency: 'USD', rate: 1.25 },
      { code: '8000', debit: 0, credit: 800, currency: 'USD', rate: 1.25 },
    ]);
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    expect(row).toMatchObject({ currency: 'USD', exchangeRate: '1.250000', total: '1000.00' });
  });

  it('a draft without any rate saves, and finalizing is refused until there is one', async () => {
    const created = await invoices('', 'POST', usdInvoice({ issueDate: '2020-01-01' }));
    expect(created.status).toBe(201);
    expect(created.data.exchangeRate).toBeNull();
    const id = created.data.id as string;

    const refused = await invoices(`/${id}/finalize`, 'POST');
    expect(refused.status).toBe(400);
    expect(refused.error?.message).toMatch(/No exchange rate found for USD against EUR on 2020-01-01/);
    const [stillDraft] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    expect(stillDraft).toMatchObject({ status: 'draft', journalEntryId: null });

    // A rate typed on the document is used instead.
    const updated = await invoices(`/${id}`, 'PATCH', { exchangeRate: '1.1' });
    expect(updated.status).toBe(200);
    const finalized = await invoices(`/${id}/finalize`, 'POST');
    expect(finalized.status).toBe(200);
    const lines = await entryLines(finalized.data.journalEntryId as string);
    expect(lines).toEqual([
      { code: '1300', debit: 909.09, credit: 0, currency: 'USD', rate: 1.1 },
      { code: '8000', debit: 0, credit: 909.09, currency: 'USD', rate: 1.1 },
    ]);
  });

  it('a typed rate on create wins over the stored one', async () => {
    const created = await invoices('', 'POST', usdInvoice({ exchangeRate: '2' }));
    expect(created.status).toBe(201);
    expect(created.data.exchangeRate).toBe('2.000000');
    const finalized = await invoices(`/${created.data.id}/finalize`, 'POST');
    expect((await entryLines(finalized.data.journalEntryId as string))[0]).toMatchObject({ code: '1300', debit: 500 });
  });

  it('a draft left at the default rate 1 is looked up when it is finalized, never posted at 1', async () => {
    const created = await invoices('', 'POST', usdInvoice());
    await db.update(schema.invoices).set({ exchangeRate: '1' }).where(eq(schema.invoices.id, created.data.id as string));
    const finalized = await invoices(`/${created.data.id}/finalize`, 'POST');
    expect(finalized.status).toBe(200);
    expect((await entryLines(finalized.data.journalEntryId as string))[0]).toMatchObject({ code: '1300', debit: 800, rate: 1.25 });
  });

  it('an invoice in the base currency is untouched: rate 1', async () => {
    const created = await invoices('', 'POST', usdInvoice({ currency: 'EUR' }));
    expect(Number(created.data.exchangeRate)).toBe(1);
    const finalized = await invoices(`/${created.data.id}/finalize`, 'POST');
    expect((await entryLines(finalized.data.journalEntryId as string))[0]).toMatchObject({ code: '1300', debit: 1000 });
  });
});

describe('foreign-currency bills', () => {
  it('posts the payable in base currency at the rate of the bill date', async () => {
    const created = await bills('', 'POST', usdBill());
    expect(created.status).toBe(201);
    expect(created.data.exchangeRate).toBe('1.250000');
    const approved = await bills(`/${created.data.id}/approve`, 'PATCH');
    expect(approved.status).toBe(200);
    const [bill] = await db.select().from(schema.bills).where(eq(schema.bills.id, created.data.id as string));
    expect(bill.journalEntryId).toMatch(/^je_/);
    expect(await entryLines(bill.journalEntryId as string)).toEqual([
      { code: '1600', debit: 0, credit: 800, currency: 'USD', rate: 1.25 },
      { code: '4310', debit: 800, credit: 0, currency: 'USD', rate: 1.25 },
    ]);
  });

  it('refuses to approve without a rate, accepts a typed one', async () => {
    const created = await bills('', 'POST', usdBill({ issueDate: '2020-01-01' }));
    expect(created.data.exchangeRate).toBeNull();
    const refused = await bills(`/${created.data.id}/approve`, 'PATCH');
    expect(refused.status).toBe(400);
    expect(refused.error?.message).toMatch(/No exchange rate found for USD/);

    const updated = await bills(`/${created.data.id}`, 'PATCH', { exchangeRate: '2' });
    expect(updated.status).toBe(200);
    const approved = await bills(`/${created.data.id}/approve`, 'PATCH');
    expect(approved.status).toBe(200);
  });
});

describe('realised FX on payments', () => {
  async function finalizedUsdInvoice() {
    const created = await invoices('', 'POST', usdInvoice());
    const finalized = await invoices(`/${created.data.id}/finalize`, 'POST');
    expect(finalized.status).toBe(200);
    return created.data.id as string;
  }

  it('money received at a weaker rate is a loss: the payment is worth less than the invoice carried', async () => {
    const id = await finalizedUsdInvoice(); // 800 EUR booked at 1.25
    const before = await balanceOf('1300');
    const paid = await invoices(`/${id}/record-payment`, 'POST', { amount: '1000', date: '2026-07-20', paymentMethod: 'bank_transfer', exchangeRate: '1.6' });
    expect(paid.status).toBe(201);
    expect(paid.data.status).toBe('paid');
    // 1000 USD at 1.60 = 625 EUR in the bank.
    expect(await entryLines(paid.data.journalEntryId as string)).toEqual([
      { code: '1100', debit: 625, credit: 0, currency: 'USD', rate: 1.6 },
      { code: '1300', debit: 0, credit: 625, currency: 'USD', rate: 1.6 },
    ]);
    const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, paid.data.paymentId as string));
    expect(payment).toMatchObject({ currency: 'USD', exchangeRate: '1.600000' });
    // The 175 EUR difference goes to 4950, and the receivable of this invoice is settled to the cent.
    expect(payment.exchangeDifferenceEntryId).toMatch(/^je_/);
    expect(await entryLines(payment.exchangeDifferenceEntryId as string)).toEqual([
      { code: '1300', debit: 0, credit: 175, currency: null, rate: 1 },
      { code: '4950', debit: 175, credit: 0, currency: null, rate: 1 },
    ]);
    expect(await balanceOf('1300')).toBe(before - 800);

    // Voiding reverses the payment and its FX entry.
    const voided = await payments(`/${paid.data.paymentId}`, 'DELETE');
    expect(voided.status).toBe(204);
    expect(await balanceOf('1300')).toBe(before);
    expect(await balanceOf('4950')).toBe(0);
  });

  it('the rate of the payment date is used when none is typed; money received at a stronger rate is a gain', async () => {
    const id = await finalizedUsdInvoice(); // 800 EUR at 1.25
    // 2026-07-20: the stored rate is 1.5 (from the 15th): 1000 USD = 666.67 EUR, a loss of 133.33 against 800.
    const paid = await invoices(`/${id}/record-payment`, 'POST', { amount: '1000', date: '2026-07-20', paymentMethod: 'bank_transfer' });
    expect(paid.status).toBe(201);
    const [payment] = await db.select().from(schema.payments).where(eq(schema.payments.id, paid.data.paymentId as string));
    expect(payment.exchangeRate).toBe('1.500000');

    // A gain: paid at 1.0 (1000 EUR for an invoice that carried 800).
    const id2 = await finalizedUsdInvoice();
    const gainPaid = await invoices(`/${id2}/record-payment`, 'POST', { amount: '1000', date: '2026-07-20', paymentMethod: 'bank_transfer', exchangeRate: '1' });
    expect(gainPaid.status).toBe(201);
    const [gainPayment] = await db.select().from(schema.payments).where(eq(schema.payments.id, gainPaid.data.paymentId as string));
    expect(await entryLines(gainPayment.exchangeDifferenceEntryId as string)).toEqual([
      { code: '1300', debit: 200, credit: 0, currency: null, rate: 1 },
      { code: '8400', debit: 0, credit: 200, currency: null, rate: 1 },
    ]);
  });

  it('a bill paid at a weaker rate than it was booked at is a gain, at a stronger rate a loss', async () => {
    const createBill = async () => {
      const created = await bills('', 'POST', usdBill());
      expect((await bills(`/${created.data.id}/approve`, 'PATCH')).status).toBe(200);
      return created.data.id as string;
    };

    // Booked at 1.25 (800 EUR); paying 1000 USD at 1.6 costs 625 EUR: a gain of 175.
    const billA = await createBill();
    const paidA = await payments('', 'POST', { type: 'sent', amount: '1000', date: '2026-07-20', paymentMethod: 'bank_transfer', exchangeRate: '1.6', billId: billA });
    expect(paidA.status).toBe(201);
    const [paymentA] = await db.select().from(schema.payments).where(eq(schema.payments.id, paidA.data.id as string));
    expect(await entryLines(paymentA.exchangeDifferenceEntryId as string)).toEqual([
      { code: '1600', debit: 175, credit: 0, currency: null, rate: 1 },
      { code: '8400', debit: 0, credit: 175, currency: null, rate: 1 },
    ]);

    // Paying at 1.0 costs 1000 EUR: a loss of 200.
    const billB = await createBill();
    const paidB = await payments('', 'POST', { type: 'sent', amount: '1000', date: '2026-07-20', paymentMethod: 'bank_transfer', exchangeRate: '1', billId: billB });
    expect(paidB.status).toBe(201);
    const [paymentB] = await db.select().from(schema.payments).where(eq(schema.payments.id, paidB.data.id as string));
    expect(await entryLines(paymentB.exchangeDifferenceEntryId as string)).toEqual([
      { code: '1600', debit: 0, credit: 200, currency: null, rate: 1 },
      { code: '4950', debit: 200, credit: 0, currency: null, rate: 1 },
    ]);
  });

  it('a payment in another currency than the invoice is refused', async () => {
    const id = await finalizedUsdInvoice();
    const refused = await payments('', 'POST', { type: 'received', amount: '100', currency: 'EUR', date: '2026-07-20', paymentMethod: 'bank_transfer', contactId: 'pty_customer', invoiceId: id });
    expect(refused.status).toBe(400);
    expect(refused.error?.message).toMatch(/is in USD/);
  });
});

describe('tax rate type', () => {
  it('an invoice line refuses a purchase-only rate, a bill line a sales-only one', async () => {
    const invoice = await invoices('', 'POST', {
      contactId: 'pty_customer',
      issueDate: '2026-07-10',
      dueDate: '2099-12-31',
      items: [{ description: 'Work', unitPrice: '100', taxRateId: rateId.voorbelasting }],
    });
    expect(invoice.status).toBe(400);
    expect(invoice.error?.message).toMatch(/purchase rate/);

    const bill = await bills('', 'POST', {
      contactId: 'pty_supplier',
      issueDate: '2026-07-10',
      dueDate: '2099-12-31',
      items: [{ description: 'Stuff', unitPrice: '100', taxRateId: rateId.salesOnly, accountId: accountId['4310'] }],
    });
    expect(bill.status).toBe(400);
    expect(bill.error?.message).toMatch(/sales rate/);

    const okInvoice = await invoices('', 'POST', {
      contactId: 'pty_customer',
      issueDate: '2026-07-10',
      dueDate: '2099-12-31',
      items: [{ description: 'Work', unitPrice: '100', taxRateId: rateId.hoog }],
    });
    expect(okInvoice.status).toBe(201);
  });
});
