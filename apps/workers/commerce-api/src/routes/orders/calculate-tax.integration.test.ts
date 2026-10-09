/**
 * DB-backed integration tests for the order sales tax endpoints
 * (`POST /api/orders/calculate-tax`, `POST /api/orders/:id/calculate-tax` and
 * the `calculateTax` flag of `POST` / `PATCH /api/orders`), through the
 * WeldBooks manual engine on pglite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ordersRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  CA_ADDRESS,
  ENCRYPTION_KEY,
  ENTITIES,
  TX_ADDRESS,
  seedTaxWorkspace,
} from '../../services/order-sales-tax-fixtures';

let db: Database;
let close: () => Promise<void>;
let sequence = 0;

const json = { 'Content-Type': 'application/json' };

function app(...keys: string[]) {
  const events: Array<{ eventType: string; entityId: string; data: Record<string, unknown> }> = [];
  const harness = createTestApp('/api/orders', ordersRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db },
    env: {
      DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY,
      ENTITY_EVENTS: { send: async (message: (typeof events)[number]) => void events.push(message) } as unknown as Queue,
    },
  });
  return { ...harness, events };
}

function post(request: ReturnType<typeof app>['request'], path: string, body: unknown) {
  return request(path, { method: 'POST', headers: json, body: JSON.stringify(body) });
}

async function setDefaultEntity(entityId: string) {
  await db.update(schema.settings).set({ defaultEntityId: entityId });
}

/** An order of 2 mugs at 50.00 (taxable) and one donation at 50.00 (non_taxable) plus 10.00 shipping, to Austin. */
async function seedOrder(extra: Partial<typeof schema.orders.$inferInsert> = {}) {
  sequence += 1;
  const id = `ord_tax_${sequence}`;
  await db.insert(schema.orders).values({
    id,
    orderNumber: `TAX-${sequence}`,
    status: 'pending',
    paymentStatus: 'pending',
    currency: 'USD',
    subtotal: '150.00',
    shippingTotal: '10.00',
    taxTotal: '0',
    total: '160.00',
    shippingAddress: TX_ADDRESS,
    metadata: { channel: 'pos' },
    ...extra,
  });
  await db.insert(schema.orderItems).values([
    { id: `${id}_a`, orderId: id, productId: 'prod_general', name: 'Mug', quantity: 2, unitPrice: '50.00', total: '100.00' },
    { id: `${id}_b`, orderId: id, productId: 'prod_exempt', name: 'Donation', quantity: 1, unitPrice: '50.00', total: '50.00' },
  ]);
  return id;
}

async function loadOrder(id: string) {
  const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, id)).limit(1);
  const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, id)).orderBy(schema.orderItems.id);
  return { order: order!, items };
}

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  close = handle.close;
  await seedTaxWorkspace(db);
}, 120_000);

afterAll(async () => {
  await close?.();
});

describe('POST /api/orders/calculate-tax (cart)', () => {
  const cart = {
    lines: [
      { lineId: 'mugs', productId: 'prod_general', amount: 100, quantity: 2 },
      { lineId: 'gift', productId: 'prod_exempt', amount: 50, quantity: 1 },
    ],
    shippingAmount: 10,
    shipTo: TX_ADDRESS,
    currency: 'USD',
    date: '2026-03-15',
  };

  it('prices a cart shipped within Texas: state and local tax, shipping included', async () => {
    const { request } = app('orders:create');
    const res = await post(request, '/api/orders/calculate-tax', cart);

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, any> };
    expect(data).toMatchObject({
      supported: true,
      engine: 'manual',
      entityId: ENTITIES.us,
      currency: 'USD',
      totalTax: 9.08,
      shippingTax: 0.83,
      shipToState: 'TX',
      shipToPostalCode: '78701',
      warnings: [],
    });
    expect(data.jurisdictions).toEqual([
      expect.objectContaining({ name: 'Texas', level: 'state', rate: 6.25, tax: 6.88 }),
      expect.objectContaining({ name: 'Austin', level: 'city', rate: 2, tax: 2.2 }),
    ]);
    expect(data.lines).toEqual([
      { lineId: 'mugs', taxCode: 'general', tax: 8.25, rate: 8.25, taxableAmount: 100, exemptAmount: 0, nonTaxableAmount: 0 },
      { lineId: 'gift', taxCode: 'non_taxable', tax: 0, rate: 0, taxableAmount: 0, exemptAmount: 0, nonTaxableAmount: 50 },
      { lineId: 'shipping', taxCode: 'shipping', tax: 0.83, rate: 8.25, taxableAmount: 10, exemptAmount: 0, nonTaxableAmount: 0 },
    ]);
  });

  it('charges nothing, with a warning, for a ship-to state the entity is not registered in', async () => {
    const { request } = app('orders:create');
    const res = await post(request, '/api/orders/calculate-tax', { ...cart, shipTo: CA_ADDRESS });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, any> };
    expect(data).toMatchObject({ supported: true, totalTax: 0, warnings: ['not_registered_in_state'], jurisdictions: [] });
  });

  it('does not store anything', async () => {
    const before = await db.select().from(schema.orders);
    const { request } = app('orders:create');
    await post(request, '/api/orders/calculate-tax', cart);
    expect(await db.select().from(schema.orders)).toHaveLength(before.length);
  });

  it('answers supported: false when the workspace default entity is not in the US', async () => {
    await setDefaultEntity(ENTITIES.nl);
    try {
      const { request } = app('orders:create');
      const res = await post(request, '/api/orders/calculate-tax', cart);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { supported: false, reason: 'sales_tax_not_supported', entityId: ENTITIES.nl } });
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }
  });

  it('answers 503 TAX_ENGINE_UNAVAILABLE rather than zero tax when the engine is not usable', async () => {
    await setDefaultEntity(ENTITIES.stripeNoCredentials);
    try {
      const { request } = app('orders:create');
      const res = await post(request, '/api/orders/calculate-tax', cart);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        error: { code: 'TAX_ENGINE_UNAVAILABLE', details: { reason: 'not_configured' } },
      });
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }
  });

  it('answers 422 for a tax code no engine knows', async () => {
    const { request } = app('orders:create');
    const res = await post(request, '/api/orders/calculate-tax', {
      ...cart,
      lines: [{ lineId: 'x', amount: 10, quantity: 1, taxCode: 'standard' }],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'TAX_REQUEST_INVALID' } });
  });

  it('validates the body', async () => {
    const { request } = app('orders:create');
    expect((await post(request, '/api/orders/calculate-tax', { shipTo: TX_ADDRESS })).status).toBe(400);
    expect(
      (await post(request, '/api/orders/calculate-tax', { ...cart, lines: [{ lineId: 'a', amount: -1, quantity: 1 }] })).status,
    ).toBe(400);
    expect((await post(request, '/api/orders/calculate-tax', { ...cart, date: '15/03/2026' })).status).toBe(400);
  });

  it('is gated on orders:create', async () => {
    const { request } = app('orders:read');
    expect((await post(request, '/api/orders/calculate-tax', cart)).status).toBe(403);
  });
});

describe('POST /api/orders/:id/calculate-tax (stored order)', () => {
  it('previews a stored order without writing it', async () => {
    const id = await seedOrder();
    const { request, events } = app('orders:read');
    const res = await post(request, `/api/orders/${id}/calculate-tax`, {});

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, any> };
    expect(data).toMatchObject({ supported: true, applied: false, totalTax: 9.08 });
    expect(data.order).toBeUndefined();

    const { order, items } = await loadOrder(id);
    expect(order).toMatchObject({ taxTotal: '0.00', total: '160.00' });
    expect(items.map((i) => i.taxAmount)).toEqual(['0.00', '0.00']);
    expect(events).toEqual([]);
  });

  it('applies the tax: tax lines, totals, item tax, engine detail and one updated event', async () => {
    const id = await seedOrder();
    const { request, events } = app('orders:read', 'orders:update');
    const res = await post(request, `/api/orders/${id}/calculate-tax`, { apply: true });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, any> };
    expect(data).toMatchObject({
      supported: true,
      applied: true,
      totalTax: 9.08,
      order: {
        id,
        taxTotal: '9.08',
        total: '169.08',
        taxLines: [
          { title: 'Texas', rate: 6.25, price: '6.88' },
          { title: 'Austin', rate: 2, price: '2.20' },
        ],
      },
    });

    const { order, items } = await loadOrder(id);
    expect(order).toMatchObject({ taxTotal: '9.08', total: '169.08' });
    expect(order.taxLines).toEqual([
      { title: 'Texas', rate: 6.25, price: '6.88' },
      { title: 'Austin', rate: 2, price: '2.20' },
    ]);
    expect(items.map((i) => i.taxAmount)).toEqual(['8.25', '0.00']);
    expect(order.metadata).toMatchObject({
      channel: 'pos',
      salesTax: {
        entityId: ENTITIES.us,
        engine: 'manual',
        totalTax: 9.08,
        shippingTax: 0.83,
        shipToState: 'TX',
        sourcing: 'origin',
        warnings: [],
      },
    });
    const stored = (order.metadata as { salesTax: { lines: Array<{ lineId: string; details: unknown[] }> } }).salesTax;
    expect(stored.lines.map((l) => l.lineId)).toEqual([`${id}_a`, `${id}_b`, 'shipping']);
    expect(stored.lines[0].details).toHaveLength(2);

    expect(events.map((e) => [e.eventType, e.entityId, e.data.total])).toEqual([['commerce_order:updated', id, '169.08']]);
  });

  it('keeps the total consistent when it is applied again after the tax changed', async () => {
    const id = await seedOrder({ taxTotal: '5.00', total: '165.00' });
    const { request } = app('orders:read', 'orders:update');
    await post(request, `/api/orders/${id}/calculate-tax`, { apply: true });
    await post(request, `/api/orders/${id}/calculate-tax`, { apply: true });
    expect((await loadOrder(id)).order).toMatchObject({ taxTotal: '9.08', total: '169.08' });
  });

  it('refuses to apply without orders:update, and still previews', async () => {
    const id = await seedOrder();
    const { request } = app('orders:read');

    expect((await post(request, `/api/orders/${id}/calculate-tax`, { apply: true })).status).toBe(403);
    expect((await loadOrder(id)).order.taxTotal).toBe('0.00');
    expect((await post(request, `/api/orders/${id}/calculate-tax`, { apply: false })).status).toBe(200);
  });

  it('freezes the tax of a paid order: applying is a 409, previewing still works', async () => {
    const id = await seedOrder({ paymentStatus: 'paid', paidAt: new Date() });
    const { request } = app('orders:read', 'orders:update');

    const applied = await post(request, `/api/orders/${id}/calculate-tax`, { apply: true });
    expect(applied.status).toBe(409);
    expect(await applied.json()).toMatchObject({ error: { code: 'ORDER_TAX_LOCKED' } });
    expect((await loadOrder(id)).order.taxTotal).toBe('0.00');

    const preview = await post(request, `/api/orders/${id}/calculate-tax`, {});
    expect(preview.status).toBe(200);
  });

  it('leaves the order alone when the default entity does no sales tax', async () => {
    const id = await seedOrder({ taxTotal: '3.00', total: '163.00' });
    await setDefaultEntity(ENTITIES.nl);
    try {
      const { request, events } = app('orders:read', 'orders:update');
      const res = await post(request, `/api/orders/${id}/calculate-tax`, { apply: true });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { supported: false, reason: 'sales_tax_not_supported', entityId: ENTITIES.nl, applied: false },
      });
      expect((await loadOrder(id)).order).toMatchObject({ taxTotal: '3.00', total: '163.00', taxLines: null });
      expect(events).toEqual([]);
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }
  });

  it('writes nothing when the engine is unavailable', async () => {
    const id = await seedOrder();
    await setDefaultEntity(ENTITIES.stripeNoCredentials);
    try {
      const { request, events } = app('orders:read', 'orders:update');
      const res = await post(request, `/api/orders/${id}/calculate-tax`, { apply: true });

      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: 'TAX_ENGINE_UNAVAILABLE' } });
      expect((await loadOrder(id)).order).toMatchObject({ taxTotal: '0.00', total: '160.00' });
      expect(events).toEqual([]);
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }
  });

  it('uses the buyer certificate of the order counterparty', async () => {
    await db.insert(schema.parties).values({ id: 'pty_order_resale', kind: 'company', displayName: 'Reseller', role: 'customer' });
    await db.insert(schema.exemptionCertificates).values({
      id: 'cert_order_resale',
      entityId: ENTITIES.us,
      partyId: 'pty_order_resale',
      states: ['TX'],
      reason: 'resale',
      issuedOn: '2025-01-01',
      expiresOn: '2030-12-31',
      status: 'valid',
    });
    const id = await seedOrder({ counterpartyId: 'pty_order_resale' });

    const { request } = app('orders:read', 'orders:update');
    const res = await post(request, `/api/orders/${id}/calculate-tax`, { apply: true });
    const { data } = (await res.json()) as { data: Record<string, any> };

    expect(data).toMatchObject({ totalTax: 0, order: { taxTotal: '0.00', total: '160.00', taxLines: [] } });
    expect(data.lines[0]).toMatchObject({ tax: 0, exemptAmount: 100 });
  });

  it('answers 404 for a missing or deleted order', async () => {
    const { request } = app('orders:read', 'orders:update');
    expect((await post(request, '/api/orders/ord_missing/calculate-tax', {})).status).toBe(404);

    const id = await seedOrder({ deletedAt: new Date() });
    expect((await post(request, `/api/orders/${id}/calculate-tax`, {})).status).toBe(404);
  });

  it('is gated on orders:read', async () => {
    const { request } = app('orders:create');
    expect((await post(request, '/api/orders/ord_any/calculate-tax', {})).status).toBe(403);
  });
});

describe('calculateTax flag on POST and PATCH /api/orders', () => {
  it('POST taxes an order created with totals only: the subtotal as one line, plus shipping', async () => {
    const { request, events } = app('orders:create');
    const res = await post(request, '/api/orders', {
      orderNumber: 'TAX-CREATE-1',
      currency: 'USD',
      subtotal: 100,
      shippingTotal: 10,
      shippingAddress: TX_ADDRESS,
      calculateTax: true,
    });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; tax: Record<string, any> } };
    expect(data.tax).toMatchObject({ supported: true, totalTax: 9.08, warnings: ['no_line_items'] });

    const { order } = await loadOrder(data.id);
    expect(order).toMatchObject({ orderNumber: 'TAX-CREATE-1', taxTotal: '9.08', total: '119.08' });
    expect(order.taxLines).toEqual([
      { title: 'Texas', rate: 6.25, price: '6.88' },
      { title: 'Austin', rate: 2, price: '2.20' },
    ]);
    expect(order.metadata).toMatchObject({ salesTax: { engine: 'manual', warnings: ['no_line_items'] } });
    expect(events.map((e) => [e.eventType, e.data.total])).toEqual([['commerce_order:created', '119.08']]);
  });

  it('POST without the flag leaves tax alone', async () => {
    const { request } = app('orders:create');
    const res = await post(request, '/api/orders', { orderNumber: 'TAX-CREATE-2', subtotal: 100, taxTotal: 7, total: 107, shippingAddress: TX_ADDRESS });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(data)).toEqual(['id']);
    const { order } = await loadOrder(data.id as string);
    expect(order).toMatchObject({ taxTotal: '7.00', total: '107.00', taxLines: null });
  });

  it('POST creates nothing when the engine is unavailable', async () => {
    await setDefaultEntity(ENTITIES.stripeNoCredentials);
    try {
      const { request, events } = app('orders:create');
      const res = await post(request, '/api/orders', {
        orderNumber: 'TAX-CREATE-3',
        subtotal: 100,
        shippingAddress: TX_ADDRESS,
        calculateTax: true,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: 'TAX_ENGINE_UNAVAILABLE' } });
      expect(await db.select().from(schema.orders).where(eq(schema.orders.orderNumber, 'TAX-CREATE-3'))).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }
  });

  it('POST stores the order untouched when the default entity does no sales tax', async () => {
    await setDefaultEntity(ENTITIES.nl);
    try {
      const { request } = app('orders:create');
      const res = await post(request, '/api/orders', {
        orderNumber: 'TAX-CREATE-4',
        subtotal: 100,
        taxTotal: 21,
        total: 121,
        calculateTax: true,
      });
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { id: string; tax: Record<string, unknown> } };
      expect(data.tax).toMatchObject({ supported: false });
      expect((await loadOrder(data.id)).order).toMatchObject({ taxTotal: '21.00', total: '121.00' });
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }
  });

  it('PATCH recalculates from the new address and the stored items', async () => {
    const id = await seedOrder();
    const { request } = app('orders:update');

    const first = await request(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ internalNote: 'check address', calculateTax: true }),
    });
    expect(first.status).toBe(200);
    expect((await loadOrder(id)).order).toMatchObject({ internalNote: 'check address', taxTotal: '9.08', total: '169.08' });
    expect((await loadOrder(id)).items.map((i) => i.taxAmount)).toEqual(['8.25', '0.00']);

    // Moving the ship-to to a state without registration takes the tax away again.
    const moved = await request(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ shippingAddress: CA_ADDRESS, calculateTax: true }),
    });
    expect(moved.status).toBe(200);
    const { data } = (await moved.json()) as { data: { id: string; tax: Record<string, any>; order: Record<string, unknown> } };
    expect(data.tax).toMatchObject({ totalTax: 0, warnings: ['not_registered_in_state'] });
    expect(data.order).toMatchObject({ taxTotal: '0.00', total: '160.00', taxLines: [] });

    const { order, items } = await loadOrder(id);
    expect(order).toMatchObject({ taxTotal: '0.00', total: '160.00', taxLines: [] });
    expect(order.shippingAddress).toMatchObject({ state: 'CA' });
    expect(items.map((i) => i.taxAmount)).toEqual(['0.00', '0.00']);
  });

  it('PATCH without the flag does not touch tax', async () => {
    const id = await seedOrder();
    const { request } = app('orders:update');
    const res = await request(`/api/orders/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ shippingAddress: CA_ADDRESS }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id } });
    expect((await loadOrder(id)).order).toMatchObject({ taxTotal: '0.00', taxLines: null });
  });

  it('PATCH writes nothing when the engine is unavailable or the order is paid', async () => {
    const id = await seedOrder();
    await setDefaultEntity(ENTITIES.stripeNoCredentials);
    try {
      const { request } = app('orders:update');
      const res = await request(`/api/orders/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ internalNote: 'x', calculateTax: true }) });
      expect(res.status).toBe(503);
      expect((await loadOrder(id)).order.internalNote).toBeNull();
    } finally {
      await setDefaultEntity(ENTITIES.us);
    }

    const paid = await seedOrder({ paymentStatus: 'paid' });
    const { request } = app('orders:update');
    const locked = await request(`/api/orders/${paid}`, { method: 'PATCH', headers: json, body: JSON.stringify({ internalNote: 'x', calculateTax: true }) });
    expect(locked.status).toBe(409);
    expect(await locked.json()).toMatchObject({ error: { code: 'ORDER_TAX_LOCKED' } });
    expect((await loadOrder(paid)).order.internalNote).toBeNull();
  });
});
