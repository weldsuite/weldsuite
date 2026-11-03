/**
 * /api/payments on a Dutch entity: a payment settling an invoice (the single
 * `invoiceId` form and `allocations`), the list with its filters, the detail
 * with its allocations, voiding (the invoice open again), and the refusals:
 * a bad body, no entity, an over-allocation, an unknown payment.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { paymentsRoutes } from './index';
import { invoicesRoutes } from '../invoices';
import { accountingEntitiesRoutes } from '../accounting-entities';

let db: Database;
let entityId: string;
let hoog: string;

interface Result {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  error?: { message: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(mount: string, routes: Hono<any>, path: string, opts: { method?: string; body?: unknown; entityId?: string | null } = {}): Promise<Result> {
  const { request } = createTestApp(mount, routes, { context: { permissions: permissions('*'), tenantDb: db } });
  const id = opts.entityId === undefined ? entityId : opts.entityId;
  const res = await request(path, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(id ? { 'X-Accounting-Entity-Id': id } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = res.status === 204 ? '' : await res.text();
  const json = (text ? JSON.parse(text) : {}) as { data?: unknown; error?: { message: string } };
  return { status: res.status, data: json.data, error: json.error };
}

const payments = (path: string, opts: { method?: string; body?: unknown; entityId?: string | null } = {}) =>
  call('/api/payments', paymentsRoutes, `/api/payments${path}`, opts);
const invoices = (path: string, opts: { method?: string; body?: unknown } = {}) =>
  call('/api/invoices', invoicesRoutes, `/api/invoices${path}`, opts);

async function finalizedInvoice() {
  const created = await invoices('', {
    method: 'POST',
    body: { contactId: 'pty_pay', issueDate: '2026-07-10', dueDate: '2099-12-31', items: [{ description: 'Work', unitPrice: '100', taxRateId: hoog }] },
  });
  expect(created.status).toBe(201);
  expect((await invoices(`/${created.data.id}/finalize`, { method: 'POST' })).status).toBe(200);
  return created.data.id as string;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.parties).values({ id: 'pty_pay', displayName: 'Betaler BV', role: 'customer' });
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    entityId: null,
    body: {
      name: 'Payments BV',
      jurisdictionCode: 'NL',
      vatNumber: 'NL123456789B01',
      taxIdentifiers: { registrationNumber: '12345678' },
      bankDetails: { iban: 'NL91ABNA0417164300' },
      address: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' },
    },
  });
  expect(created.status).toBe(201);
  entityId = created.data.id;
  const rates = await db.select().from(schema.taxRates).where(eq(schema.taxRates.entityId, entityId));
  hoog = rates.find((r) => r.name === 'BTW Hoog 21%')!.id;
}, 60_000);

describe('/api/payments', () => {
  it('records, lists, reads and voids a payment', async () => {
    const invoiceId = await finalizedInvoice();
    const created = await payments('', {
      method: 'POST',
      body: { type: 'received', amount: '121', date: '2026-07-15', invoiceId, contactId: 'pty_pay', paymentMethod: 'bank_transfer', reference: 'TRX-1' },
    });
    expect(created.status).toBe(201);
    expect(created.data.journalEntryId).toBeTruthy();
    expect((await invoices(`/${invoiceId}`)).data.status).toBe('paid');

    const listed = await payments('?type=received&search=TRX&deposited=false&from=2026-07-01&to=2026-07-31');
    expect(listed.status).toBe(200);
    expect(listed.data.map((p: { id: string }) => p.id)).toContain(created.data.id);
    expect((await payments('?pageSize=1&page=1')).status).toBe(200);
    expect((await payments('', { entityId: null })).data).toEqual([]);

    const detail = await payments(`/${created.data.id}`);
    expect(detail.status).toBe(200);
    expect(detail.data.allocations).toHaveLength(1);

    expect((await payments(`/${created.data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await payments(`/${created.data.id}`)).status).toBe(404);
    expect((await invoices(`/${invoiceId}`)).data.balanceDue).toBe('121.00');
  });

  it('settles several invoices through allocations', async () => {
    const first = await finalizedInvoice();
    const second = await finalizedInvoice();
    const created = await payments('', {
      method: 'POST',
      body: {
        type: 'received',
        amount: '150',
        date: '2026-07-16',
        contactId: 'pty_pay',
        allocations: [
          { invoiceId: first, amount: '121' },
          { invoiceId: second, amount: '29' },
        ],
      },
    });
    expect(created.status).toBe(201);
    expect((await invoices(`/${second}`)).data.balanceDue).toBe('92.00');
  });

  it('refuses a bad body, no entity, an over-allocation and an unknown payment', async () => {
    expect((await payments('', { method: 'POST', body: { type: 'gift', amount: '1', date: '2026-07-16' } })).status).toBe(400);
    expect((await payments('', { method: 'POST', entityId: null, body: { type: 'received', amount: '1', date: '2026-07-16' } })).status).toBe(400);
    const invoiceId = await finalizedInvoice();
    const over = await payments('', {
      method: 'POST',
      body: { type: 'received', amount: '500', date: '2026-07-16', contactId: 'pty_pay', allocations: [{ invoiceId, amount: '500' }] },
    });
    expect(over.status).toBe(400);
    expect((await payments('/pay_missing')).status).toBe(404);
    expect((await payments('/pay_missing', { method: 'DELETE' })).status).toBe(404);
  });
});
