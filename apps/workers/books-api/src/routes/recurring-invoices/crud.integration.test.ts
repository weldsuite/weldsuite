/**
 * /api/recurring-invoices on a Dutch entity: create, list, read, update
 * (PUT and PATCH), pause and resume, generate (the period claimed once,
 * finalized when the schedule says so), delete, and the refusals.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { recurringInvoicesRoutes } from './index';
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

const recurring = (path: string, opts: { method?: string; body?: unknown; entityId?: string | null } = {}) =>
  call('/api/recurring-invoices', recurringInvoicesRoutes, `/api/recurring-invoices${path}`, opts);

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.parties).values({
    id: 'pty_rec',
    displayName: 'Abonnee BV',
    role: 'customer',
    billingAddress: { line1: 'Damrak 2', city: 'Amsterdam', postalCode: '1012 LG', country: 'NL' },
  });
  const created = await call('/api/accounting-entities', accountingEntitiesRoutes, '/api/accounting-entities', {
    method: 'POST',
    entityId: null,
    body: {
      name: 'Recurring BV',
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

describe('/api/recurring-invoices', () => {
  it('creates, lists, reads, updates, pauses and resumes a schedule', async () => {
    const created = await recurring('', {
      method: 'POST',
      body: {
        name: 'Hosting',
        contactId: 'pty_rec',
        frequency: 'monthly',
        dayOfMonth: 1,
        nextIssueDate: '2026-08-01',
        endDate: '2027-07-31',
        autoFinalize: false,
        templateData: { items: [{ description: 'Hosting', quantity: 1, unitPrice: 25, taxRateId: hoog }], paymentTermsDays: 14, reference: 'HOST' },
      },
    });
    expect(created.status).toBe(201);
    const id = created.data.id as string;
    expect(created.data.status).toBe('active');

    const listed = await recurring('');
    expect(listed.status).toBe(200);
    expect(listed.data.map((r: { id: string }) => r.id)).toContain(id);
    expect((await recurring(`/${id}`)).data.name).toBe('Hosting');

    const put = await recurring(`/${id}`, { method: 'PUT', body: { name: 'Hosting plus', endDate: '2027-12-31' } });
    expect(put.status).toBe(200);
    expect(put.data.name).toBe('Hosting plus');
    const patched = await recurring(`/${id}`, { method: 'PATCH', body: { frequency: 'quarterly', nextIssueDate: '2026-09-01' } });
    expect(patched.status).toBe(200);

    expect((await recurring(`/${id}/pause`, { method: 'PATCH' })).data.status).toBe('paused');
    expect((await recurring(`/${id}/generate`, { method: 'POST' })).status).toBe(400);
    expect((await recurring(`/${id}/resume`, { method: 'PATCH' })).data.status).toBe('active');

    const generated = await recurring(`/${id}/generate`, { method: 'POST' });
    expect(generated.status).toBe(201);
    expect(generated.data.status).toBe('active');
    expect(generated.data.journalEntryId).toBeNull();
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, generated.data.invoiceId));
    expect(invoice?.total).toBe('30.25');
    expect(invoice?.recurringInvoiceId).toBe(id);

    expect((await recurring(`/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await recurring(`/${id}`)).status).toBe(404);
  });

  it('finalizes the generated invoice of an auto-finalizing schedule and completes at the end date', async () => {
    const created = await recurring('', {
      method: 'POST',
      body: {
        contactId: 'pty_rec',
        frequency: 'yearly',
        nextIssueDate: '2026-08-01',
        endDate: '2026-12-31',
        autoFinalize: true,
        templateData: { items: [{ description: 'Licence', quantity: 2, unitPrice: 100, taxRateId: hoog }] },
      },
    });
    const generated = await recurring(`/${created.data.id}/generate`, { method: 'POST' });
    expect(generated.status).toBe(201);
    expect(generated.data.status).toBe('completed');
    expect(generated.data.journalEntryId).toBeTruthy();
    expect(generated.data.finalizeError).toBeNull();
    expect((await recurring(`/${created.data.id}/generate`, { method: 'POST' })).status).toBe(400);
  });

  it('refuses a bad body, no entity and an unknown schedule', async () => {
    expect((await recurring('', { method: 'POST', body: { contactId: 'pty_rec', frequency: 'daily', nextIssueDate: '2026-08-01' } })).status).toBe(400);
    expect((await recurring('', { method: 'POST', entityId: null, body: { contactId: 'pty_rec', frequency: 'monthly', nextIssueDate: '2026-08-01' } })).status).toBe(400);
    expect((await recurring('', { entityId: null })).status).toBe(400);
    for (const [path, method] of [
      ['', 'GET'],
      ['', 'PUT'],
      ['', 'DELETE'],
      ['/pause', 'PATCH'],
      ['/resume', 'PATCH'],
      ['/generate', 'POST'],
    ] as const) {
      const res = await recurring(`/ri_missing${path}`, { method, body: method === 'PUT' ? { name: 'x' } : undefined });
      expect(res.status).toBe(404);
    }
  });
});
