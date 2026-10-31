/**
 * The sales-channel routes of /api/products on pglite, with the stores'
 * REST APIs as a `fetch` stub: publishing a product to a WooCommerce or
 * Shopify connection (new listing, SKU match, re-link), changing a listing's
 * price or status, unlinking it, and every refusal on the way (conflicts,
 * inactive / inbound-only / unknown / non-catalogue connections, bad prices,
 * missing rows, the store failing). Also `DELETE /api/products/:id` and the
 * 404s of the plain product routes.
 *
 * Store clients are built exactly as in production: the connection rows hold
 * no secrets (WooCommerce: null credentials, the store URL in
 * `externalAccountId`; Shopify: a plain access token, which `decryptCredentials`
 * passes through untouched), so no `DATABASE_ENCRYPTION_KEY` is needed.
 *
 * Conformance-ready: the stub answers by method and URL (and the SKU / id in
 * them), never by call order, so both backends' outbound calls can be compared.
 * Failing store answers are 400s: WooCommerce retries 5xx and falls back to
 * `?rest_route=` on 404, which would only slow these tests down.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { productsRoutes } from './index';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const BASE = '/api/products';
const WOO = 'https://shop.example';
const WOO_API = `${WOO}/wp-json/wc/v3/`;
/** A second WooCommerce store: one live store URL is one connection. */
const FLAKY = 'https://flaky.example';
const WOO_STORES = new Set([WOO, FLAKY]);
const SHOP = 'https://weld-test.myshopify.com';
const SHOP_API = `${SHOP}/admin/api/2024-10/`;

let db: Database;

const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute, 0));

// ── the stores, answered by method + URL ────────────────────────────────────

const realFetch = globalThis.fetch;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function jsonBody(init?: RequestInit): Record<string, unknown> | null {
  return typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
}

/** Remote ids the store hands out for a new listing, by SKU. */
const CREATED_IDS: Record<string, number> = { 'SC-NEW': 901, 'SC-RELINK': 902 };

const wooError = (status: number) =>
  Response.json({ code: 'woocommerce_rest_error', message: 'Store says no', data: { status } }, { status });

function woo(method: string, url: URL, init?: RequestInit): Response {
  const path = url.pathname.slice('/wp-json/wc/v3/'.length);
  if (path === 'products' && method === 'GET') {
    const sku = url.searchParams.get('sku');
    if (sku === 'SC-MATCH') return Response.json([{ id: 501, permalink: `${url.origin}/product/match` }]);
    return Response.json([]);
  }
  if (path === 'products' && method === 'POST') {
    const sku = String(jsonBody(init)?.sku ?? '');
    if (sku === 'SC-FAIL') return wooError(400);
    const id = CREATED_IDS[sku] ?? 900;
    return Response.json({ id, permalink: `${url.origin}/product/${id}` }, { status: 201 });
  }
  const remoteId = /^products\/(\d+)$/.exec(path)?.[1];
  if (remoteId && method === 'PUT') {
    if (remoteId === '601') return wooError(400);
    return Response.json({ id: Number(remoteId), permalink: `${url.origin}/product/${remoteId}` });
  }
  if (remoteId && method === 'DELETE') {
    if (remoteId === '701') return wooError(400);
    return Response.json({ id: Number(remoteId) });
  }
  return wooError(404);
}

function shopify(method: string, url: URL): Response {
  const path = url.pathname.slice('/admin/api/2024-10/'.length);
  if (path === 'graphql.json' && method === 'POST') return Response.json({ data: { products: { edges: [] } } });
  if (path === 'products.json' && method === 'POST') {
    return Response.json({ product: { id: 7001, handle: 'shop-gloves' } }, { status: 201 });
  }
  return Response.json({ errors: 'Not Found' }, { status: 404 });
}

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(urlOf(input));
  const method = (init?.method ?? 'GET').toUpperCase();
  if (WOO_STORES.has(url.origin)) return woo(method, url, init);
  if (url.origin === SHOP) return shopify(method, url);
  // The conformance harness's own calls (the Rust server, the bridges).
  return realFetch(input, init);
});

/** Every call the routes sent to a store, harness calls left out. */
function allStoreCalls() {
  return fetchStub.mock.calls
    .map(([input, init]) => ({ url: urlOf(input), method: (init?.method ?? 'GET').toUpperCase(), body: jsonBody(init) }))
    .filter((call) => WOO_STORES.has(new URL(call.url).origin) || call.url.startsWith(`${SHOP}/`));
}

function storeCalls(method: string, prefix: string) {
  return allStoreCalls().filter((call) => call.method === method && call.url.startsWith(prefix));
}

// ── the app ──────────────────────────────────────────────────────────────────

function api(...keys: string[]) {
  return createTestApp(BASE, productsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db },
  }).request;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function dataOf<T = Record<string, unknown>>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorOf(res: Response): Promise<{ code: string; message: string; details?: unknown }> {
  return ((await res.json()) as { error: { code: string; message: string; details?: unknown } }).error;
}

const publish = (productId: string, body: unknown) =>
  api('products:update')(`${BASE}/${productId}/sales-channels`, json(body));
const patchChannel = (productId: string, channelId: string, body: unknown) =>
  api('products:update')(`${BASE}/${productId}/sales-channels/${channelId}`, json(body, 'PATCH'));
const unlink = (productId: string, channelId: string) =>
  api('products:update')(`${BASE}/${productId}/sales-channels/${channelId}`, { method: 'DELETE' });

async function channelRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.productSalesChannels)
    .where(eq(schema.productSalesChannels.id, id))
    .limit(1);
  return row;
}

async function channelsOf(productId: string) {
  return db.select().from(schema.productSalesChannels).where(eq(schema.productSalesChannels.productId, productId));
}

// ── seed ─────────────────────────────────────────────────────────────────────

async function seedConnection(id: string, values: Partial<typeof schema.connectorConnections.$inferInsert> = {}) {
  await db.insert(schema.connectorConnections).values({
    id,
    provider: 'woocommerce',
    displayName: id,
    status: 'active',
    direction: 'bidirectional',
    externalAccountId: WOO,
    createdAt: at(0),
    updatedAt: at(0),
    ...values,
  });
}

async function seedProduct(id: string, minute: number, values: Partial<typeof schema.products.$inferInsert> = {}) {
  await db.insert(schema.products).values({
    id,
    name: id,
    slug: id.replaceAll('_', '-'),
    price: '19.00',
    status: 'active',
    createdAt: at(minute),
    updatedAt: at(minute),
    ...values,
  });
}

async function seedChannel(
  id: string,
  productId: string,
  connectionId: string,
  externalId: string,
  values: Partial<typeof schema.productSalesChannels.$inferInsert> = {},
) {
  await db.insert(schema.productSalesChannels).values({
    id,
    productId,
    connectionId,
    provider: 'woocommerce',
    displayName: 'Main store',
    externalId,
    externalUrl: `${WOO}/product/${externalId}`,
    status: 'active',
    createdAt: at(1),
    updatedAt: at(1),
    ...values,
  });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  db = (await createPgliteDb()).db;

  await seedConnection('conn_woo', { displayName: 'Main store' });
  await seedConnection('conn_shop', {
    provider: 'shopify',
    displayName: 'Shopify shop',
    direction: 'outbound',
    externalAccountId: 'weld-test.myshopify.com',
    credentials: { accessToken: 'shpat_test' },
  });
  await seedConnection('conn_err', { displayName: 'Flaky store', status: 'sync_error', externalAccountId: FLAKY });
  await seedConnection('conn_off', { displayName: 'Paused store', status: 'paused', externalAccountId: 'https://old.example' });
  await seedConnection('conn_inbound', { direction: 'inbound', externalAccountId: 'https://inbound.example' });
  await seedConnection('conn_inbound_obj', {
    objectSyncDirections: { products: 'inbound' },
    externalAccountId: 'https://inbound-obj.example',
  });
  await seedConnection('conn_acme', { provider: 'acme' });
  await seedConnection('conn_stripe', { provider: 'stripe', direction: 'outbound', externalAccountId: null });
  await seedConnection('conn_nourl', { externalAccountId: null });
  await seedConnection('conn_gone', { deletedAt: at(2) });

  await seedProduct('prod_sc_new', 10, {
    name: 'Weld Helmet',
    slug: 'weld-helmet',
    sku: 'SC-NEW',
    description: 'Auto-darkening helmet',
    shortDescription: 'Helmet',
    images: [{ url: 'https://cdn.example/helmet.jpg', altText: 'Front' }],
    weight: '1.250',
    vendor: 'WeldCo',
    productType: 'Safety',
    trackInventory: true,
    inventoryQuantity: 4,
  });
  await seedProduct('prod_sc_match', 11, {
    name: 'Match Gloves',
    slug: 'match-gloves',
    sku: 'SC-MATCH',
    price: '25.00',
    status: 'draft',
    featuredImageUrl: 'https://cdn.example/gloves.jpg',
    trackInventory: false,
  });
  await seedProduct('prod_sc_dupe', 12, { name: 'Dupe Gloves', sku: 'SC-MATCH', price: '26.00' });
  await seedProduct('prod_sc_shop', 13, { name: 'Shop Gloves', sku: 'SC-SHOP', price: '12.50' });
  await seedProduct('prod_sc_relink', 14, { name: 'Relink Mask', sku: 'SC-RELINK' });
  await seedProduct('prod_sc_listed', 15, { name: 'Listed Apron', sku: 'SC-LISTED' });
  await seedProduct('prod_sc_fail', 16, { name: 'Fail Torch', sku: 'SC-FAIL' });
  await seedProduct('prod_sc_archived', 17, { name: 'Archived Rod', sku: 'SC-ARCH', status: 'archived' });
  await seedProduct('prod_sc_edit', 18, { name: 'Edit Boots', sku: 'SC-EDIT', price: '40.00' });
  await seedProduct('prod_sc_editfail', 19, { name: 'Edit Fail' });
  await seedProduct('prod_sc_editoff', 20, { name: 'Edit Off' });
  await seedProduct('prod_sc_del', 21, { name: 'Delete Listing' });
  await seedProduct('prod_sc_delfail', 22, { name: 'Delete Fail' });
  await seedProduct('prod_sc_delgone', 23, { name: 'Delete Gone' });
  await seedProduct('prod_sc_bye', 24, { name: 'Bye Product' });
  await seedProduct('prod_sc_deleted', 25, { name: 'Already Deleted', deletedAt: at(26) });

  await seedChannel('psch_listed', 'prod_sc_listed', 'conn_woo', '400');
  await seedChannel('psch_relink', 'prod_sc_relink', 'conn_err', '410', { status: 'disconnected' });
  await seedChannel('psch_edit', 'prod_sc_edit', 'conn_woo', '600', { price: '40.00', listingStatus: 'active' });
  await seedChannel('psch_editfail', 'prod_sc_editfail', 'conn_woo', '601');
  await seedChannel('psch_editoff', 'prod_sc_editoff', 'conn_off', '602');
  await seedChannel('psch_del', 'prod_sc_del', 'conn_woo', '700');
  await seedChannel('psch_delfail', 'prod_sc_delfail', 'conn_woo', '701');
  await seedChannel('psch_delgone', 'prod_sc_delgone', 'conn_gone', '702');
}, 60_000);

beforeEach(() => {
  fetchStub.mockClear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

// ── GET /sales-channel-targets ───────────────────────────────────────────────

describe('GET /api/products/sales-channel-targets', () => {
  it('lists the live, writable ecommerce connections, whatever their direction', async () => {
    const res = await api('products:read')(`${BASE}/sales-channel-targets`);
    expect(res.status).toBe(200);
    const targets = await dataOf<Array<{ id: string }>>(res);
    expect(targets.map((t) => t.id).sort((a, b) => a.localeCompare(b))).toEqual([
      'conn_err',
      'conn_inbound',
      'conn_inbound_obj',
      'conn_nourl',
      'conn_shop',
      'conn_woo',
    ]);
    expect(targets.find((t) => t.id === 'conn_woo')).toEqual({
      id: 'conn_woo',
      provider: 'woocommerce',
      label: 'WooCommerce',
      displayName: 'Main store',
      status: 'active',
      externalAccountId: WOO,
    });
    expect(targets.find((t) => t.id === 'conn_shop')).toMatchObject({ label: 'Shopify', status: 'active' });
  });
});

// ── POST /:id/sales-channels ─────────────────────────────────────────────────

describe('POST /api/products/:id/sales-channels', () => {
  it('creates a new WooCommerce listing and records the channel and the mapping', async () => {
    const res = await publish('prod_sc_new', { connectionId: 'conn_woo' });
    expect(res.status).toBe(201);
    const channel = await dataOf(res);
    expect(channel).toMatchObject({
      productId: 'prod_sc_new',
      connectionId: 'conn_woo',
      provider: 'woocommerce',
      displayName: 'Main store',
      externalId: '901',
      externalUrl: `${WOO}/product/901`,
      status: 'active',
      price: '19.00',
      listingStatus: 'active',
    });
    expect(channel.id).toMatch(/^psch_/);
    expect(typeof channel.lastSyncedAt).toBe('string');

    const lookups = storeCalls('GET', `${WOO_API}products`);
    expect(lookups.map((c) => new URL(c.url).searchParams.get('sku'))).toContain('SC-NEW');
    expect(storeCalls('POST', `${WOO_API}products`).map((c) => c.body)).toContainEqual({
      name: 'Weld Helmet',
      type: 'simple',
      status: 'publish',
      description: 'Auto-darkening helmet',
      short_description: 'Helmet',
      sku: 'SC-NEW',
      regular_price: '19.00',
      slug: 'weld-helmet',
      weight: '1.250',
      images: [{ src: 'https://cdn.example/helmet.jpg', alt: 'Front' }],
      manage_stock: true,
      stock_quantity: 4,
    });

    const mappings = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(eq(schema.integrationEntityMappings.internalEntityId, 'prod_sc_new'));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      connectionId: 'conn_woo',
      externalEntityType: 'woocommerce_product',
      externalEntityId: '901',
      internalEntityType: 'product',
    });
  });

  it('updates the store listing that already has the SKU, with the channel price and status', async () => {
    const res = await publish('prod_sc_match', { connectionId: 'conn_woo', price: '29,95', listingStatus: 'inactive' });
    expect(res.status).toBe(201);
    expect(await dataOf(res)).toMatchObject({
      productId: 'prod_sc_match',
      externalId: '501',
      // From the update's answer, not the SKU lookup's.
      externalUrl: `${WOO}/product/501`,
      price: '29.95',
      listingStatus: 'inactive',
    });
    expect(storeCalls('POST', `${WOO_API}products`)).toEqual([]);
    expect(storeCalls('PUT', `${WOO_API}products/501`).map((c) => c.body)).toContainEqual({
      name: 'Match Gloves',
      type: 'simple',
      status: 'private',
      description: '',
      short_description: '',
      sku: 'SC-MATCH',
      regular_price: '29.95',
      slug: 'match-gloves',
      images: [{ src: 'https://cdn.example/gloves.jpg' }],
      manage_stock: false,
    });
  });

  it('refuses a store listing another product is linked to, after updating it on the store', async () => {
    const res = await publish('prod_sc_dupe', { connectionId: 'conn_woo' });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({
      code: 'CONFLICT',
      message: 'That store listing is already linked to a different product',
    });
    expect(storeCalls('PUT', `${WOO_API}products/501`).map((c) => c.body?.regular_price)).toContain('26.00');
    expect(await channelsOf('prod_sc_dupe')).toEqual([]);
  });

  it('publishes to Shopify (SKU lookup over GraphQL, then a REST create)', async () => {
    const res = await publish('prod_sc_shop', { connectionId: 'conn_shop' });
    expect(res.status).toBe(201);
    expect(await dataOf(res)).toMatchObject({
      provider: 'shopify',
      displayName: 'Shopify shop',
      externalId: '7001',
      externalUrl: `${SHOP}/products/shop-gloves`,
      price: '12.50',
      listingStatus: 'active',
    });
    const lookup = storeCalls('POST', `${SHOP_API}graphql.json`);
    expect(lookup.map((c) => (c.body?.variables as { q?: string } | undefined)?.q)).toContain('sku:SC-SHOP');
    expect(storeCalls('POST', `${SHOP_API}products.json`).length).toBeGreaterThan(0);
    const [mapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(eq(schema.integrationEntityMappings.internalEntityId, 'prod_sc_shop'));
    expect(mapping?.externalEntityType).toBe('shopify_product');
  });

  it('re-links a listing that is no longer active, on a connection in sync_error', async () => {
    const res = await publish('prod_sc_relink', { connectionId: 'conn_err' });
    expect(res.status).toBe(201);
    expect(await dataOf(res)).toMatchObject({
      id: 'psch_relink',
      connectionId: 'conn_err',
      displayName: 'Flaky store',
      externalId: '902',
      externalUrl: `${FLAKY}/product/902`,
      status: 'active',
      listingStatus: 'active',
    });
    expect(storeCalls('POST', `${FLAKY}/wp-json/wc/v3/products`).length).toBeGreaterThan(0);
  });

  it('refuses a product that is already listed there (409)', async () => {
    const res = await publish('prod_sc_listed', { connectionId: 'conn_woo' });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toEqual({ code: 'CONFLICT', message: 'This product is already listed on that sales channel' });
    expect(storeCalls('GET', WOO)).toEqual([]);
  });

  it('refuses connections it cannot publish to (400)', async () => {
    const refusals: Array<[string, string]> = [
      ['conn_off', 'This sales channel is not connected. Reconnect the store and try again.'],
      ['conn_inbound', 'This connection is set to inbound-only. Enable outbound or two-way sync for products to publish.'],
      ['conn_inbound_obj', 'This connection is set to inbound-only. Enable outbound or two-way sync for products to publish.'],
      ['conn_acme', "Unknown connector 'acme'"],
      ['conn_stripe', "Provider 'stripe' does not support pushing catalog products"],
      ['conn_nourl', 'Store URL is required'],
    ];
    for (const [connectionId, message] of refusals) {
      const res = await publish('prod_sc_fail', { connectionId });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message });
    }
    expect(allStoreCalls()).toEqual([]);
  });

  it('refuses a price or listing status the store cannot take (400)', async () => {
    for (const price of [-1, 'abc']) {
      const res = await publish('prod_sc_fail', { connectionId: 'conn_woo', price });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toEqual({ code: 'BAD_REQUEST', message: 'Price must be a non-negative number' });
    }
    // The product's own status is the fallback, and `archived` is not a listing status.
    const archived = await publish('prod_sc_archived', { connectionId: 'conn_woo' });
    expect(archived.status).toBe(400);
    expect(await errorOf(archived)).toEqual({
      code: 'BAD_REQUEST',
      message: 'Listing status must be active, inactive, or draft',
    });
  });

  it('refuses a bad body (400)', async () => {
    expect((await publish('prod_sc_fail', {})).status).toBe(400);
    expect((await publish('prod_sc_fail', { connectionId: '' })).status).toBe(400);
    expect((await publish('prod_sc_fail', { connectionId: 'x'.repeat(31) })).status).toBe(400);
    expect((await publish('prod_sc_fail', { connectionId: 'conn_woo', listingStatus: 'live' })).status).toBe(400);
    expect((await publish('prod_sc_fail', { connectionId: 'conn_woo', price: true })).status).toBe(400);
  });

  it('404s for a missing product or connection', async () => {
    for (const productId of ['prod_nope', 'prod_sc_deleted']) {
      const res = await publish(productId, { connectionId: 'conn_woo' });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: 'Product not found' });
    }
    for (const connectionId of ['conn_nope', 'conn_gone']) {
      const res = await publish('prod_sc_fail', { connectionId });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: 'Sales channel not found' });
    }
  });

  it('answers 500 with the store message when the store refuses, and records nothing', async () => {
    const res = await publish('prod_sc_fail', { connectionId: 'conn_woo' });
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toEqual({ code: 'INTERNAL_ERROR', message: 'WooCommerce request failed (400)' });
    expect(await channelsOf('prod_sc_fail')).toEqual([]);
  });
});

// ── PATCH /:id/sales-channels/:channelId ─────────────────────────────────────

describe('PATCH /api/products/:id/sales-channels/:channelId', () => {
  it('pushes a new price, keeping the listing status', async () => {
    const res = await patchChannel('prod_sc_edit', 'psch_edit', { price: 21.5 });
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toMatchObject({
      id: 'psch_edit',
      externalId: '600',
      externalUrl: `${WOO}/product/600`,
      price: '21.50',
      listingStatus: 'active',
    });
    expect(storeCalls('PUT', `${WOO_API}products/600`).map((c) => c.body)).toContainEqual(
      expect.objectContaining({ regular_price: '21.50', status: 'publish', sku: 'SC-EDIT' }),
    );
  });

  it('pushes a new listing status, keeping the channel price', async () => {
    const res = await patchChannel('prod_sc_edit', 'psch_edit', { listingStatus: 'draft' });
    expect(res.status).toBe(200);
    expect(await dataOf(res)).toMatchObject({ id: 'psch_edit', price: '21.50', listingStatus: 'draft' });
    expect(storeCalls('PUT', `${WOO_API}products/600`).map((c) => c.body)).toContainEqual(
      expect.objectContaining({ regular_price: '21.50', status: 'draft' }),
    );
  });

  it('refuses a body with neither field, and bad values (400)', async () => {
    const empty = await patchChannel('prod_sc_edit', 'psch_edit', {});
    expect(empty.status).toBe(400);
    expect(JSON.stringify(await empty.json())).toContain('Provide a price or listing status');
    expect((await patchChannel('prod_sc_edit', 'psch_edit', { listingStatus: 'live' })).status).toBe(400);
    const negative = await patchChannel('prod_sc_edit', 'psch_edit', { price: '-5' });
    expect(negative.status).toBe(400);
    expect(await errorOf(negative)).toEqual({ code: 'BAD_REQUEST', message: 'Price must be a non-negative number' });
  });

  it('refuses a listing on a connection that is no longer connected (400)', async () => {
    const res = await patchChannel('prod_sc_editoff', 'psch_editoff', { price: 5 });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toEqual({
      code: 'BAD_REQUEST',
      message: 'This sales channel is not connected. Reconnect the store and try again.',
    });
  });

  it('404s for a missing product or listing, or a listing of another product', async () => {
    const product = await patchChannel('prod_nope', 'psch_edit', { price: 5 });
    expect(product.status).toBe(404);
    expect(await errorOf(product)).toEqual({ code: 'NOT_FOUND', message: 'Product not found' });
    for (const [productId, channelId] of [
      ['prod_sc_edit', 'psch_nope'],
      ['prod_sc_del', 'psch_edit'],
    ]) {
      const res = await patchChannel(productId!, channelId!, { price: 5 });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: 'Sales channel listing not found' });
    }
  });

  it('answers 500 with the store message when the store refuses, and keeps the row', async () => {
    const res = await patchChannel('prod_sc_editfail', 'psch_editfail', { price: 5 });
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toEqual({ code: 'INTERNAL_ERROR', message: 'WooCommerce request failed (400)' });
    expect((await channelRow('psch_editfail'))?.price).toBeNull();
  });
});

// ── DELETE /:id/sales-channels/:channelId ────────────────────────────────────

describe('DELETE /api/products/:id/sales-channels/:channelId', () => {
  it('deletes the store listing, then the local row', async () => {
    const res = await unlink('prod_sc_del', 'psch_del');
    expect(res.status).toBe(204);
    expect(await channelRow('psch_del')).toBeUndefined();
    const deletes = storeCalls('DELETE', `${WOO_API}products/700`);
    expect(deletes.length).toBeGreaterThan(0);
    expect(new URL(deletes[0]!.url).searchParams.get('force')).toBe('true');
  });

  it('keeps the local row when the store refuses (500 with the store message)', async () => {
    const res = await unlink('prod_sc_delfail', 'psch_delfail');
    expect(res.status).toBe(500);
    expect(await errorOf(res)).toEqual({ code: 'INTERNAL_ERROR', message: 'WooCommerce request failed (400)' });
    expect(await channelRow('psch_delfail')).toBeDefined();
  });

  it('404s when the connection is gone, and keeps the row', async () => {
    const res = await unlink('prod_sc_delgone', 'psch_delgone');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: 'Sales channel connection not found' });
    expect(await channelRow('psch_delgone')).toBeDefined();
  });

  it('404s for a missing product or listing', async () => {
    const product = await unlink('prod_nope', 'psch_delfail');
    expect(product.status).toBe(404);
    expect(await errorOf(product)).toEqual({ code: 'NOT_FOUND', message: 'Product not found' });
    const listing = await unlink('prod_sc_delfail', 'psch_nope');
    expect(listing.status).toBe(404);
    expect(await errorOf(listing)).toEqual({ code: 'NOT_FOUND', message: 'Sales channel listing not found' });
  });
});

// ── the plain product routes' refusals and delete ────────────────────────────

describe('product reads, update and delete on a missing row', () => {
  it('GET /:id and GET /:id/sales-channels 404 for a missing or deleted product', async () => {
    const request = api('products:read');
    for (const id of ['prod_nope', 'prod_sc_deleted']) {
      const one = await request(`${BASE}/${id}`);
      expect(one.status).toBe(404);
      expect(await errorOf(one)).toEqual({ code: 'NOT_FOUND', message: `Product with ID '${id}' not found` });
      expect((await request(`${BASE}/${id}/sales-channels`)).status).toBe(404);
    }
  });

  it('PATCH /:id 404s for a missing product', async () => {
    const res = await api('products:update')(`${BASE}/prod_nope`, json({ name: 'Ghost' }, 'PATCH'));
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toEqual({ code: 'NOT_FOUND', message: "Product with ID 'prod_nope' not found" });
  });

  it('DELETE /:id soft-deletes the product, then 404s', async () => {
    const remove = api('products:delete', 'products:read');
    expect((await remove(`${BASE}/prod_sc_bye`, { method: 'DELETE' })).status).toBe(204);
    const [row] = await db
      .select({ deletedAt: schema.products.deletedAt })
      .from(schema.products)
      .where(eq(schema.products.id, 'prod_sc_bye'))
      .limit(1);
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect((await remove(`${BASE}/prod_sc_bye`)).status).toBe(404);

    const again = await remove(`${BASE}/prod_sc_bye`, { method: 'DELETE' });
    expect(again.status).toBe(404);
    expect(await errorOf(again)).toEqual({ code: 'NOT_FOUND', message: "Product with ID 'prod_sc_bye' not found" });
  });
});
