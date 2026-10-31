/**
 * The order routes the tax tests leave out, on pglite: the list (filters,
 * search, keyset paging, the limit), a fetch, updates without tax, the
 * soft delete, validation and the permission gates. Runs against Rust in
 * conformance mode (`rust/conformance/suites.json`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { ordersRoutes } from './index';

let db: Database;

const json = { 'Content-Type': 'application/json' };
const ALL = ['orders:read', 'orders:create', 'orders:update', 'orders:delete'];

function app(...keys: string[]) {
  return createTestApp('/api/orders', ordersRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute));
  await db.insert(schema.orders).values([
    { id: 'ord_l1', orderNumber: 'WEB-1001', status: 'pending', fulfillmentStatus: 'unfulfilled', customerId: 'cus_a', total: '10.00', createdAt: at(1) },
    { id: 'ord_l2', orderNumber: 'WEB-1002', status: 'paid', fulfillmentStatus: 'fulfilled', customerId: 'cus_a', total: '20.00', createdAt: at(2) },
    { id: 'ord_l3', orderNumber: 'POS-2001', status: 'pending', fulfillmentStatus: 'unfulfilled', customerId: 'cus_b', total: '30.00', createdAt: at(3) },
    { id: 'ord_l4', orderNumber: 'POS-2002', status: 'cancelled', customerId: 'cus_b', total: '40.00', createdAt: at(4) },
    { id: 'ord_l5', orderNumber: 'WEB-1003', status: 'pending', customerId: 'cus_c', total: '50.00', createdAt: at(5), deletedAt: at(6) },
  ]);
}, 60_000);

describe('GET /api/orders', () => {
  it('lists live orders newest first, with the count', async () => {
    const res = await app('orders:read').request('/api/orders');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: { totalCount: number; hasMore: boolean } };
    expect(body.data.map((o) => o.id)).toEqual(['ord_l4', 'ord_l3', 'ord_l2', 'ord_l1']);
    expect(body.pagination).toMatchObject({ totalCount: 4, hasMore: false });
  });

  it('filters by customer, status, fulfillment status and order number', async () => {
    const { request } = app('orders:read');
    const ids = async (query: string) =>
      ((await (await request(`/api/orders?${query}`)).json()) as { data: Array<{ id: string }> }).data.map((o) => o.id);
    expect(await ids('customerId=cus_a')).toEqual(['ord_l2', 'ord_l1']);
    expect(await ids('status=pending')).toEqual(['ord_l3', 'ord_l1']);
    expect(await ids('fulfillmentStatus=unfulfilled')).toEqual(['ord_l4', 'ord_l3', 'ord_l1']);
    expect(await ids('search=POS')).toEqual(['ord_l4', 'ord_l3']);
    expect(await ids('search=WEB&status=paid')).toEqual(['ord_l2']);
    expect(await ids('status=')).toEqual(['ord_l4', 'ord_l3', 'ord_l2', 'ord_l1']);
  });

  it('pages with a cursor; the count ignores it', async () => {
    const { request } = app('orders:read');
    const first = (await (await request('/api/orders?limit=2')).json()) as {
      data: Array<{ id: string }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(first.data.map((o) => o.id)).toEqual(['ord_l4', 'ord_l3']);
    expect(first.pagination).toEqual({ totalCount: 4, hasMore: true, cursor: 'ord_l3' });

    const second = (await (await request(`/api/orders?limit=2&cursor=${first.pagination.cursor}`)).json()) as {
      data: Array<{ id: string }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(second.data.map((o) => o.id)).toEqual(['ord_l2', 'ord_l1']);
    expect(second.pagination).toEqual({ totalCount: 4, hasMore: false, cursor: null });

    // An unknown cursor starts from the top.
    const unknown = (await (await request('/api/orders?limit=1&cursor=ord_gone')).json()) as { data: Array<{ id: string }> };
    expect(unknown.data.map((o) => o.id)).toEqual(['ord_l4']);
  });

  it('caps the limit at 100 and reads a bad one as no limit', async () => {
    const { request } = app('orders:read');
    expect((await request('/api/orders?limit=500')).status).toBe(200);
    const bad = (await (await request('/api/orders?limit=abc')).json()) as { data: unknown[] };
    expect(bad.data).toHaveLength(4);
  });

  it('is gated on orders:read', async () => {
    expect((await app('orders:create').request('/api/orders')).status).toBe(403);
  });
});

describe('GET /api/orders/:id', () => {
  it('returns a live order, and 404 for a deleted one', async () => {
    const { request } = app('orders:read');
    const res = await request('/api/orders/ord_l2');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { orderNumber: string } }).data.orderNumber).toBe('WEB-1002');
    expect((await request('/api/orders/ord_l5')).status).toBe(404);
  });
});

describe('POST and PATCH /api/orders', () => {
  it('creates an order with passthrough columns', async () => {
    const res = await app().request('/api/orders', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        orderNumber: 'WEB-1100',
        status: 'pending',
        currency: 'EUR',
        subtotal: '12.50',
        total: 15,
        customerEmail: 'buyer@example.com',
        internalNote: 'gift',
        shippingAddress: { line1: 'Damrak 1', city: 'Amsterdam', country: 'NL' },
        metadata: { channel: 'web' },
      }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, data.id));
    expect(row).toMatchObject({ orderNumber: 'WEB-1100', total: '15.00', subtotal: '12.50', internalNote: 'gift' });
  });

  it('refuses a body that does not fit the schema', async () => {
    const { request } = app();
    const post = (body: unknown) => request('/api/orders', { method: 'POST', headers: json, body: JSON.stringify(body) });
    expect((await post({ status: 'x'.repeat(31) })).status).toBe(400);
    expect((await post({ total: true })).status).toBe(400);
    expect((await post({ customerId: 42 })).status).toBe(400);
    expect((await post({ orderNumber: 'x'.repeat(101) })).status).toBe(400);
  });

  it('a timestamp in the body is a 500, as Drizzle cannot write a string to it', async () => {
    const res = await app().request('/api/orders', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ orderNumber: 'WEB-1101', paidAt: '2026-01-01T00:00:00.000Z' }),
    });
    expect(res.status).toBe(500);
  });

  it('updates an order and publishes the stored values it did not change', async () => {
    const { request } = app();
    const res = await request('/api/orders/ord_l3', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 'paid', total: '31.00', customerNote: 'leave at door' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'ord_l3' } });
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, 'ord_l3'));
    expect(row).toMatchObject({ status: 'paid', total: '31.00', customerNote: 'leave at door' });

    // A null clears the column; the event still reads the stored status.
    const cleared = await request('/api/orders/ord_l3', { method: 'PATCH', headers: json, body: JSON.stringify({ customerId: null, currency: 'USD' }) });
    expect(cleared.status).toBe(200);
    const [after] = await db.select().from(schema.orders).where(eq(schema.orders.id, 'ord_l3'));
    expect(after).toMatchObject({ customerId: null, currency: 'USD', status: 'paid' });
  });

  it('answers 404 for a missing order', async () => {
    const res = await app().request('/api/orders/ord_missing', { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'paid' }) });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/orders/:id', () => {
  it('soft-deletes an order, then 404s', async () => {
    const { request } = app();
    const res = await request('/api/orders/ord_l4', { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, 'ord_l4'));
    expect(row?.deletedAt).not.toBeNull();
    expect((await request('/api/orders/ord_l4', { method: 'DELETE' })).status).toBe(404);
  });

  it('is gated on orders:delete', async () => {
    expect((await app('orders:update').request('/api/orders/ord_l1', { method: 'DELETE' })).status).toBe(403);
  });
});
