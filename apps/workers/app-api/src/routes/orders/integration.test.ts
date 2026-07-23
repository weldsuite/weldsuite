/**
 * DB-backed integration tests for /api/orders.
 *
 * Route now auto-generates `orderNumber` when missing (DB requires it
 * NOT NULL but Zod marks it optional).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { ordersRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/orders · pglite integration', () => {
  it('POST / writes an order and auto-generates orderNumber', async () => {
    const { request } = createTestApp('/api/orders', ordersRoutes, {
      context: { permissions: permissions('orders:create'), tenantDb: db },
    });

    const res = await request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currency: 'EUR',
        total: 199.99,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^ord_/);

    const [row] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, body.data.id))
      .limit(1);
    expect(row?.orderNumber).toMatch(/^ORD-/);
    expect(row?.currency).toBe('EUR');
  });

  it('POST / accepts an explicit orderNumber', async () => {
    const { request } = createTestApp('/api/orders', ordersRoutes, {
      context: { permissions: permissions('orders:create'), tenantDb: db },
    });
    const res = await request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumber: 'PO-CUSTOM-42' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    const [row] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, body.data.id))
      .limit(1);
    expect(row?.orderNumber).toBe('PO-CUSTOM-42');
  });

  it('GET /:id returns 404 for missing order', async () => {
    const { request } = createTestApp('/api/orders', ordersRoutes, {
      context: { permissions: permissions('orders:read'), tenantDb: db },
    });
    const res = await request('/api/orders/ord_missing');
    expect(res.status).toBe(404);
  });
});
