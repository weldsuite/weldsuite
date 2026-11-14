/**
 * Invoice create defaults currency to the accounting entity's baseCurrency
 * (INR for India) when the client omits it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { invoicesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/invoices · entity base currency', () => {
  it('POST / stores INR when the entity baseCurrency is INR and currency is omitted', async () => {
    await db.insert(schema.entities).values({
      id: 'ent_inr_inv',
      name: 'INR Invoice Co',
      jurisdictionCode: 'IN',
      baseCurrency: 'INR',
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
    });
    await db.insert(schema.accountingEntitySettings).values({ entityId: 'ent_inr_inv' });

    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions('invoices:create'), tenantDb: db },
    });

    const res = await request('/api/invoices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Accounting-Entity-Id': 'ent_inr_inv',
      },
      body: JSON.stringify({
        contactId: 'ctt_inr',
        issueDate: '2026-04-01',
        dueDate: '2026-04-15',
        items: [{ description: 'Consulting', quantity: '1', unitPrice: '1500.00' }],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; currency?: string } };
    expect(body.data.currency).toBe('INR');

    const [row] = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, body.data.id))
      .limit(1);
    expect(row?.currency).toBe('INR');
  });

  it('POST / keeps an explicit USD currency even on an INR entity', async () => {
    await db.insert(schema.entities).values({
      id: 'ent_inr_usd',
      name: 'INR USD Invoice Co',
      jurisdictionCode: 'IN',
      baseCurrency: 'INR',
      locale: 'en-IN',
    });
    await db.insert(schema.accountingEntitySettings).values({ entityId: 'ent_inr_usd' });

    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions('invoices:create'), tenantDb: db },
    });

    const res = await request('/api/invoices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Accounting-Entity-Id': 'ent_inr_usd',
      },
      body: JSON.stringify({
        contactId: 'ctt_inr',
        issueDate: '2026-04-01',
        dueDate: '2026-04-15',
        currency: 'USD',
        items: [{ description: 'Export', quantity: '1', unitPrice: '100.00' }],
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, body.data.id))
      .limit(1);
    expect(row?.currency).toBe('USD');
  });

  it('POST / stores paid, sent, and overdue instead of forcing draft', async () => {
    await db.insert(schema.entities).values({
      id: 'ent_status_inv',
      name: 'Status Invoice Co',
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
      locale: 'nl-NL',
      timezone: 'Europe/Amsterdam',
    });
    await db.insert(schema.accountingEntitySettings).values({ entityId: 'ent_status_inv' });

    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions('invoices:create'), tenantDb: db },
    });

    for (const status of ['paid', 'sent', 'overdue'] as const) {
      const res = await request('/api/invoices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Accounting-Entity-Id': 'ent_status_inv',
        },
        body: JSON.stringify({
          contactId: 'ctt_status',
          issueDate: '2026-04-01',
          dueDate: '2026-10-04',
          status,
          items: [{ description: 'Work', quantity: '1', unitPrice: '10.00' }],
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string; status: string } };
      expect(body.data.status).toBe(status);

      const [row] = await db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.id, body.data.id))
        .limit(1);
      expect(row?.status).toBe(status);
    }

    const omitted = await request('/api/invoices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Accounting-Entity-Id': 'ent_status_inv',
      },
      body: JSON.stringify({
        contactId: 'ctt_status',
        issueDate: '2026-04-01',
        dueDate: '2026-10-04',
        items: [{ description: 'Work', quantity: '1', unitPrice: '10.00' }],
      }),
    });
    expect(omitted.status).toBe(201);
    const omittedBody = (await omitted.json()) as { data: { status: string } };
    expect(omittedBody.data.status).toBe('draft');
  });
});

describe('/api/invoices · contact email', () => {
  it('GET /:id gives the customer email added after the invoice was created', async () => {
    await db.insert(schema.entities).values({
      id: 'ent_late_email',
      name: 'Late Email Co',
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
      locale: 'nl-NL',
    });
    await db.insert(schema.accountingEntitySettings).values({ entityId: 'ent_late_email' });
    await db.insert(schema.companies).values({ id: 'cmp_late_email', name: 'Late Email BV', displayName: 'Late Email BV' });
    await db.insert(schema.parties).values({
      id: 'pty_late_email',
      kind: 'company',
      companyId: 'cmp_late_email',
      displayName: 'Late Email BV',
      role: 'customer',
    });

    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions('invoices:create', 'invoices:read'), tenantDb: db },
    });
    const headers = { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': 'ent_late_email' };
    const created = await request('/api/invoices', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contactId: 'pty_late_email',
        issueDate: '2026-04-01',
        dueDate: '2026-04-15',
        items: [{ description: 'Work', quantity: '1', unitPrice: '10.00' }],
      }),
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    // No address yet: the invoice is stored without one.
    const [stored] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id)).limit(1);
    expect(stored?.contactEmail).toBeNull();

    await db.update(schema.companies).set({ email: 'billing@late-email.example' }).where(eq(schema.companies.id, 'cmp_late_email'));

    const res = await request(`/api/invoices/${id}`, { headers });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { contactEmail: string | null } };
    expect(body.data.contactEmail).toBe('billing@late-email.example');
  });
});

describe('/api/invoices · list', () => {
  it('GET / names the invoice each credit note credits', async () => {
    await db.insert(schema.entities).values({
      id: 'ent_cn_list',
      name: 'Credit Note List Co',
      jurisdictionCode: 'NL',
      baseCurrency: 'EUR',
      locale: 'nl-NL',
    });
    await db.insert(schema.accountingEntitySettings).values({ entityId: 'ent_cn_list' });

    const { request } = createTestApp('/api/invoices', invoicesRoutes, {
      context: { permissions: permissions('invoices:create', 'invoices:read'), tenantDb: db },
    });
    const create = async (extra: Record<string, unknown>) => {
      const res = await request('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Accounting-Entity-Id': 'ent_cn_list' },
        body: JSON.stringify({
          contactId: 'ctt_cn',
          issueDate: '2026-04-01',
          dueDate: '2026-04-15',
          items: [{ description: 'Work', quantity: '1', unitPrice: '10.00' }],
          ...extra,
        }),
      });
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { id: string } }).data.id;
    };

    const sourceId = await create({});
    await db.update(schema.invoices).set({ invoiceNumber: 'INV-CN-SRC' }).where(eq(schema.invoices.id, sourceId));
    await create({ type: 'credit_note', creditNoteForInvoiceId: sourceId });

    const res = await request('/api/invoices?type=credit_note', {
      headers: { 'X-Accounting-Entity-Id': 'ent_cn_list' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { creditNoteForInvoiceId: string | null; creditNoteForInvoiceNumber: string | null }[];
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ creditNoteForInvoiceId: sourceId, creditNoteForInvoiceNumber: 'INV-CN-SRC' });
  });
});
