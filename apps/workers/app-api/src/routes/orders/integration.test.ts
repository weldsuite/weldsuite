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

  it('GET /:id/items returns the order line items', async () => {
    const { request } = createTestApp('/api/orders', ordersRoutes, {
      context: { permissions: permissions('orders:create', 'orders:read'), tenantDb: db },
    });

    const created = await request('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumber: 'ORD-ITEMS-1', currency: 'EUR' }),
    });
    const { data: order } = (await created.json()) as { data: { id: string } };

    await db.insert(schema.orderItems).values([
      {
        id: 'oit_a',
        orderId: order.id,
        name: 'Widget',
        sku: 'WID-1',
        quantity: 2,
        unitPrice: '10.00',
        total: '20.00',
      },
      {
        id: 'oit_b',
        orderId: order.id,
        name: 'Gadget',
        quantity: 1,
        unitPrice: '5.50',
        total: '5.50',
      },
    ]);

    const res = await request(`/api/orders/${order.id}/items`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; name: string }> };
    expect(body.data).toHaveLength(2);
    // Ordered by id, so insertion order is stable.
    expect(body.data.map((i) => i.name)).toEqual(['Widget', 'Gadget']);
  });

  it('GET /:id/items 404s for a missing order rather than returning an empty list', async () => {
    const { request } = createTestApp('/api/orders', ordersRoutes, {
      context: { permissions: permissions('orders:read'), tenantDb: db },
    });
    const res = await request('/api/orders/ord_missing/items');
    expect(res.status).toBe(404);
  });

  it('GET /:id/items is gated on orders:read', async () => {
    const { request } = createTestApp('/api/orders', ordersRoutes, {
      context: { permissions: permissions('orders:create'), tenantDb: db },
    });
    const res = await request('/api/orders/ord_anything/items');
    expect(res.status).toBe(403);
  });
});
