/**
 * Invoice create defaults currency to the accounting entity's baseCurrency
 * (INR for India) when the client omits it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { invoicesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

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
});
