/**
 * Bad debt VAT relief on a Dutch entity (pglite): a write-off splits the open
 * balance into net bad debt and VAT (art. 29 Wet OB), the VAT comes back
 * through the BTW return as negative output tax, a payment on a written-off
 * invoice takes the relief back in proportion, and voiding that payment puts
 * everything as it was.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { accountingEntitiesRoutes } from '../routes/accounting-entities';
import { invoicesRoutes } from '../routes/invoices';
import { vatReturnsRoutes } from '../routes/vat-returns';
import { paymentsRoutes } from '../routes/payments';
import { badDebtVatReliefApplies } from './accounting-bad-debt';

let db: Database;
let entityId: string;
const accountId: Record<string, string> = {};
let hoogRate: string;
const TODAY = new Date().toISOString().slice(0, 10);

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

async function reliefRows(invoiceId: string) {
  const rows = await db.select().from(schema.taxLines)
    .where(and(eq(schema.taxLines.sourceId, invoiceId), inArray(schema.taxLines.sourceType, ['write_off', 'write_off_recovery'])));
  return rows.map((r) => ({
    sourceType: r.sourceType,
    direction: r.direction,
    taxableAmount: Number(r.taxableAmount),
    taxAmount: Number(r.taxAmount),
    taxDate: r.taxDate,
  }));
}

/** A finalized invoice of `net` + 21%. */
async function finalizedInvoice(net: string, issueDate = '2026-07-10') {
  const created = await call('/api/invoices', invoicesRoutes, '/api/invoices', 'POST', {
    contactId: 'pty_customer',
    issueDate,
    dueDate: '2026-08-10',
    items: [{ description: 'Consulting', quantity: '1', unitPrice: net, taxRateId: hoogRate }],
  });
  expect(created.status).toBe(201);
  const id = created.data.id as string;
  const res = await call('/api/invoices', invoicesRoutes, `/api/invoices/${id}/finalize`, 'POST');
  expect(res.status).toBe(200);
  return id;
}

async function invoiceRow(id: string) {
  const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
  return row;
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', 'POST', {
    name: 'Relief BV',
    jurisdictionCode: 'NL',
    vatNumber: 'NL123456789B01',
    taxIdentifiers: { registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300' },
    address: { line1: 'Keizersgracht 1', city: 'Amsterdam', postalCode: '1015 AA', country: 'NL' },
    contact: { phone: '+31201234567' },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id as string;

  const accounts = await db.select().from(schema.accounts).where(eq(schema.accounts.entityId, entityId));
  for (const a of accounts) accountId[a.code] = a.id;
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  hoogRate = rates.find((r) => r.name === 'BTW Hoog 21%')!.id;

  await db.insert(schema.parties).values([
    { id: 'pty_customer', displayName: 'Klant BV', role: 'customer', billingAddress: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 AB', country: 'NL' } },
  ]);
}, 60_000);

describe('write-off of a VAT invoice (art. 29 Wet OB)', () => {
  let invoiceId: string;

  it('books the net as bad debt and the VAT back to BTW te betalen, never the gross as expense', async () => {
    invoiceId = await finalizedInvoice('250');
    expect(await balanceOf('1700')).toBe(-52.5); // credit balance: owed to the Belastingdienst

    const res = await call('/api/invoices', invoicesRoutes, `/api/invoices/${invoiceId}/status`, 'PATCH', { status: 'uncollectible' });
    expect(res.status).toBe(200);
    expect(res.data.vatRelief).toBe(52.5);

    expect(await entryLines(res.data.writeOffEntryId as string)).toEqual([
      { code: '1300', debit: 0, credit: 302.5 },
      { code: '1700', debit: 52.5, credit: 0 },
      { code: '4690', debit: 250, credit: 0 },
    ]);
    expect(await balanceOf('1700')).toBe(0);
    expect(await balanceOf('4690')).toBe(250);
    expect(await balanceOf('1300')).toBe(0);
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: 'uncollectible', balanceDue: '0.00' });
  });

  it('writes negative output-tax rows, so the return of the write-off period deducts the VAT', async () => {
    expect(await reliefRows(invoiceId)).toEqual([
      { sourceType: 'write_off', direction: 'sales', taxableAmount: -250, taxAmount: -52.5, taxDate: TODAY },
    ]);

    const res = await call('/api/vat-returns', vatReturnsRoutes, '/api/vat-returns/calculate', 'POST', {
      periodType: 'monthly',
      periodStart: TODAY,
      periodEnd: TODAY,
    });
    expect(res.status).toBe(201);
    expect(res.data.rubrieken).toMatchObject({ r1a: -250, r1aBtw: -52.5, r5a: -52.5, r5c: -52.5, r5g: -52.5 });
  });

  it('writes off only the unpaid part of a partly paid invoice, with the VAT of that part', async () => {
    const partly = await finalizedInvoice('1000'); // 1210 incl. VAT
    const paid = await call('/api/invoices', invoicesRoutes, `/api/invoices/${partly}/record-payment`, 'POST', {
      amount: '605.00',
      date: TODAY,
      paymentMethod: 'bank_transfer',
    });
    expect(paid.status).toBe(201);

    const res = await call('/api/invoices', invoicesRoutes, `/api/invoices/${partly}/status`, 'PATCH', { status: 'uncollectible' });
    expect(res.status).toBe(200);
    expect(res.data.vatRelief).toBe(105);
    expect(await entryLines(res.data.writeOffEntryId as string)).toEqual([
      { code: '1300', debit: 0, credit: 605 },
      { code: '1700', debit: 105, credit: 0 },
      { code: '4690', debit: 500, credit: 0 },
    ]);
    expect(await reliefRows(partly)).toEqual([
      { sourceType: 'write_off', direction: 'sales', taxableAmount: -500, taxAmount: -105, taxDate: TODAY },
    ]);
  });

  it('a payment on a written-off invoice pays back the relief in proportion, and a void undoes it', async () => {
    const id = await finalizedInvoice('250');
    await call('/api/invoices', invoicesRoutes, `/api/invoices/${id}/status`, 'PATCH', { status: 'uncollectible' });
    const bad = await balanceOf('4690');
    const vat = await balanceOf('1700');
    const receivable = await balanceOf('1300');

    // 100 of the 302.50 written off comes in: 100 / 302.50 of the VAT (17.36) is owed again.
    const first = await call('/api/invoices', invoicesRoutes, `/api/invoices/${id}/record-payment`, 'POST', {
      amount: '100.00',
      date: TODAY,
      paymentMethod: 'bank_transfer',
    });
    expect(first.status).toBe(201);
    expect(await invoiceRow(id)).toMatchObject({ status: 'uncollectible', amountPaid: '100.00', balanceDue: '0.00' });
    expect(await balanceOf('4690')).toBe(Math.round((bad - 82.64) * 100) / 100);
    expect(await balanceOf('1700')).toBe(Math.round((vat - 17.36) * 100) / 100);
    expect(await balanceOf('1300')).toBe(receivable);

    const rows = await reliefRows(id);
    expect(rows.find((r) => r.sourceType === 'write_off_recovery')).toMatchObject({ taxableAmount: 82.64, taxAmount: 17.36 });

    // The rest comes in: the full relief is repaid and the invoice is paid.
    const second = await call('/api/invoices', invoicesRoutes, `/api/invoices/${id}/record-payment`, 'POST', {
      amount: '202.50',
      date: TODAY,
      paymentMethod: 'bank_transfer',
    });
    expect(second.status).toBe(201);
    expect(await invoiceRow(id)).toMatchObject({ status: 'paid', amountPaid: '302.50', balanceDue: '0.00' });
    const net = (await reliefRows(id)).reduce((sum, r) => ({ taxable: sum.taxable + r.taxableAmount, tax: sum.tax + r.taxAmount }), { taxable: 0, tax: 0 });
    expect(Math.round(net.tax * 100) / 100).toBe(0);
    expect(Math.round(net.taxable * 100) / 100).toBe(0);
    expect(await balanceOf('4690')).toBe(Math.round((bad - 250) * 100) / 100);
    expect(await balanceOf('1300')).toBe(receivable);

    // Voiding the last payment puts the invoice back as written off (with its 202.50 still outstanding).
    const voided = await call('/api/payments', paymentsRoutes, `/api/payments/${second.data.paymentId}`, 'DELETE');
    expect(voided.status).toBe(204);
    expect(await invoiceRow(id)).toMatchObject({ status: 'uncollectible', amountPaid: '100.00', balanceDue: '0.00' });
    expect(await balanceOf('1300')).toBe(receivable);
  });

  it('rejects a payment larger than what was written off', async () => {
    const id = await finalizedInvoice('100');
    await call('/api/invoices', invoicesRoutes, `/api/invoices/${id}/status`, 'PATCH', { status: 'uncollectible' });
    const res = await call('/api/invoices', invoicesRoutes, `/api/invoices/${id}/record-payment`, 'POST', {
      amount: '200.00',
      date: TODAY,
      paymentMethod: 'bank_transfer',
    });
    expect(res.status).toBe(400);
  });
});

describe('badDebtVatReliefApplies', () => {
  it('applies to NL and not to jurisdictions without relief or to US sales-tax invoices', () => {
    expect(badDebtVatReliefApplies({ jurisdictionCode: 'NL' }, { type: 'standard', taxEngine: null })).toBe(true);
    expect(badDebtVatReliefApplies({ jurisdictionCode: 'NL' }, { type: 'credit_note', taxEngine: null })).toBe(false);
    expect(badDebtVatReliefApplies({ jurisdictionCode: 'IN' }, { type: 'standard', taxEngine: null })).toBe(false);
    expect(badDebtVatReliefApplies({ jurisdictionCode: 'US' }, { type: 'standard', taxEngine: null })).toBe(false);
    expect(badDebtVatReliefApplies({ jurisdictionCode: 'NL' }, { type: 'standard', taxEngine: 'manual' })).toBe(false);
  });
});
