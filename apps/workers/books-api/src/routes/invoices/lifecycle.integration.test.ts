/**
 * An invoice's life on a Dutch entity, route by route: a draft is created,
 * read, replaced (PUT) and patched; finalizing refuses an entity without its
 * legally required fields, then posts; sending, recording a payment, a credit
 * note applied on finalize and by hand, writing off and cancelling; the
 * provider tax sync (not applicable outside the US), attachments, an invoice
 * from a commerce order, and the refusals of each route.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { invoicesRoutes } from './index';
import { accountingEntitiesRoutes } from '../accounting-entities';

let db: Database;
let entityId: string;
let bareEntityId: string;
let hoog: string;

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: { message: string; details?: any };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; entityId?: string } = {}): Promise<Result> {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.entityId ? { 'X-Accounting-Entity-Id': opts.entityId } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  let json: { data?: unknown; error?: { message: string } } = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // HTML
  }
  return { status: res.status, data: json.data, error: json.error };
}

const invoices = (path: string, opts: { method?: string; body?: unknown; entityId?: string } = {}) =>
  call('/api/invoices', invoicesRoutes, `/api/invoices${path}`, { entityId, ...opts });

const draftBody = (extra: Record<string, unknown> = {}) => ({
  contactId: 'pty_life',
  issueDate: '2026-07-10',
  dueDate: '2099-12-31',
  items: [{ description: 'Consulting', quantity: '2', unitPrice: '50', taxRateId: hoog }],
  ...extra,
});

async function createEntity(name: string, complete: boolean) {
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    body: complete
      ? {
          name,
          jurisdictionCode: 'NL',
          vatNumber: 'NL123456789B01',
          taxIdentifiers: { registrationNumber: '12345678' },
          bankDetails: { iban: 'NL91ABNA0417164300' },
          address: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' },
        }
      : { name, jurisdictionCode: 'NL' },
  });
  expect(created.status).toBe(201);
  return created.data.id as string;
}

async function draft(extra: Record<string, unknown> = {}) {
  const created = await invoices('', { method: 'POST', body: draftBody(extra) });
  expect(created.status).toBe(201);
  return created.data.id as string;
}

async function finalized() {
  const id = await draft();
  const res = await invoices(`/${id}/finalize`, { method: 'POST' });
  expect(res.status).toBe(200);
  return id;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.parties).values([
    { id: 'pty_life', displayName: 'Levensloop BV', role: 'none', billingAddress: { line1: 'Kalverstraat 1', city: 'Amsterdam', postalCode: '1012 NX', country: 'NL' } },
  ]);
  entityId = await createEntity('Lifecycle BV', true);
  bareEntityId = await createEntity('Bare BV', false);
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  hoog = rates.find((r) => r.name === 'BTW Hoog 21%')!.id;
}, 60_000);

describe('/api/invoices · drafts', () => {
  it('creates, reads, replaces and patches a draft', async () => {
    const id = await draft({ reference: 'PO-1', notes: 'Thanks' });

    const detail = await invoices(`/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.data.items).toHaveLength(1);
    expect(detail.data.total).toBe('121.00');
    expect(detail.data.contactName).toBe('Levensloop BV');
    expect(detail.data.payments).toEqual([]);
    expect(detail.data.creditNotes).toEqual([]);

    const replaced = await invoices(`/${id}`, {
      method: 'PUT',
      body: { items: [{ description: 'Workshop', quantity: '1', unitPrice: '200', taxRateId: hoog }, { description: 'Travel', unitPrice: '10' }] },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.data.total).toBe('252.00');
    expect(replaced.data.items).toHaveLength(2);

    const patched = await invoices(`/${id}`, { method: 'PATCH', body: { reference: 'PO-2', dueDate: '2099-11-30', currency: 'EUR' } });
    expect(patched.status).toBe(200);
    expect(patched.data.reference).toBe('PO-2');

    const listed = await invoices('?search=PO-2');
    expect(listed.status).toBe(200);
    expect(listed.data.map((i: { id: string }) => i.id)).toContain(id);
  });

  it('refuses an unknown invoice, a rate of the wrong direction and a bad body', async () => {
    expect((await invoices('/inv_missing')).status).toBe(404);
    expect((await invoices('/inv_missing', { method: 'PUT', body: { notes: 'x' } })).status).toBe(404);
    expect((await invoices('/inv_missing', { method: 'DELETE' })).status).toBe(404);
    expect((await invoices('', { method: 'POST', body: { contactId: 'pty_life' } })).status).toBe(400);

    const purchase = (await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId))).find((r) => r.type === 'purchase');
    const wrong = await invoices('', { method: 'POST', body: draftBody({ items: [{ description: 'X', unitPrice: '1', taxRateId: purchase!.id }] }) });
    expect(wrong.status).toBe(400);

    const badRate = await invoices('', { method: 'POST', body: draftBody({ exchangeRate: '-1', placeOfSupply: 'MH' }) });
    expect(badRate.status).toBe(400);
  });

  it('deletes a draft and refuses to delete or edit a finalized invoice', async () => {
    const id = await draft();
    expect((await invoices(`/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await invoices(`/${id}`)).status).toBe(404);

    const booked = await finalized();
    expect((await invoices(`/${booked}`, { method: 'DELETE' })).status).toBe(400);
    expect((await invoices(`/${booked}`, { method: 'PATCH', body: { notes: 'late' } })).status).toBe(400);
    expect((await invoices(`/${booked}/finalize`, { method: 'POST' })).status).toBe(400);
  });
});

describe('/api/invoices · finalize, send, pay', () => {
  it('refuses to finalize for an entity without its required invoice fields', async () => {
    const created = await invoices('', { method: 'POST', entityId: bareEntityId, body: draftBody({ items: [{ description: 'Hours', unitPrice: '80' }] }) });
    expect(created.status).toBe(201);
    const res = await invoices(`/${created.data.id}/finalize`, { method: 'POST', entityId: bareEntityId });
    expect(res.status).toBe(400);
    expect(res.error?.details?.code).toBe('ENTITY_INVOICE_FIELDS_MISSING');
  });

  it('finalizes, sends, records a payment and shows it on the invoice', async () => {
    const id = await draft();
    const sent = await invoices(`/${id}/send`, { method: 'PATCH' });
    expect(sent.status).toBe(200);
    expect(sent.data.status).toBe('sent');
    expect(sent.data.journalEntryId).toBeTruthy();

    const again = await invoices(`/${id}/send`, { method: 'PATCH' });
    expect(again.status).toBe(200);

    const paid = await invoices(`/${id}/record-payment`, { method: 'POST', body: { amount: '21', date: '2026-07-20', paymentMethod: 'bank_transfer' } });
    expect(paid.status).toBe(201);
    expect(paid.data.balanceDue).toBe('100.00');
    expect(paid.data.status).toBe('partial');

    const detail = await invoices(`/${id}`);
    expect(detail.data.payments).toHaveLength(1);
    expect(detail.data.payments[0].allocatedAmount).toBe('21.00');

    const tax = await invoices(`/${id}/commit-tax`, { method: 'POST' });
    expect(tax.status).toBe(200);
    expect(tax.data.status).toBe('not_applicable');

    expect((await invoices(`/${id}/record-payment`, { method: 'POST', body: { amount: '1' } })).status).toBe(400);
    expect((await invoices('/inv_missing/record-payment', { method: 'POST', body: { amount: '1', date: '2026-07-20' } })).status).toBe(404);
  });

  it('a finalized credit note settles its invoice; applying it again has nothing left', async () => {
    const id = await finalized();
    const credit = await invoices(`/${id}/credit-note`, { method: 'POST' });
    expect(credit.status).toBe(201);
    const creditDetail = await invoices(`/${credit.data.id}`);
    expect(creditDetail.data.type).toBe('credit_note');
    expect(creditDetail.data.items[0].originalLineId).toBeTruthy();

    const done = await invoices(`/${credit.data.id}/finalize`, { method: 'POST' });
    expect(done.status).toBe(200);
    expect(done.data.creditApplied?.amount).toBe(121);
    expect((await invoices(`/${id}`)).data.status).toBe('paid');

    const nothing = await invoices(`/${credit.data.id}/apply-credit`, { method: 'POST', body: {} });
    expect(nothing.status).toBe(400);
    expect((await invoices(`/${credit.data.id}/apply-credit`, { method: 'POST', body: { amount: '0' } })).status).toBe(400);
    expect((await invoices(`/${id}/apply-credit`, { method: 'POST', body: {} })).status).toBe(400);
    expect((await invoices(`/${credit.data.id}/credit-note`, { method: 'POST' })).status).toBe(400);
  });

  it('applies a credit note to another open invoice of the customer by hand', async () => {
    const first = await finalized();
    const second = await finalized();
    const credit = await invoices(`/${first}/credit-note`, { method: 'POST' });
    // Pay the first invoice so the credit note stays open when it is finalized.
    await invoices(`/${first}/record-payment`, { method: 'POST', body: { amount: '121', date: '2026-07-20' } });
    await invoices(`/${credit.data.id}/finalize`, { method: 'POST' });

    const applied = await invoices(`/${credit.data.id}/apply-credit`, { method: 'POST', body: { invoiceId: second, amount: '50' } });
    expect(applied.status).toBe(200);
    expect(applied.data.amount).toBe('50.00');
    expect(applied.data.creditNote.balanceDue).toBe('71.00');
  });

  it('writes off a booked invoice and cancels a draft; refuses the rest', async () => {
    const booked = await finalized();
    const written = await invoices(`/${booked}/status`, { method: 'PATCH', body: { status: 'uncollectible' } });
    expect(written.status).toBe(200);
    expect(written.data.balanceDue).toBe('0.00');
    expect(written.data.writeOffEntryId).toBeTruthy();

    const again = await invoices(`/${booked}/status`, { method: 'PATCH', body: { status: 'uncollectible' } });
    expect(again.status).toBe(200);
    expect((await invoices(`/${booked}/status`, { method: 'PATCH', body: { status: 'cancelled' } })).status).toBe(400);

    const id = await draft();
    expect((await invoices(`/${id}/status`, { method: 'PATCH', body: { status: 'uncollectible' } })).status).toBe(400);
    const cancelled = await invoices(`/${id}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
    expect(cancelled.data.status).toBe('cancelled');
    expect((await invoices(`/${id}/send`, { method: 'PATCH' })).status).toBe(400);
    expect((await invoices(`/${id}/status`, { method: 'PATCH', body: { status: 'paid' } })).status).toBe(400);
    expect((await invoices('/inv_missing/status', { method: 'PATCH', body: { status: 'cancelled' } })).status).toBe(404);
  });

  it('answers 404 for the lifecycle routes of an unknown invoice', async () => {
    for (const [path, method] of [
      ['/send', 'PATCH'],
      ['/finalize', 'POST'],
      ['/commit-tax', 'POST'],
      ['/duplicate', 'POST'],
      ['/credit-note', 'POST'],
      ['/pdf', 'GET'],
    ] as const) {
      expect((await invoices(`/inv_missing${path}`, { method })).status).toBe(404);
    }
  });
});

describe('/api/invoices · attachments and orders', () => {
  it('refuses an attachment index that is not there', async () => {
    const id = await draft();
    expect((await invoices(`/${id}/attachments/0`)).status).toBe(404);
    expect((await invoices(`/${id}/attachments/x`)).status).toBe(400);
    expect((await invoices('/inv_missing/attachments/0')).status).toBe(404);
  });

  it('creates a draft from a commerce order, rebuilding the line rates', async () => {
    await db.insert(schema.orders).values({
      id: 'ord_life',
      orderNumber: 'ORD-1001',
      customerId: 'pty_life',
      customerName: 'Levensloop BV',
      currency: 'EUR',
      shippingTotal: '5.00',
      subtotal: '100.00',
      total: '126.00',
    } as typeof schema.orders.$inferInsert);
    await db.insert(schema.orderItems).values({
      id: 'oit_life',
      orderId: 'ord_life',
      name: 'Widget',
      quantity: 2,
      unitPrice: '50.00',
      taxAmount: '21.00',
      total: '121.00',
    } as typeof schema.orderItems.$inferInsert);
    const created = await invoices('/from-order/ord_life', { method: 'POST' });
    expect(created.status).toBe(201);
    const detail = await invoices(`/${created.data.invoiceId}`);
    expect(detail.data.items).toHaveLength(2);
    expect(detail.data.items[0].taxRateId).toBe(hoog);
    expect(detail.data.total).toBe('126.00');

    expect((await invoices('/from-order/ord_missing', { method: 'POST' })).status).toBe(404);
    await db.insert(schema.orders).values({ id: 'ord_empty', orderNumber: 'ORD-1002', customerId: 'pty_life', currency: 'EUR' } as typeof schema.orders.$inferInsert);
    expect((await invoices('/from-order/ord_empty', { method: 'POST' })).status).toBe(400);
  });
});
