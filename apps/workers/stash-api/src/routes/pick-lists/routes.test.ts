/**
 * Every /api/pick-lists route on pglite: list, create, generate from an
 * order, assign, start, scan-confirm a line, complete, pack, ship (inventory
 * only, and through Sendcloud: a `fetch` stub answers by URL and body, so the
 * conformance harness compares both backends' calls), the packing slip,
 * detail, patch and delete, with their refusals. Runs against Rust in
 * conformance mode (rust/conformance/suites.json).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { encryptField } from '@weldsuite/db/lib/crypto';
import { json } from '../../test/crud-suite';
import { makeLocation, makeWarehouse, seedShippableOrder } from '../../test/fixtures';
import {
  completePickList,
  confirmPickItem,
  generatePickList,
  getPickListWithItems,
  packPickList,
} from '../../services/pick-lists';
import { pickListsRoutes } from './index';

let db: Database;
const base = '/api/pick-lists';
const ENCRYPTION_KEY = 'a'.repeat(64);
const ANNOUNCE = 'https://panel.sendcloud.sc/api/v3/shipments/announce';

const realFetch = globalThis.fetch;
// Sendcloud answers by the recipient's name, and checks the credentials.
const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== ANNOUNCE) return realFetch(input, init);
  const auth = new Headers(init?.headers).get('authorization');
  if (auth !== `Basic ${btoa('pk_test:sk_test')}` && auth !== `Basic ${btoa('pk_enc:sk_secret')}`) {
    return Response.json({ error: { message: 'Bad credentials' } }, { status: 401 });
  }
  const body = JSON.parse(String(init?.body ?? '{}')) as { to_address?: { name?: string }; order_number?: string };
  const name = body.to_address?.name;
  if (name === 'Reject Me') return Response.json({ errors: [{ message: 'Address not deliverable' }] }, { status: 422 });
  if (name === 'Plain Text') return new Response('upstream down', { status: 503 });
  if (name === 'Empty Reply') return Response.json({ data: { id: 9, errors: [{ message: 'No carrier' }], parcels: [] } });
  if (name === 'No Tracking') return Response.json({ data: { id: 10, errors: [], parcels: [{ id: 5 }] } });
  if (name === 'Boom') throw new Error('network down');
  return Response.json({
    data: {
      id: 'shp_sc_1',
      carrier: { code: 'postnl', name: 'PostNL' },
      ship_with: { properties: { shipping_option_code: 'postnl:standard' } },
      errors: [],
      parcels: [
        {
          id: 383707309,
          tracking_number: `3SYZ-${body.order_number ?? 'none'}`,
          tracking_url: 'https://tracking.sendcloud.sc/3SYZ',
          label_file: 'JVBERi0x',
          documents: [{ type: 'label', link: 'https://panel.sendcloud.sc/api/v3/parcels/383707309/documents/label' }],
          status: { code: 'READY_TO_SEND' },
        },
      ],
    },
  });
});

function app(keys: string[], context: { clerkOrgId?: string } = {}, env: Record<string, unknown> = {}) {
  return createTestApp(base, pickListsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, ...context },
    env: env as never,
  });
}

const reader = () => app(['picklists:read']);
const updater = (context: { clerkOrgId?: string } = {}, env: Record<string, unknown> = {}) =>
  app(['picklists:update'], context, env);

type Seed = Parameters<typeof seedShippableOrder>[1] & { digital?: boolean };

/**
 * A generated pick list for a fresh order. `digital`: its lines stop needing
 * a carrier once picked (a list is only generated for lines that do).
 */
async function generated(params: Seed = {}) {
  const { digital, ...seed } = params;
  const order = await seedShippableOrder(db, seed);
  const list = await generatePickList(db, { orderId: order.orderId, warehouseId: order.warehouseId });
  if (digital) {
    await db.update(schema.orderItems).set({ requiresShipping: 0 }).where(eq(schema.orderItems.orderId, order.orderId));
  }
  const full = await getPickListWithItems(db, list.id);
  return { order, list, item: full!.items[0]! };
}

/** A pick list picked, completed and packed, ready to ship. */
async function packed(params: Seed = {}) {
  const { order, list, item } = await generated(params);
  await confirmPickItem(db, {
    pickListId: list.id,
    itemId: item.id,
    quantity: item.quantityRequired,
    productBarcode: order.barcode,
    userId: 'user_test_default',
  });
  await completePickList(db, list.id, 'user_test_default');
  await packPickList(db, list.id, 'user_test_default');
  return { order, id: list.id };
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceSettings).values([
    {
      id: 'org_test_default',
      customSettings: {
        theme: 'kept',
        sendcloud: {
          publicKey: 'pk_test',
          secretKey: 'sk_test',
          senders: [
            { id: 11, name: 'HQ', enabled: true, isDefault: true },
            { id: 12, name: 'Old', enabled: false, isDefault: false },
          ],
          methods: [
            { code: 'postnl:standard', name: 'PostNL', enabled: true, isDefault: true },
            { code: 'dhl:off', name: 'DHL', enabled: false, isDefault: false },
          ],
        },
      },
    },
    {
      id: 'org_encrypted',
      customSettings: {
        sendcloud: {
          publicKey: 'pk_enc',
          secretKey: await encryptField('sk_secret', { v1: ENCRYPTION_KEY }),
          senders: [{ id: 11, name: 'HQ', enabled: true, isDefault: true }],
          methods: [{ code: 'postnl:standard', name: 'PostNL', enabled: true, isDefault: true }],
        },
      },
    },
    { id: 'org_no_keys', customSettings: { sendcloud: { senders: [], methods: [] } } },
    { id: 'org_bad_key', customSettings: { sendcloud: { publicKey: 'pk_test', secretKey: 'abcd:ef01', senders: [], methods: [] } } },
  ]);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('/api/pick-lists · list', () => {
  it('lists with filters and paging', async () => {
    await generated();
    await generated();
    const { request } = reader();
    const first = (await (await request(`${base}?limit=1`)).json()) as { pagination: { cursor: string } };
    for (const query of [
      '',
      'status=pending',
      'status=assigned',
      'assignedTo=user_x',
      'warehouseId=wh_none',
      'warehouseId=&status=&assignedTo=',
      `limit=1&cursor=${first.pagination.cursor}`,
      'cursor=pl_missing&status=pending',
      'limit=0',
      'limit=abc',
      'limit=500',
    ]) {
      expect((await request(`${base}?${query}`)).status, query).toBe(200);
    }
    expect((await app([]).request(base)).status).toBe(403);
  });
});

describe('/api/pick-lists · create, patch, detail', () => {
  it('creates a pick list by hand', async () => {
    const { request } = app(['picklists:create']);
    const warehouseId = await makeWarehouse(db);
    const res = await request(base, json({ warehouseId, orderIds: ['ord_x'], pickType: 'wave', priority: 'high', notes: 'n', assignedTo: null }));
    expect(res.status).toBe(201);
    expect((await request(base, json({ warehouseId, assignedTo: 'user_a', assignedToName: 'A', metadata: { a: 1 } }))).status).toBe(201);
    for (const body of [{}, { warehouseId: '' }, { warehouseId, orderIds: 'x' }, { warehouseId, priority: 'x'.repeat(21) }]) {
      expect((await request(base, json(body))).status).toBe(400);
    }
    expect((await request(base, json({ warehouseId: 'x'.repeat(31) }))).status).toBe(500);
    expect((await app(['picklists:read']).request(base, json({ warehouseId }))).status).toBe(403);
  });

  it('patches notes and assignment, never the status', async () => {
    const { list } = await generated();
    const { request } = app(['picklists:update']);
    expect((await request(`${base}/${list.id}`, json({ notes: 'rush', priority: 'urgent', status: 'shipped' }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/${list.id}`, json({ assignedTo: null, assignedToName: 'Nobody', metadata: { a: 1 } }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/${list.id}`, json({}, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/pl_missing`, json({ notes: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await request(`${base}/${list.id}`, json({ priority: 5 }, 'PATCH'))).status).toBe(400);
    expect((await app([]).request(`${base}/${list.id}`, json({ notes: 'x' }, 'PATCH'))).status).toBe(403);
  });

  it('answers a pick list with its items, recipient and shipping need', async () => {
    const { request } = reader();
    const { list } = await generated();
    const res = await request(`${base}/${list.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: unknown[]; recipient: { city: string }; requiresShipping: boolean } };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.recipient.city).toBe('Eindhoven');
    const digital = await generated({ digital: true, shippingAddress: null });
    expect((await request(`${base}/${digital.list.id}`)).status).toBe(200);
    const warehouseId = await makeWarehouse(db);
    const created = (await (await app(['picklists:create']).request(base, json({ warehouseId }))).json()) as { data: { id: string } };
    expect((await request(`${base}/${created.data.id}`)).status).toBe(200);
    expect((await request(`${base}/pl_missing`)).status).toBe(404);
    expect((await app([]).request(`${base}/${list.id}`)).status).toBe(403);
  });
});

describe('/api/pick-lists/generate', () => {
  it('generates a pick list from an order and allocates its stock', async () => {
    const order = await seedShippableOrder(db);
    const { request } = app(['picklists:create']);
    const res = await request(
      `${base}/generate`,
      json({ orderId: order.orderId, warehouseId: order.warehouseId, assignedTo: 'user_a', assignedToName: 'A', priority: 'high' }),
    );
    expect(res.status).toBe(201);
    expect((await request(`${base}/generate`, json({ orderId: order.orderId }))).status).toBe(409);
  });

  it('falls back to the default warehouse', async () => {
    const warehouseId = await makeWarehouse(db, { isDefault: true });
    const location = await makeLocation(db, warehouseId, { isPrimaryPick: true, pickingSequence: 2 });
    const order = await seedShippableOrder(db, { warehouseId, locationId: location });
    const res = await app(['picklists:create']).request(`${base}/generate`, json({ orderId: order.orderId }));
    expect(res.status).toBe(201);
  });

  it('refuses what it cannot pick', async () => {
    const { request } = app(['picklists:create']);
    expect((await request(`${base}/generate`, json({ orderId: 'ord_missing' }))).status).toBe(404);
    const short = await seedShippableOrder(db, { quantity: 50, stock: 2 });
    expect((await request(`${base}/generate`, json({ orderId: short.orderId, warehouseId: short.warehouseId }))).status).toBe(400);
    const digital = await seedShippableOrder(db, { requiresShipping: 0 });
    expect((await request(`${base}/generate`, json({ orderId: digital.orderId, warehouseId: digital.warehouseId }))).status).toBe(400);
    const missing = await seedShippableOrder(db);
    expect((await request(`${base}/generate`, json({ orderId: missing.orderId, warehouseId: 'wh_missing' }))).status).toBe(404);
    const done = await seedShippableOrder(db);
    await db.update(schema.orders).set({ fulfillmentStatus: 'fulfilled' }).where(eq(schema.orders.id, done.orderId));
    expect((await request(`${base}/generate`, json({ orderId: done.orderId }))).status).toBe(409);
    for (const body of [{}, { orderId: '' }, { orderId: 'x', priority: 'asap' }, { orderId: 'x', warehouseId: '' }]) {
      expect((await request(`${base}/generate`, json(body))).status).toBe(400);
    }
    expect((await app(['picklists:read']).request(`${base}/generate`, json({ orderId: 'x' }))).status).toBe(403);
  });
});

describe('/api/pick-lists · assign, start, pick, complete', () => {
  it('assigns and unassigns a pending list', async () => {
    const { list } = await generated();
    const { request } = updater();
    expect((await request(`${base}/${list.id}/assign`, json({ assignedTo: 'user_b', assignedToName: 'B' }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/${list.id}/assign`, json({ assignedTo: null }, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/${list.id}/assign`, json({}, 'PATCH'))).status).toBe(200);
    expect((await request(`${base}/${list.id}/assign`, json({ assignedTo: 3 }, 'PATCH'))).status).toBe(400);
    expect((await request(`${base}/pl_missing/assign`, json({ assignedTo: 'u' }, 'PATCH'))).status).toBe(404);
    expect((await app([]).request(`${base}/${list.id}/assign`, json({}, 'PATCH'))).status).toBe(403);
  });

  it('starts a list once, and not a finished one', async () => {
    const { list } = await generated();
    const { request } = updater();
    expect((await request(`${base}/${list.id}/start`, { method: 'PATCH' })).status).toBe(200);
    expect((await request(`${base}/${list.id}/start`, { method: 'PATCH' })).status).toBe(200);
    expect((await request(`${base}/${list.id}/assign`, json({ assignedTo: 'u' }, 'PATCH'))).status).toBe(400);
    expect((await request(`${base}/pl_missing/start`, { method: 'PATCH' })).status).toBe(404);
    expect((await app([]).request(`${base}/${list.id}/start`, { method: 'PATCH' })).status).toBe(403);
  });

  it('confirms a scanned line, refusing a wrong scan or a finished line', async () => {
    const location = await makeLocation(db, await makeWarehouse(db));
    const [loc] = await db.select().from(schema.warehouseLocations).where(eq(schema.warehouseLocations.id, location)).limit(1);
    const { order, list, item } = await generated({ warehouseId: loc!.warehouseId, locationId: location });
    const { request } = updater();
    const pick = (body: Record<string, unknown>, itemId = item.id) =>
      request(`${base}/${list.id}/items/${itemId}/pick`, json(body));
    expect((await pick({ quantity: 1, productBarcode: 'WRONG', locationBarcode: loc!.barcode })).status).toBe(400);
    expect((await pick({ quantity: 1, productBarcode: order.barcode })).status).toBe(400);
    expect((await pick({ quantity: 1, productBarcode: order.barcode, locationBarcode: 'WRONG' })).status).toBe(400);
    expect((await pick({ quantity: 1, productBarcode: order.barcode, locationBarcode: 'x' }, 'pli_missing')).status).toBe(404);
    expect((await pick({ quantity: 2, productBarcode: ` ${order.sku.toLowerCase()} `, locationBarcode: loc!.code, short: true })).status).toBe(200);
    expect((await pick({ quantity: 1, productBarcode: order.barcode, locationBarcode: loc!.barcode })).status).toBe(400);
    for (const body of [{}, { quantity: -1, productBarcode: 'x' }, { quantity: 1, productBarcode: '' }, { quantity: 1.5, productBarcode: 'x' }]) {
      expect((await pick(body)).status).toBe(400);
    }
    expect((await request(`${base}/pl_missing/items/${item.id}/pick`, json({ quantity: 1, productBarcode: 'x' }))).status).toBe(404);
    expect((await app([]).request(`${base}/${list.id}/items/${item.id}/pick`, json({ quantity: 1, productBarcode: 'x' }))).status).toBe(403);
  });

  it('records a zero pick as short', async () => {
    const { order, list, item } = await generated();
    const res = await updater().request(`${base}/${list.id}/items/${item.id}/pick`, json({ quantity: 0, productBarcode: order.barcode }));
    expect(res.status).toBe(200);
  });

  it('completes a list once every line is done', async () => {
    const { order, list, item } = await generated();
    const { request } = updater();
    expect((await request(`${base}/${list.id}/complete`, { method: 'PATCH' })).status).toBe(400);
    await confirmPickItem(db, { pickListId: list.id, itemId: item.id, quantity: item.quantityRequired, productBarcode: order.barcode });
    expect((await request(`${base}/${list.id}/complete`, { method: 'PATCH' })).status).toBe(200);
    expect((await request(`${base}/${list.id}/complete`, { method: 'PATCH' })).status).toBe(400);
    expect((await request(`${base}/${list.id}/items/${item.id}/pick`, json({ quantity: 1, productBarcode: order.barcode }))).status).toBe(400);
    expect((await request(`${base}/pl_missing/complete`, { method: 'PATCH' })).status).toBe(404);
    expect((await app([]).request(`${base}/${list.id}/complete`, { method: 'PATCH' })).status).toBe(403);
  });
});

describe('/api/pick-lists · pack and packing slip', () => {
  it('packs a completed list into a draft parcel, once', async () => {
    const { order, list, item } = await generated();
    const { request } = updater();
    expect((await request(`${base}/${list.id}/pack`, { method: 'POST' })).status).toBe(400);
    await confirmPickItem(db, { pickListId: list.id, itemId: item.id, quantity: item.quantityRequired, productBarcode: order.barcode });
    await completePickList(db, list.id);
    expect((await request(`${base}/${list.id}/pack`, { method: 'POST' })).status).toBe(200);
    expect((await request(`${base}/${list.id}/pack`, { method: 'POST' })).status).toBe(200);
    expect((await request(`${base}/pl_missing/pack`, { method: 'POST' })).status).toBe(404);
    expect((await app([]).request(`${base}/${list.id}/pack`, { method: 'POST' })).status).toBe(403);
  });

  it('packs a list without an order', async () => {
    const warehouseId = await makeWarehouse(db);
    const [row] = await db
      .insert(schema.pickLists)
      .values({ id: 'pl_noorder', pickListNumber: 'PL-NOORDER', warehouseId, status: 'completed' })
      .returning();
    expect((await updater().request(`${base}/${row!.id}/pack`, { method: 'POST' })).status).toBe(200);
    expect((await reader().request(`${base}/${row!.id}/packing-slip`)).status).toBe(200);
  });

  it('renders the packing slip', async () => {
    const { id } = await packed();
    const res = await reader().request(`${base}/${id}/packing-slip`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const { list } = await generated();
    expect((await reader().request(`${base}/${list.id}/packing-slip`)).status).toBe(200);
    expect((await reader().request(`${base}/pl_missing/packing-slip`)).status).toBe(404);
    expect((await app([]).request(`${base}/${id}/packing-slip`)).status).toBe(403);
  });
});

describe('/api/pick-lists/:id/ship', () => {
  it('ships an inventory-only order without a carrier', async () => {
    const { id } = await packed({ digital: true });
    const { request } = updater();
    expect((await request(`${base}/${id}/ship`, { method: 'POST' })).status).toBe(200);
    expect((await request(`${base}/${id}/ship`, { method: 'POST' })).status).toBe(200);
    const notJson = await packed({ digital: true });
    expect(
      (await request(`${base}/${notJson.id}/ship`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'nope' })).status,
    ).toBe(200);
  });

  it('ships through Sendcloud with the stored keys', async () => {
    const { id, order } = await packed();
    const res = await updater().request(`${base}/${id}/ship`, json({ senderId: 11, shippingOptionCode: 'postnl:standard', weightKg: 1.25 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { trackingNumber: string } };
    expect(body.data.trackingNumber).toContain('SO-');
    const [shipped] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.orderId)).limit(1);
    expect(shipped?.fulfillmentStatus).toBe('fulfilled');
  });

  it('opens a secret sealed with the workspace keyring', async () => {
    const { id } = await packed();
    const res = await updater({ clerkOrgId: 'org_encrypted' }, { DATABASE_ENCRYPTION_KEY: ENCRYPTION_KEY }).request(
      `${base}/${id}/ship`,
      json({ senderId: 11, shippingOptionCode: 'postnl:standard', weightKg: 2 }),
    );
    expect(res.status).toBe(200);
    // Without the key the sealed value is sent as it is, and Sendcloud refuses it.
    const other = await packed();
    const refused = await updater({ clerkOrgId: 'org_encrypted' }).request(
      `${base}/${other.id}/ship`,
      json({ senderId: 11, shippingOptionCode: 'postnl:standard', weightKg: 2 }),
    );
    expect(refused.status).toBe(409);
  });

  it('refuses to ship without a carrier set-up', async () => {
    const { id } = await packed();
    const ship = (body: Record<string, unknown>, context: { clerkOrgId?: string } = {}) =>
      updater(context).request(`${base}/${id}/ship`, json(body));
    const full = { senderId: 11, shippingOptionCode: 'postnl:standard', weightKg: 1 };
    expect((await ship({})).status).toBe(409);
    expect((await ship({ senderId: 11, shippingOptionCode: 'postnl:standard' })).status).toBe(409);
    expect((await ship(full, { clerkOrgId: 'org_none' })).status).toBe(409);
    expect((await ship(full, { clerkOrgId: 'org_no_keys' })).status).toBe(409);
    expect((await ship({ ...full, senderId: 12 })).status).toBe(409);
    expect((await ship({ ...full, shippingOptionCode: 'dhl:off' })).status).toBe(409);
    expect((await ship({ ...full, senderId: 99 })).status).toBe(409);
    expect((await ship(full, { clerkOrgId: 'org_bad_key' })).status).toBe(409);
  });

  it('maps what Sendcloud answers', async () => {
    const full = { senderId: 11, shippingOptionCode: 'postnl:standard', weightKg: 1 };
    const address = (name: string) => ({ name, line1: 'Insulindelaan 115', city: 'Eindhoven', postalCode: '5642CV', country: 'Netherlands' });
    for (const [name, status] of [
      ['Reject Me', 409],
      ['Plain Text', 409],
      ['Empty Reply', 409],
      ['No Tracking', 409],
      ['Boom', 500],
    ] as const) {
      const { id } = await packed({ shippingAddress: address(name) });
      expect((await updater().request(`${base}/${id}/ship`, json(full))).status, name).toBe(status);
    }
    const incomplete = await packed({ shippingAddress: { line1: 'Somewhere' } });
    expect((await updater().request(`${base}/${incomplete.id}/ship`, json(full))).status).toBe(400);
    const none = await packed({ shippingAddress: null });
    expect((await updater().request(`${base}/${none.id}/ship`, json(full))).status).toBe(400);
  });

  it('refuses a bad payload, a list that is not packed, a missing one', async () => {
    const { request } = updater();
    const { id } = await packed();
    for (const body of [{ senderId: -1 }, { weightKg: 'heavy', shippingOptionCode: '' }, null, [1]]) {
      expect((await request(`${base}/${id}/ship`, json(body))).status).toBe(400);
    }
    const { list } = await generated();
    expect((await request(`${base}/${list.id}/ship`, json({}))).status).toBe(400);
    expect((await request(`${base}/pl_missing/ship`, json({}))).status).toBe(404);
    expect((await app([]).request(`${base}/${id}/ship`, json({}))).status).toBe(403);
  });
});

describe('/api/pick-lists · delete', () => {
  it('cancels an open list, releasing its stock, then deletes it', async () => {
    const { list } = await generated();
    const { request } = app(['picklists:delete', 'picklists:read']);
    expect((await request(`${base}/${list.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`${base}/${list.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await request(`${base}/${list.id}`)).status).toBe(404);
  });

  it('deletes a picked, a shipped and a cancelled list', async () => {
    const { request } = app(['picklists:delete', 'picklists:update']);
    const picked = await generated();
    await confirmPickItem(db, { pickListId: picked.list.id, itemId: picked.item.id, quantity: 1, productBarcode: picked.order.barcode, short: true });
    expect((await request(`${base}/${picked.list.id}`, { method: 'DELETE' })).status).toBe(204);
    const shipped = await packed({ digital: true });
    expect((await request(`${base}/${shipped.id}/ship`, { method: 'POST' })).status).toBe(200);
    expect((await request(`${base}/${shipped.id}`, { method: 'DELETE' })).status).toBe(204);
    const warehouseId = await makeWarehouse(db);
    await db.insert(schema.pickLists).values({ id: 'pl_cancelled', pickListNumber: 'PL-C', warehouseId, status: 'cancelled' });
    expect((await request(`${base}/pl_cancelled`, { method: 'DELETE' })).status).toBe(204);
    expect((await app([]).request(`${base}/pl_cancelled`, { method: 'DELETE' })).status).toBe(403);
  });
});

