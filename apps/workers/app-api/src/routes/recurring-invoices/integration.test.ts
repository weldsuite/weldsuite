/**
 * Recurring-invoice generate preserves templateData.currency (USD / INR)
 * instead of rewriting it to the entity base currency.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { recurringInvoicesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seedRecurring(opts: {
  entityId: string;
  recurringId: string;
  currency: string;
  baseCurrency: string;
}) {
  await db.insert(schema.entities).values({
    id: opts.entityId,
    name: `${opts.currency} Recurring Co`,
    jurisdictionCode: opts.baseCurrency === 'INR' ? 'IN' : 'US',
    baseCurrency: opts.baseCurrency,
    locale: opts.baseCurrency === 'INR' ? 'en-IN' : 'en-US',
  });

  await db.insert(schema.recurringInvoices).values({
    id: opts.recurringId,
    entityId: opts.entityId,
    name: `${opts.currency} retainer`,
    contactId: 'ctt_recurring',
    frequency: 'monthly',
    nextIssueDate: new Date('2026-05-01'),
    status: 'active',
    templateData: {
      currency: opts.currency,
      items: [{ description: 'Retainer', quantity: 1, unitPrice: 100 }],
    },
  });
}

describe('/api/recurring-invoices · template currency', () => {
  it('POST /:id/generate preserves USD on the created invoice', async () => {
    await seedRecurring({
      entityId: 'ent_usd_rec',
      recurringId: 'ri_usd',
      currency: 'USD',
      baseCurrency: 'EUR',
    });

    const { request } = createTestApp('/api/recurring-invoices', recurringInvoicesRoutes, {
      context: { permissions: permissions('invoices:create'), tenantDb: db },
    });

    const res = await request('/api/recurring-invoices/ri_usd/generate', {
      method: 'POST',
      headers: { 'X-Accounting-Entity-Id': 'ent_usd_rec' },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { invoiceId: string } };
    const [invoice] = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, body.data.invoiceId))
      .limit(1);
    expect(invoice?.currency).toBe('USD');
  });

  it('POST /:id/generate preserves INR on the created invoice', async () => {
    await seedRecurring({
      entityId: 'ent_inr_rec',
      recurringId: 'ri_inr',
      currency: 'INR',
      baseCurrency: 'EUR',
    });

    const { request } = createTestApp('/api/recurring-invoices', recurringInvoicesRoutes, {
      context: { permissions: permissions('invoices:create'), tenantDb: db },
    });

    const res = await request('/api/recurring-invoices/ri_inr/generate', {
      method: 'POST',
      headers: { 'X-Accounting-Entity-Id': 'ent_inr_rec' },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { invoiceId: string } };
    const [invoice] = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, body.data.invoiceId))
      .limit(1);
    expect(invoice?.currency).toBe('INR');
  });
});
