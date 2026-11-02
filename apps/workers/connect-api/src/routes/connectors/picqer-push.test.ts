/**
 * `POST /api/connectors/connections/:id/picqer/push` on a real (pglite)
 * tenant database: a person, an order (which pushes its customer first), a
 * supplier, a warehouse, a purchase order, a return and a stock change go to
 * Picqer (a fetch stub answering by URL), each writing its
 * `integration_entity_mappings` row; an unchanged record is not sent again,
 * a changed one is updated. Plus the refusals: not Picqer, unknown, paused,
 * outbound off, a missing record, unmapped stock, rejected credentials and a
 * bad body.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectorRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Picqer's answers, by method and path under `/api/v1/`. */
const ANSWERS: Record<string, unknown | ((body: Record<string, unknown>) => unknown)> = {
  'POST customers': (body: Record<string, unknown>) => ({ idcustomer: body.name === 'Bo' ? 502 : 501, name: body.name }),
  'PUT customers/501': { idcustomer: 501 },
  'POST orders': { idorder: 601 },
  'POST suppliers': { idsupplier: 701 },
  'POST warehouses': { idwarehouse: '801' },
  'POST purchaseorders': { idpurchaseorder: 901 },
  'POST returns': { id: 1001 },
  'POST products/42/stock': {},
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(url)) return realFetch(input, init);
      if (url.startsWith('https://denied.picqer.com/')) return json({ error: true, error_message: 'Invalid API key' }, 401);
      const prefix = 'https://acme.picqer.com/api/v1/';
      if (url.startsWith(prefix)) {
        const key = `${init?.method ?? 'GET'} ${url.slice(prefix.length).split('?')[0]}`;
        const answer = ANSWERS[key];
        if (typeof answer === 'function') return json(answer(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>));
        if (answer !== undefined) return json(answer);
      }
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;

const AT = new Date('2026-03-01T10:00:00.000Z');

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const picqer = (id: string, over: Record<string, unknown>) => ({
    id,
    provider: 'picqer',
    displayName: 'Picqer',
    status: 'active',
    direction: 'bidirectional',
    credentials: { subdomain: 'acme', apiKey: 'pq_key' },
    externalAccountId: id,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });
  await db.insert(schema.connectorConnections).values([
    picqer('ccn_pq_push000001', {}),
    picqer('ccn_pq_paused0001', { status: 'paused' }),
    picqer('ccn_pq_inbound001', { direction: 'inbound', objectSyncDirections: { suppliers: 'outbound' } }),
    picqer('ccn_pq_denied0001', { credentials: { subdomain: 'denied', apiKey: 'pq_bad' } }),
    {
      id: 'ccn_woo_push00001',
      provider: 'woocommerce',
      displayName: 'WooCommerce',
      status: 'active',
      credentials: { storeUrl: 'https://shop.example', consumerKey: 'ck', consumerSecret: 'cs' },
      createdAt: AT,
      updatedAt: AT,
    },
  ] as (typeof schema.connectorConnections.$inferInsert)[]);
  await db.insert(schema.people).values([
    { id: 'per_push00000001', firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', displayName: 'Ada', email: 'ada@example.com', directPhone: '+31 20 1' },
    { id: 'per_push00000002', firstName: 'Bo', displayName: '' },
  ] as (typeof schema.people.$inferInsert)[]);
  await db.insert(schema.orders).values({
    id: 'ord_push00000001',
    orderNumber: 'WS-1001',
    customerEmail: 'bo@example.com',
    customerName: 'Bo',
    customerNote: 'Leave at the door',
    personId: 'per_push00000002',
    status: 'pending',
    subtotal: '25.00',
    total: '25.00',
    currency: 'EUR',
  } as typeof schema.orders.$inferInsert);
  await db.insert(schema.orderItems).values([
    { id: 'oit_push00000001', orderId: 'ord_push00000001', productId: 'prd_push00000001', sku: 'MUG-1', name: 'Mug', quantity: 2, unitPrice: '12.50', total: '25.00' },
    { id: 'oit_push00000002', orderId: 'ord_push00000001', name: 'Gift wrap', quantity: 1, unitPrice: '0', total: '0' },
  ] as (typeof schema.orderItems.$inferInsert)[]);
  await db.insert(schema.suppliers).values({
    id: 'sup_push00000001',
    name: 'Mugs BV',
    contactName: 'Carl',
    email: 'sales@mugs.example',
    addressLine1: 'Kade 1',
    city: 'Delft',
    postalCode: '2611 AA',
    country: 'NL',
  } as typeof schema.suppliers.$inferInsert);
  await db.insert(schema.warehouses).values({ id: 'whs_push00000001', name: 'Main', code: 'MAIN', isActive: true } as typeof schema.warehouses.$inferInsert);
  await db.insert(schema.purchaseOrders).values({
    id: 'pur_push00000001',
    poNumber: 'PO-1',
    supplierId: 'sup_push00000001',
    supplierName: 'Mugs BV',
    warehouseId: 'whs_push00000001',
    supplierNotes: 'Pallet please',
    expectedDate: new Date('2026-04-02T00:00:00.000Z'),
  } as typeof schema.purchaseOrders.$inferInsert);
  await db.insert(schema.purchaseOrderItems).values([
    { id: 'poi_push00000001', purchaseOrderId: 'pur_push00000001', productId: 'prd_push00000001', sku: 'MUG-1', name: 'Mug', quantityOrdered: 50, unitPrice: '3.20', total: '160.00' },
  ] as (typeof schema.purchaseOrderItems.$inferInsert)[]);
  await db.insert(schema.returns).values({
    id: 'ret_push00000001',
    returnNumber: 'RET-1',
    originalOrderId: 'ord_push00000001',
    customerName: 'Bo',
    customerEmail: 'bo@example.com',
    reason: 'damaged',
    items: [{ productName: 'Mug', sku: 'MUG-1', quantity: 1 }, { productName: 'Gift wrap', quantity: 1 }],
  } as typeof schema.returns.$inferInsert);
  await db.insert(schema.integrationEntityMappings).values({
    id: 'iem_push00000001',
    connectionId: 'ccn_pq_push000001',
    externalEntityType: 'picqer_product',
    externalEntityId: '42',
    internalEntityType: 'product',
    internalEntityId: 'prd_push00000001',
    lastSyncedAt: AT,
    updatedAt: AT,
  } as typeof schema.integrationEntityMappings.$inferInsert);
}, 60_000);

function app(...granted: string[]) {
  return createTestApp<Env, Variables>('/api/connectors', connectorRoutes, {
    context: {
      tenantDb: db,
      permissions: permissions(...(granted.length ? granted : ['integrations:read', 'integrations:update'])),
    },
  }).request;
}

const push = (connection: string, body: unknown, ...granted: string[]) =>
  app(...granted)(`/api/connectors/connections/${connection}/picqer/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function data(res: Response): Promise<unknown> {
  return ((await res.json()) as { data: unknown }).data;
}

async function mapping(type: string, internalId: string) {
  const [row] = await db
    .select()
    .from(schema.integrationEntityMappings)
    .where(eq(schema.integrationEntityMappings.internalEntityId, internalId));
  return row?.externalEntityType === type ? row : undefined;
}

describe('POST /connections/:id/picqer/push', () => {
  it('pushes a person once, skips it unchanged and updates it when it changed', async () => {
    const first = await push('ccn_pq_push000001', { entity: 'person', entityId: 'per_push00000001' });
    expect(first.status).toBe(200);
    expect(await data(first)).toEqual({ externalId: '501' });
    const stored = await mapping('picqer_customer', 'per_push00000001');
    expect(stored?.externalEntityId).toBe('501');
    expect(stored?.syncChecksum).toMatch(/^[0-9a-f]{64}$/);

    const again = await push('ccn_pq_push000001', { entity: 'person', entityId: 'per_push00000001' });
    expect(await data(again)).toEqual({ externalId: '501' });

    await db.update(schema.people).set({ email: 'ada@lovelace.example' }).where(eq(schema.people.id, 'per_push00000001'));
    const changed = await push('ccn_pq_push000001', { entity: 'person', entityId: 'per_push00000001' });
    expect(await data(changed)).toEqual({ externalId: '501' });
    expect((await mapping('picqer_customer', 'per_push00000001'))?.syncChecksum).not.toBe(stored?.syncChecksum);
  });

  it('pushes an order with its customer and mapped products', async () => {
    const res = await push('ccn_pq_push000001', { entity: 'order', entityId: 'ord_push00000001' });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ externalId: '601' });
    expect((await mapping('picqer_customer', 'per_push00000002'))?.externalEntityId).toBe('502');
    expect((await mapping('picqer_order', 'ord_push00000001'))?.externalEntityId).toBe('601');
  });

  it('pushes a supplier, a warehouse, a purchase order and a return', async () => {
    expect(await data(await push('ccn_pq_push000001', { entity: 'supplier', entityId: 'sup_push00000001' }))).toEqual({ externalId: '701' });
    expect(await data(await push('ccn_pq_push000001', { entity: 'warehouse', entityId: 'whs_push00000001' }))).toEqual({ externalId: '801' });
    expect(await data(await push('ccn_pq_push000001', { entity: 'purchase_order', entityId: 'pur_push00000001' }))).toEqual({ externalId: '901' });
    expect(await data(await push('ccn_pq_push000001', { entity: 'return', entityId: 'ret_push00000001' }))).toEqual({ externalId: '1001' });
  });

  it('changes stock for a mapped product and warehouse', async () => {
    const res = await push('ccn_pq_push000001', { entity: 'inventory', entityId: 'prd_push00000001', warehouseId: 'whs_push00000001', amountDelta: -3 });
    expect(res.status).toBe(200);
    expect(await data(res)).toEqual({ ok: true });
    const none = await push('ccn_pq_push000001', { entity: 'inventory', entityId: 'prd_push00000001', warehouseId: 'whs_push00000001', amountDelta: 0 });
    expect(await data(none)).toEqual({ ok: true });
    const unmapped = await push('ccn_pq_push000001', { entity: 'inventory', entityId: 'prd_unknown000001', warehouseId: 'whs_push00000001', amountDelta: 1 });
    expect(unmapped.status).toBe(400);
    const incomplete = await push('ccn_pq_push000001', { entity: 'inventory', entityId: 'prd_push00000001', amountDelta: 1 });
    expect(incomplete.status).toBe(400);
  });

  it('refuses what it cannot push', async () => {
    expect((await push('ccn_missing0000000', { entity: 'person', entityId: 'per_push00000001' })).status).toBe(404);
    expect((await push('ccn_woo_push00001', { entity: 'person', entityId: 'per_push00000001' })).status).toBe(400);
    expect((await push('ccn_pq_paused0001', { entity: 'person', entityId: 'per_push00000001' })).status).toBe(400);
    const off = await push('ccn_pq_inbound001', { entity: 'person', entityId: 'per_push00000001' });
    expect(off.status).toBe(400);
    expect(((await off.json()) as { error: { message: string } }).error.message).toBe('Outbound sync disabled for customers');
    expect((await push('ccn_pq_push000001', { entity: 'person', entityId: 'per_missing000001' })).status).toBe(400);
    expect((await push('ccn_pq_push000001', { entity: 'order', entityId: 'ord_missing000001' })).status).toBe(400);
    const denied = await push('ccn_pq_denied0001', { entity: 'warehouse', entityId: 'whs_push00000001' });
    expect(denied.status).toBe(400);
    expect((await push('ccn_pq_push000001', { entity: 'invoice', entityId: 'x' })).status).toBe(400);
    expect((await push('ccn_pq_push000001', { entity: 'person', entityId: '' })).status).toBe(400);
    expect((await push('ccn_pq_push000001', { entity: 'person', entityId: 'per_push00000001' }, 'integrations:read')).status).toBe(403);
  });
});
