/**
 * Connector sync on a real (pglite) tenant database: "Sync now"
 * (`POST /api/connectors/connections/:id/sync`, run in the background) and the
 * internal catch-up (`POST /api/integrations/connections/:id/catch-up`) for
 * WooCommerce, Shopify, Picqer, Moneybird and Stripe against a fetch stub
 * answering by URL. What each import wrote is read back: products with their
 * variants and sales channels, orders with their items, people, WMS rows,
 * WeldBooks parties, invoices, bank accounts and statement lines, the sync
 * runs and the watermarks; a second pass finds nothing changed.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { asc, eq } from 'drizzle-orm';
import { conformanceTenantDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const holder = vi.hoisted(() => ({ tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant as Database),
  };
});

import { connectorRoutes } from './index';
import { integrationsInternalRoutes } from '../integrations/internal';

const SECRET = 'internal-test-secret';
const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// ── WooCommerce ──────────────────────────────────────────────────────────

const WOO_PRODUCTS = [
  {
    id: 11,
    name: 'Linen shirt',
    slug: 'linen-shirt',
    type: 'simple',
    status: 'publish',
    sku: 'SKU-11',
    price: '19.99',
    regular_price: '24.99',
    description: '<p>Soft linen</p>',
    short_description: 'Linen',
    permalink: 'https://shop.example/product/linen-shirt',
    manage_stock: true,
    stock_quantity: 8,
    weight: '0.3',
    dimensions: { length: '30', width: '20', height: '2' },
    images: [{ id: 401, src: 'https://shop.example/img/shirt.png', alt: 'Shirt' }],
    date_created_gmt: '2026-02-01T09:00:00',
    date_modified_gmt: '2026-02-10T09:00:00',
  },
  {
    id: 12,
    name: 'Hoodie',
    type: 'variable',
    status: 'draft',
    price: '45',
    attributes: [{ name: 'Size', options: ['S', 'M'] }],
    date_modified_gmt: '2026-02-11T09:00:00',
  },
];

const WOO_VARIATIONS = [
  { id: 121, sku: 'HOOD-S', price: '45.00', status: 'publish', manage_stock: true, stock_quantity: 3, menu_order: 0, attributes: [{ name: 'Size', option: 'S' }] },
  { id: 122, sku: 'HOOD-M', price: '47.50', status: 'private', stock_quantity: '2', attributes: [{ name: 'Size', option: 'M' }] },
];

const WOO_ORDERS = [
  {
    id: 501,
    number: '501',
    status: 'completed',
    currency: 'EUR',
    total: '44.98',
    subtotal: '39.98',
    total_tax: '5.00',
    shipping_total: '0.00',
    discount_total: '0.00',
    customer_id: 31,
    payment_method_title: 'iDEAL',
    date_paid_gmt: '2026-02-12T10:00:00',
    date_completed_gmt: '2026-02-13T10:00:00',
    date_modified_gmt: '2026-02-13T10:00:00',
    customer_note: 'Leave at the door',
    billing: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: '+31 6 1234 5678', address_1: 'Main 1', city: 'Utrecht', postcode: '3511AA', country: 'NL' },
    shipping: { first_name: 'Ada', last_name: 'Lovelace', address_1: 'Main 1', city: 'Utrecht', postcode: '3511AA', country: 'NL' },
    line_items: [
      { product_id: 11, name: 'Linen shirt', sku: 'SKU-11', quantity: 2, price: 19.99, total: '39.98', image: { src: 'https://shop.example/img/shirt.png' } },
      { product_id: 0, name: 'Gift wrap', quantity: 1, price: 0, total: '0.00' },
    ],
  },
  { id: 502, status: 'trash' },
];

const WOO_CUSTOMERS = [
  {
    id: 31,
    email: 'ada@example.com',
    first_name: 'Ada',
    last_name: 'Lovelace',
    avatar_url: 'https://gravatar.example/ada',
    billing: { phone: '+31 6 1234 5678', address_1: 'Main 1', city: 'Utrecht', postcode: '3511AA', country: 'NL' },
    date_modified_gmt: '2026-02-09T09:00:00',
  },
];

function woo(url: URL): Response {
  const resource = url.pathname.replace('/wp-json/wc/v3/', '');
  // Customers reject `modified_after`, as WooCommerce does.
  if (resource === 'customers' && url.searchParams.has('modified_after')) return json({ code: 'rest_invalid_param' }, {}, 400);
  if (resource === 'products') return json(WOO_PRODUCTS, { 'X-WP-Total': '2', 'X-WP-TotalPages': '1' });
  if (resource === 'products/12/variations') return json(WOO_VARIATIONS);
  if (resource === 'orders') return json(WOO_ORDERS, { 'X-WP-Total': '2', 'X-WP-TotalPages': '1' });
  if (resource === 'customers') return json(WOO_CUSTOMERS, { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' });
  return json({ code: 'rest_no_route' }, {}, 404);
}

// ── Shopify ──────────────────────────────────────────────────────────────

function shopify(url: URL): Response {
  if (url.pathname !== '/admin/api/2024-10/products.json') return json({ errors: 'Not Found' }, {}, 404);
  if (url.searchParams.get('page_info') === 'next-page') {
    return json({
      products: [
        { id: 7002, title: 'Teapot', status: 'archived', vendor: 'Acme', product_type: 'Kitchen', variants: [{ id: 9002, sku: 'TEA-1', price: '30.00', inventory_quantity: 0 }], updated_at: '2026-03-02T08:00:00Z' },
      ],
    });
  }
  return json(
    {
      products: [
        {
          id: 7001,
          title: 'Mug',
          handle: 'mug',
          body_html: '<p>A mug</p>',
          status: 'active',
          vendor: 'Acme',
          options: [{ name: 'Colour' }],
          variants: [
            { id: 9001, sku: 'MUG-W', price: '12.00', compare_at_price: '15.00', inventory_quantity: 3, inventory_management: 'shopify', option1: 'White', position: 1 },
            { id: 9003, sku: 'MUG-B', price: '12.00', inventory_quantity: 1, inventory_management: 'shopify', option1: 'Black', position: 2 },
          ],
          images: [{ id: 1, src: 'https://cdn.shopify.example/mug.png', alt: 'Mug' }],
          created_at: '2026-03-01T08:00:00Z',
          updated_at: '2026-03-01T09:00:00Z',
        },
      ],
    },
    { Link: '<https://acme.myshopify.com/admin/api/2024-10/products.json?limit=100&page_info=next-page>; rel="next"' },
  );
}

// ── Picqer ───────────────────────────────────────────────────────────────

function picqer(url: URL): Response {
  const resource = url.pathname.replace('/api/v1/', '');
  if (resource === 'products') {
    return json([
      { idproduct: 1, productcode: 'PQ-1', name: 'Box', price: 4.5, active: true, barcode: '8712345678901', stock: [{ idwarehouse: 10, stock: 7, reserved: 1, freestock: 6 }] },
      { idproduct: 2, productcode: 'PQ-2', name: 'Tape', price: 1.25, active: false, unlimitedstock: true },
    ]);
  }
  if (resource === 'warehouses') return json([{ idwarehouse: 10, name: 'Main', accepts_orders: true, priority: 1 }, { idwarehouse: 11, name: 'Overflow', priority: 2 }]);
  if (resource === 'suppliers') return json([{ idsupplier: 3, name: 'Acme Supply', contactname: 'Bob', emailaddress: 'sup@acme.example', telephone: '+31 20 123', address: 'Dock 4', city: 'Amsterdam', zipcode: '1011AA', country: 'NL' }]);
  return json({ error: true }, {}, 404);
}

// ── Moneybird ────────────────────────────────────────────────────────────

const MB_CONTACT = {
  id: 'c1',
  company_name: 'Acme BV',
  firstname: 'Jan',
  lastname: 'Jansen',
  email: 'info@acme.example',
  phone: '+31 30 123',
  tax_number: 'NL123456789B01',
  chamber_of_commerce: '12345678',
  address1: 'Kade 1',
  city: 'Utrecht',
  zipcode: '3511AA',
  country: 'NL',
  sepa_iban: 'NL91ABNA0417164300',
  customer_id: '1001',
  updated_at: '2026-03-01T09:00:00.000Z',
};

function moneybird(url: URL, method: string): Response {
  const path = url.pathname.replace('/api/v2/adm1/', '').replace(/\.json$/, '');
  if (path === 'contacts') return json([MB_CONTACT]);
  if (path === 'sales_invoices') {
    return json([
      {
        id: 'si1',
        invoice_id: '2026-001',
        contact_id: 'c1',
        contact: MB_CONTACT,
        state: 'paid',
        invoice_date: '2026-03-01',
        due_date: '2026-03-15',
        paid_at: '2026-03-05',
        currency: 'EUR',
        total_price_excl_tax: '100.0',
        total_price_incl_tax: '121.0',
        reference: 'PO-77',
        details: [
          { description: 'Consulting', amount: '2 uur', price: '50.0', total_price_excl_tax_with_discount: '100.0', total_price_incl_tax_with_discount: '121.0', product_id: null },
        ],
        attachments: [],
        updated_at: '2026-03-05T10:00:00.000Z',
      },
      { id: 'si2', invoice_id: '2026-002', contact_id: 'c-unknown', state: 'open', invoice_date: '2026-03-02', updated_at: '2026-03-06T10:00:00.000Z' },
    ]);
  }
  if (path === 'financial_accounts') {
    return json([
      { id: 'fa1', name: '', identifier: 'NL91 ABNA 0417 1643 00', currency: 'EUR', type: 'BankAccount', provider: 'ABN AMRO', active: true },
    ]);
  }
  if (path === 'financial_mutations/synchronization' && method === 'GET') return json([{ id: 'm1', version: 1767225600 }, { id: 'm2', version: 1767225700 }]);
  if (path === 'financial_mutations/synchronization' && method === 'POST') {
    return json([
      { id: 'm1', financial_account_id: 'fa1', amount: '121.0', date: '2026-03-06', message: 'Payment 2026-001', contra_account_name: 'Acme BV', contra_account_number: 'NL02 RABO 0123 4567 89', state: 'processed', batch_reference: 'B1', updated_at: '2026-03-06T10:00:00.000Z' },
      { id: 'm2', financial_account_id: 'fa_archived', amount: '-12,50', date: '2026-03-07', code: 'FEE', state: 'unprocessed', updated_at: '2026-03-07T10:00:00.000Z' },
    ]);
  }
  return json({ error: 'not found' }, {}, 404);
}

// ── Stripe ───────────────────────────────────────────────────────────────

function stripe(url: URL): Response {
  const path = url.pathname.replace('/v1/', '');
  if (path === 'invoices') {
    return json({
      object: 'list',
      has_more: false,
      data: [
        {
          id: 'in_1',
          number: 'ACME-0001',
          status: 'paid',
          currency: 'eur',
          created: 1767225600,
          status_transitions: { finalized_at: 1767225600, paid_at: 1767229200 },
          customer: 'cus_1',
          customer_name: 'Acme BV',
          customer_email: 'billing@acme.example',
          customer_address: { line1: 'Kade 1', city: 'Utrecht', postal_code: '3511AA', country: 'nl' },
          customer_tax_ids: [{ type: 'eu_vat', value: 'NL123456789B01' }],
          subtotal_excluding_tax: 10000,
          tax: 2100,
          total: 12100,
          amount_paid: 12100,
          amount_remaining: 0,
          hosted_invoice_url: 'https://invoice.stripe.com/i/acct_1/in_1',
          total_tax_amounts: [{ amount: 2100, taxable_amount: 10000, taxability_reason: 'standard_rated', tax_rate: { id: 'txr_21', percentage: 21, country: 'NL', display_name: 'VAT' } }],
          lines: { has_more: false, data: [{ id: 'il_1', description: 'Pro plan', quantity: 1, amount: 10000, amount_excluding_tax: 10000, period: { start: 1767225600, end: 1769904000 }, tax_amounts: [{ amount: 2100, taxable_amount: 10000, tax_rate: 'txr_21' }], discount_amounts: [] }] },
        },
        { id: 'in_draft', status: 'draft', created: 1767225600, lines: { data: [] } },
      ],
    });
  }
  if (path === 'balance') return json({ object: 'balance', available: [{ amount: 5000, currency: 'eur' }, { amount: 700, currency: 'usd' }], pending: [{ amount: 100, currency: 'eur' }] });
  if (path === 'payouts') {
    return json({ object: 'list', has_more: false, data: [{ id: 'po_1', object: 'payout', amount: 11905, currency: 'eur', automatic: true, status: 'paid', created: 1767312000, arrival_date: 1767398400, balance_transaction: 'txn_po' }] });
  }
  if (path === 'balance_transactions') {
    return json({
      object: 'list',
      has_more: false,
      data: [
        { id: 'txn_ch', type: 'charge', amount: 12100, fee: 195, currency: 'eur', created: 1767229200, available_on: 1767312000, reporting_category: 'charge', description: 'Invoice ACME-0001', source: { id: 'ch_1', object: 'charge', invoice: 'in_1', billing_details: { name: 'Acme BV' } } },
        { id: 'txn_po', type: 'payout', amount: -11905, fee: 0, currency: 'eur', created: 1767312000, available_on: 1767312000, reporting_category: 'payout', source: 'po_1' },
      ],
    });
  }
  return json({ error: { message: 'Unrecognized request URL' } }, {}, 404);
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(href)) return realFetch(input, init);
      const url = new URL(href);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.hostname === 'shop.example') return woo(url);
      if (url.hostname === 'acme.myshopify.com') return shopify(url);
      if (url.hostname === 'acme.picqer.com') return picqer(url);
      if (url.hostname === 'moneybird.com') return moneybird(url, method);
      if (url.hostname === 'api.stripe.com') return stripe(url);
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;
const at = new Date('2026-01-15T10:00:00.000Z');

function connection(values: Partial<typeof schema.connectorConnections.$inferInsert>) {
  return { status: 'active', createdAt: at, updatedAt: at, connectedAt: at, ...values } as typeof schema.connectorConnections.$inferInsert;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  holder.tenant = db;
  await db.insert(schema.connectorConnections).values([
    connection({ id: 'ccn_syncwoo000001', provider: 'woocommerce', displayName: 'Shop', credentials: { storeUrl: 'https://shop.example', consumerKey: 'ck_1', consumerSecret: 'cs_1' }, externalAccountId: 'https://shop.example', enabledSyncs: ['products', 'orders', 'customers'] }),
    connection({ id: 'ccn_syncshop00001', provider: 'shopify', displayName: 'Acme Shopify', credentials: { shopDomain: 'acme', accessToken: 'shpat_1' }, externalAccountId: 'https://acme.myshopify.com', enabledSyncs: ['products'] }),
    connection({ id: 'ccn_syncpq0000001', provider: 'picqer', displayName: 'Picqer', credentials: { subdomain: 'acme', apiKey: 'pq_1' }, enabledSyncs: ['products', 'inventory', 'warehouses', 'suppliers'] }),
    connection({ id: 'ccn_syncmb0000001', provider: 'moneybird', displayName: 'Moneybird', credentials: { accessToken: 'mb-token', administrationId: 'adm1', entityId: 'ent_books0000001' }, externalAccountId: 'adm1', enabledSyncs: ['contacts', 'invoices', 'bankTransactions'] }),
    connection({ id: 'ccn_syncstripe001', provider: 'stripe', displayName: 'Stripe', credentials: { apiKey: 'rk_live_1', entityId: 'ent_books0000001' }, externalAccountId: 'acct_1', enabledSyncs: ['invoices', 'bankAccounts', 'bankTransactions'] }),
    connection({ id: 'ccn_syncpaused001', provider: 'woocommerce', status: 'paused', credentials: { storeUrl: 'https://shop.example', consumerKey: 'ck_1', consumerSecret: 'cs_1' } }),
    connection({ id: 'ccn_syncout000001', provider: 'shopify', credentials: { shopDomain: 'acme', accessToken: 'shpat_1' }, direction: 'outbound', enabledSyncs: ['products'] }),
  ]);
}, 60_000);

function app(...granted: string[]) {
  return createTestApp<Env, Variables>('/api/connectors', connectorRoutes, {
    context: { tenantDb: db, permissions: permissions(...(granted.length ? granted : ['integrations:read', 'integrations:update'])) },
  }).request;
}

const internalRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
internalRoutes.route('/', integrationsInternalRoutes);

function internalApp() {
  return createTestApp<Env, Variables>('/api/integrations', internalRoutes, {
    context: { tenantDb: db, permissions: permissions() },
    env: { INTERNAL_API_SECRET: SECRET } as never,
  }).request;
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const internalPost = (): RequestInit => ({
  method: 'POST',
  headers: { 'X-Internal-Secret': SECRET, 'X-Workspace-Id': 'org_test_default' },
});

/** The connection's runs, by sync name, then in the order they ran. */
async function runs(connectionId: string) {
  const rows = await db
    .select({ syncName: schema.connectorSyncRuns.syncName, status: schema.connectorSyncRuns.status, trigger: schema.connectorSyncRuns.trigger, syncType: schema.connectorSyncRuns.syncType, recordsCreated: schema.connectorSyncRuns.recordsCreated, recordsModified: schema.connectorSyncRuns.recordsModified, recordsSkipped: schema.connectorSyncRuns.recordsSkipped, recordsDeleted: schema.connectorSyncRuns.recordsDeleted, recordsFailed: schema.connectorSyncRuns.recordsFailed, error: schema.connectorSyncRuns.error, errorSamples: schema.connectorSyncRuns.errorSamples })
    .from(schema.connectorSyncRuns)
    .where(eq(schema.connectorSyncRuns.connectionId, connectionId))
    .orderBy(asc(schema.connectorSyncRuns.createdAt));
  return rows.map((row, index) => ({ row, index })).sort((a, b) => (a.row.syncName === b.row.syncName ? a.index - b.index : a.row.syncName < b.row.syncName ? -1 : 1)).map(({ row }) => row);
}

/**
 * Waits until `count` runs of the connection have finished and the connection
 * row carries the last one (the sync runs after the response, in the
 * background; the conformance harness has already waited for it).
 */
async function settled(connectionId: string, count: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const rows = await db
      .select({ status: schema.connectorSyncRuns.status, finishedAt: schema.connectorSyncRuns.finishedAt })
      .from(schema.connectorSyncRuns)
      .where(eq(schema.connectorSyncRuns.connectionId, connectionId));
    const finished = rows.filter((row) => row.status !== 'running' && row.finishedAt);
    if (finished.length >= count) {
      const last = Math.max(...finished.map((row) => row.finishedAt!.getTime()));
      const [conn] = await db.select({ lastSyncAt: schema.connectorConnections.lastSyncAt }).from(schema.connectorConnections).where(eq(schema.connectorConnections.id, connectionId));
      if (conn?.lastSyncAt && conn.lastSyncAt.getTime() >= last) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${connectionId}: ${count} runs did not finish`);
}

async function connectionRow(id: string) {
  const [row] = await db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.id, id));
  return row!;
}

async function mappings(connectionId: string) {
  return db
    .select({ type: schema.integrationEntityMappings.externalEntityType, externalId: schema.integrationEntityMappings.externalEntityId, internalType: schema.integrationEntityMappings.internalEntityType, internalId: schema.integrationEntityMappings.internalEntityId, checksum: schema.integrationEntityMappings.syncChecksum })
    .from(schema.integrationEntityMappings)
    .where(eq(schema.integrationEntityMappings.connectionId, connectionId))
    .orderBy(asc(schema.integrationEntityMappings.externalEntityType), asc(schema.integrationEntityMappings.externalEntityId));
}

describe('POST /connections/:id/sync', () => {
  it('imports WooCommerce products, orders and customers, then skips what did not change', async () => {
    const res = await app()('/api/connectors/connections/ccn_syncwoo000001/sync', post());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ triggered: ['products', 'orders', 'customers'], full: false });
    await settled('ccn_syncwoo000001', 3);

    const products = await db.select().from(schema.products).orderBy(asc(schema.products.sku));
    expect(products.map((p) => [p.name, p.slug, p.sku, p.price, p.compareAtPrice, p.status, p.hasVariants, p.variantCount, p.trackInventory, p.inventoryQuantity, p.weight, p.featuredImageUrl])).toEqual([
      ['Linen shirt', 'linen-shirt', 'SKU-11', '19.99', '24.99', 'active', false, 0, true, 8, '0.300', 'https://shop.example/img/shirt.png'],
      ['Hoodie', 'hoodie', null, '45.00', null, 'draft', true, 2, false, 0, null, null],
    ]);
    const shirt = products.find((p) => p.sku === 'SKU-11')!;
    expect(shirt).toMatchObject({ description: '<p>Soft linen</p>', shortDescription: 'Linen', currency: 'EUR', createdBy: 'user_test_default', images: [{ url: 'https://shop.example/img/shirt.png', altText: 'Shirt', id: '401' }] });
    expect(shirt.publishedAt?.toISOString()).toBe('2026-02-01T09:00:00.000Z');

    const hoodie = products.find((p) => p.name === 'Hoodie')!;
    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, hoodie.id)).orderBy(asc(schema.productVariants.sku));
    expect(variants.map((v) => [v.name, v.sku, v.price, v.inventoryQuantity, v.trackInventory, v.status, v.position, v.optionValues, v.attributes])).toEqual([
      ['S', 'HOOD-S', '45.00', 3, true, 'active', 0, [{ name: 'Size', value: 'S' }], { externalId: '121' }],
      ['M', 'HOOD-M', '47.50', 2, false, 'inactive', 1, [{ name: 'Size', value: 'M' }], { externalId: '122' }],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));

    const channels = await db.select().from(schema.productSalesChannels).orderBy(asc(schema.productSalesChannels.externalId));
    expect(channels.map((c) => [c.externalId, c.externalUrl, c.price, c.listingStatus, c.status, c.displayName, c.provider])).toEqual([
      ['11', 'https://shop.example/product/linen-shirt', '19.99', 'active', 'active', 'Shop', 'woocommerce'],
      ['12', 'https://shop.example/?p=12', '45.00', 'draft', 'active', 'Shop', 'woocommerce'],
    ]);

    const [order] = await db.select().from(schema.orders);
    expect(order).toMatchObject({
      orderNumber: '501',
      externalOrderId: '501',
      source: 'woocommerce',
      status: 'completed',
      paymentStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
      customerEmail: 'ada@example.com',
      customerName: 'Ada Lovelace',
      customerPhone: '+31 6 1234 5678',
      total: '44.98',
      taxTotal: '5.00',
      itemCount: 2,
      totalQuantity: 3,
      paymentMethod: 'iDEAL',
      customerNote: 'Leave at the door',
      billingAddress: { line1: 'Main 1', city: 'Utrecht', postalCode: '3511AA', country: 'NL', name: 'Ada Lovelace', phone: '+31 6 1234 5678' },
      personId: null,
    });
    expect(order!.paidAt?.toISOString()).toBe('2026-02-12T10:00:00.000Z');
    const items = await db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, order!.id)).orderBy(asc(schema.orderItems.name));
    expect(items.map((i) => [i.name, i.sku, i.quantity, i.unitPrice, i.total, i.productId === shirt.id])).toEqual([
      ['Gift wrap', null, 1, '0.00', '0.00', false],
      ['Linen shirt', 'SKU-11', 2, '19.99', '39.98', true],
    ]);

    const [person] = await db.select().from(schema.people).where(eq(schema.people.email, 'ada@example.com'));
    expect(person).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace', displayName: 'Ada Lovelace', directPhone: '+31 6 1234 5678', avatarUrl: 'https://gravatar.example/ada', source: 'woocommerce', inCrm: true, ownerId: 'user_test_default', primaryAddress: { line1: 'Main 1', city: 'Utrecht', postalCode: '3511AA', country: 'NL', phone: '+31 6 1234 5678' } });

    expect((await mappings('ccn_syncwoo000001')).map((m) => [m.type, m.externalId, m.internalType])).toEqual([
      ['woocommerce_customer', '31', 'person'],
      ['woocommerce_order', '501', 'order'],
      ['woocommerce_product', '11', 'product'],
      ['woocommerce_product', '12', 'product'],
    ]);
    expect((await runs('ccn_syncwoo000001')).map((r) => [r.syncName, r.status, r.trigger, r.syncType, r.recordsCreated, r.recordsSkipped])).toEqual([
      ['woocommerce-customers', 'success', 'manual', 'INITIAL', 1, 0],
      ['woocommerce-orders', 'success', 'manual', 'INITIAL', 1, 1],
      ['woocommerce-products', 'success', 'manual', 'INITIAL', 2, 0],
    ]);
    const after = await connectionRow('ccn_syncwoo000001');
    expect(after).toMatchObject({ status: 'active', lastSyncStatus: 'success', lastError: null, recordsSynced: 4 });
    expect(after.syncWatermarks).toEqual({ WooProduct: '2026-02-11T09:00:00', WooOrder: '2026-02-13T10:00:00', WooCustomer: '2026-02-09T09:00:00' });

    // The next pass reads from the watermarks (customers retry without the filter) and changes nothing.
    const again = await app()('/api/connectors/connections/ccn_syncwoo000001/sync', post({ syncs: ['orders', 'customers'] }));
    expect(((await again.json()) as { data: unknown }).data).toEqual({ triggered: ['orders', 'customers'], full: false });
    await settled('ccn_syncwoo000001', 5);
    const second = (await runs('ccn_syncwoo000001')).filter((run) => run.syncType === 'INCREMENTAL');
    expect(second.map((r) => [r.syncName, r.syncType, r.recordsCreated, r.recordsModified, r.recordsSkipped])).toEqual([
      ['woocommerce-customers', 'INCREMENTAL', 0, 0, 1],
      ['woocommerce-orders', 'INCREMENTAL', 0, 0, 2],
    ]);
  });

  it('follows Shopify\'s page cursor and keeps a variant per option', async () => {
    const res = await app('integrations:update')('/api/connectors/connections/ccn_syncshop00001/sync', post({ full: true }));
    expect(((await res.json()) as { data: unknown }).data).toEqual({ triggered: ['products'], full: true });
    await settled('ccn_syncshop00001', 1);
    const mug = (await db.select().from(schema.products).where(eq(schema.products.name, 'Mug')))[0]!;
    expect(mug).toMatchObject({ slug: 'mug', sku: 'MUG-W', price: '12.00', compareAtPrice: '15.00', status: 'active', vendor: 'Acme', hasVariants: true, variantCount: 2, trackInventory: true, inventoryQuantity: 3, featuredImageUrl: 'https://cdn.shopify.example/mug.png' });
    const variants = await db.select().from(schema.productVariants).where(eq(schema.productVariants.productId, mug.id)).orderBy(asc(schema.productVariants.position));
    expect(variants.map((v) => [v.name, v.sku, v.optionValues])).toEqual([
      ['White', 'MUG-W', [{ name: 'Colour', value: 'White' }]],
      ['Black', 'MUG-B', [{ name: 'Colour', value: 'Black' }]],
    ]);
    const teapot = (await db.select().from(schema.products).where(eq(schema.products.name, 'Teapot')))[0]!;
    expect(teapot).toMatchObject({ slug: 'teapot', sku: 'TEA-1', status: 'inactive', productType: 'Kitchen', hasVariants: false });
    const channels = await db.select().from(schema.productSalesChannels).where(eq(schema.productSalesChannels.connectionId, 'ccn_syncshop00001')).orderBy(asc(schema.productSalesChannels.externalId));
    expect(channels.map((c) => [c.externalId, c.externalUrl, c.listingStatus])).toEqual([
      ['7001', 'https://acme.myshopify.com/products/mug', 'active'],
      ['7002', 'https://acme.myshopify.com/products/teapot', 'inactive'],
    ]);
    expect((await runs('ccn_syncshop00001')).map((r) => [r.syncName, r.status, r.syncType, r.recordsCreated])).toEqual([['shopify-products', 'success', 'FULL', 2]]);
    expect((await connectionRow('ccn_syncshop00001')).syncWatermarks).toEqual({ ShopifyProduct: '2026-03-02T08:00:00Z' });
  });

  it('imports Picqer products, stock per warehouse, warehouses and suppliers', async () => {
    await app()('/api/connectors/connections/ccn_syncpq0000001/sync', post({}));
    await settled('ccn_syncpq0000001', 4);
    const box = (await db.select().from(schema.products).where(eq(schema.products.sku, 'PQ-1')))[0]!;
    expect(box).toMatchObject({ name: 'Box', price: '4.50', status: 'active', barcode: '8712345678901', trackInventory: true, inventoryQuantity: 6 });
    const tape = (await db.select().from(schema.products).where(eq(schema.products.sku, 'PQ-2')))[0]!;
    expect(tape).toMatchObject({ status: 'inactive', trackInventory: false });
    const warehouses = await db.select().from(schema.warehouses).orderBy(asc(schema.warehouses.code));
    expect(warehouses.map((w) => [w.name, w.code, w.isActive, w.isDefault, w.priority])).toEqual([
      ['Main', '10', true, true, 1],
      ['Overflow', '11', true, false, 2],
      ['Default warehouse', 'DEFAULT', true, true, 0],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
    const stock = await db.select().from(schema.inventory).orderBy(asc(schema.inventory.quantityOnHand));
    expect(stock.map((s) => [s.productId === box.id, s.quantityOnHand, s.quantityAvailable, s.quantityAllocated, s.status])).toEqual([
      [true, 7, 6, 1, 'available'],
    ]);
    const [supplier] = await db.select().from(schema.suppliers);
    expect(supplier).toMatchObject({ name: 'Acme Supply', code: '3', contactName: 'Bob', email: 'sup@acme.example', phone: '+31 20 123', addressLine1: 'Dock 4', city: 'Amsterdam', postalCode: '1011AA', status: 'active' });
    expect((await runs('ccn_syncpq0000001')).map((r) => [r.syncName, r.status, r.recordsCreated, r.recordsSkipped])).toEqual([
      ['picqer-inventory', 'success', 1, 0],
      ['picqer-products', 'success', 2, 0],
      ['picqer-suppliers', 'success', 1, 0],
      ['picqer-warehouses', 'success', 2, 0],
    ]);
  });

  it('imports Moneybird contacts, invoices and statement lines into WeldBooks', async () => {
    await app()('/api/connectors/connections/ccn_syncmb0000001/sync', post());
    await settled('ccn_syncmb0000001', 4);
    const [party] = await db.select().from(schema.parties).where(eq(schema.parties.displayName, 'Acme BV'));
    expect(party).toMatchObject({ kind: 'company', role: 'customer', iban: 'NL91ABNA0417164300', partyCode: '1001', billingAddress: { line1: 'Kade 1', city: 'Utrecht', postalCode: '3511AA', country: 'NL', name: 'Jan Jansen', phone: '+31 30 123' } });
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, party!.companyId!));
    expect(company).toMatchObject({ name: 'Acme BV', email: 'info@acme.example', vatNumber: 'NL123456789B01', registrationNumber: '12345678', source: 'moneybird' });
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.invoiceNumber, '2026-001'));
    expect(invoice).toMatchObject({ status: 'paid', entityId: 'ent_books0000001', contactId: party!.id, counterpartyId: party!.id, subtotal: '100.00', total: '121.00', amountPaid: '121.00', balanceDue: '0.00', reference: 'PO-77', contactName: 'Acme BV', contactEmail: 'info@acme.example' });
    expect(invoice!.issueDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    const lines = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invoice!.id));
    expect(lines.map((l) => [l.description, l.quantity, l.unitPrice, l.lineTotal, l.lineTotalWithTax])).toEqual([['Consulting', '2.0000', '50.0000', '100.00', '121.00']]);
    const accounts = await db.select().from(schema.bankAccounts).orderBy(asc(schema.bankAccounts.name));
    expect(accounts.map((a) => [a.name, a.iban, a.isActive, a.metadata])).toEqual([
      ['Moneybird account fa_archived', null, false, { stubFromMutation: true, moneybirdFinancialAccountId: 'fa_archived' }],
      ['NL91 ABNA 0417 1643 00', 'NL91ABNA0417164300', true, { moneybirdType: 'BankAccount', moneybirdIdentifier: 'NL91 ABNA 0417 1643 00', moneybirdAccount: false }],
    ]);
    const txns = await db.select().from(schema.bankTransactions).orderBy(asc(schema.bankTransactions.externalId));
    expect(txns.map((t) => [t.externalId, t.amount, t.status, t.description, t.counterpartyName, t.counterpartyIban, t.reference])).toEqual([
      ['m1', '121.00', 'reconciled', 'Payment 2026-001', 'Acme BV', 'NL02RABO0123456789', 'B1'],
      ['m2', '-12.50', 'unreconciled', 'FEE', null, null, 'FEE'],
    ]);
    const mbRuns = await runs('ccn_syncmb0000001');
    expect(mbRuns.map((r) => [r.syncName, r.status, r.recordsCreated, r.recordsFailed, r.error])).toEqual([
      ['moneybird-contacts', 'success', 1, 0, null],
      ['moneybird-financial-accounts', 'success', 1, 0, null],
      ['moneybird-financial-mutations', 'success', 2, 0, null],
      ['moneybird-sales-invoices', 'partial', 1, 1, '1 record(s) failed to import'],
    ]);
    expect(mbRuns.find((r) => r.syncName === 'moneybird-sales-invoices')!.errorSamples).toEqual([
      { externalId: 'si2', message: 'Invoice/bill contact is not mapped — sync contacts first' },
    ]);
    const after = await connectionRow('ccn_syncmb0000001');
    expect(after).toMatchObject({ lastSyncStatus: 'success', status: 'active' });
    expect(after.syncWatermarks).toEqual({ MoneybirdContact: '2026-03-01T09:00:00.000Z', MoneybirdFinancialMutation: '2026-03-07T10:00:00.000Z' });
  });

  it('imports Stripe invoices, balances and payout lines, reconciling the charge', async () => {
    await app()('/api/connectors/connections/ccn_syncstripe001/sync', post({ syncs: ['invoices', 'bankTransactions'] }));
    await settled('ccn_syncstripe001', 3);
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.invoiceNumber, 'ACME-0001'));
    expect(invoice).toMatchObject({ status: 'paid', currency: 'EUR', subtotal: '100.00', taxTotal: '21.00', total: '121.00', amountPaid: '121.00', balanceDue: '0.00', reference: 'in_1', contactTaxNumber: 'NL123456789B01', paymentLink: 'https://invoice.stripe.com/i/acct_1/in_1', billingAddress: { line1: 'Kade 1', city: 'Utrecht', postalCode: '3511AA', country: 'NL' } });
    expect(invoice!.taxBreakdown).toEqual([{ taxRateId: 'txr_21', taxRateName: 'VAT', taxRate: 21, taxableAmount: 100, taxAmount: 21, jurisdictionCode: 'NL', taxCategoryCode: 'standard_rated' }]);
    expect(invoice!.paidAt?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    const [line] = await db.select().from(schema.invoiceItems).where(eq(schema.invoiceItems.invoiceId, invoice!.id));
    expect(line).toMatchObject({ description: 'Pro plan', quantity: '1.0000', unitPrice: '100.0000', taxRate: '21.0000', taxAmount: '21.00', lineTotal: '100.00', lineTotalWithTax: '121.00', period: { from: '2026-01-01', to: '2026-02-01' } });
    const txns = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.entityId, 'ent_books0000001')).orderBy(asc(schema.bankTransactions.externalId));
    const stripeTxns = txns.filter((t) => t.externalId?.startsWith('txn_'));
    expect(stripeTxns.map((t) => [t.externalId, t.amount, t.status, t.reconciledInvoiceId === invoice!.id, t.counterpartyName, t.transactionCode, (t.rawData as { stripeLine?: string }).stripeLine])).toEqual([
      ['txn_ch', '121.00', 'reconciled', true, 'Acme BV', 'charge', 'gross'],
      ['txn_ch_fee', '-1.95', 'unreconciled', false, 'Stripe', 'stripe_fee', 'fee'],
      ['txn_po', '-119.05', 'unreconciled', false, 'Stripe', 'payout', 'payout'],
    ]);
    const [balance] = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.name, 'Stripe balance (EUR)'));
    expect(balance).toMatchObject({ bankName: 'Stripe', currency: 'EUR', isActive: true, metadata: { stripeBalance: true } });
    expect((await runs('ccn_syncstripe001')).map((r) => [r.syncName, r.status, r.recordsCreated, r.recordsSkipped])).toEqual([
      ['stripe-balance-transactions', 'success', 3, 0],
      ['stripe-balances', 'success', 2, 0],
      ['stripe-invoices', 'success', 1, 1],
    ]);
  });

  it('refuses a paused, an unknown and a forbidden sync, and a bad body', async () => {
    const paused = await app()('/api/connectors/connections/ccn_syncpaused001/sync', post());
    expect(paused.status).toBe(400);
    expect(await paused.json()).toMatchObject({ error: { message: 'Connection is paused' } });
    expect((await app()('/api/connectors/connections/ccn_missing000001/sync', post())).status).toBe(404);
    expect((await app('integrations:read')('/api/connectors/connections/ccn_syncwoo000001/sync', post())).status).toBe(403);
    expect((await app()('/api/connectors/connections/ccn_syncwoo000001/sync', post({ syncs: [''] }))).status).toBe(400);
    expect((await app()('/api/connectors/connections/ccn_syncwoo000001/sync', post({ full: 'yes' }))).status).toBe(400);
  });

  it('runs nothing for a connection that only sends', async () => {
    const res = await app()('/api/connectors/connections/ccn_syncout000001/sync', post());
    expect(((await res.json()) as { data: unknown }).data).toEqual({ triggered: ['products'], full: false });
    expect(await runs('ccn_syncout000001')).toEqual([]);
  });
});

describe('POST /api/integrations/connections/:id/catch-up', () => {
  it('runs the scheduled catch-up to the end and answers the watermarks', async () => {
    const res = await internalApp()('/api/integrations/connections/ccn_syncshop00001/catch-up', internalPost());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ watermarks: { ShopifyProduct: '2026-03-02T08:00:00Z' } });
    const latest = (await runs('ccn_syncshop00001')).at(-1)!;
    expect(latest).toMatchObject({ syncName: 'shopify-products', trigger: 'schedule', syncType: 'INCREMENTAL', recordsSkipped: 2 });
  });

  it('refuses a paused or unknown connection and a wrong secret', async () => {
    expect((await internalApp()('/api/integrations/connections/ccn_syncpaused001/catch-up', internalPost())).status).toBe(400);
    expect((await internalApp()('/api/integrations/connections/ccn_missing000001/catch-up', internalPost())).status).toBe(404);
    const wrong = await internalApp()('/api/integrations/connections/ccn_syncshop00001/catch-up', { method: 'POST', headers: { 'X-Internal-Secret': 'nope', 'X-Workspace-Id': 'org_test_default' } });
    expect(wrong.status).toBe(401);
  });
});
