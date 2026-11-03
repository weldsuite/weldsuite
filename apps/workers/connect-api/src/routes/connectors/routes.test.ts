/**
 * `/api/connectors` on a real (pglite) tenant database: the catalog with
 * each connector's connections, a connection with its WeldBooks entity, its
 * sync runs, imported records and field mappings, the credential test
 * against the store (a fetch stub answering by URL) and pause/resume, with
 * the refusals.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const ALL = ['integrations:read', 'integrations:create', 'integrations:update'] as const;

/** The fetch the stub hands loopback calls to: the conformance harness's own. */
const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(url)) return realFetch(input, init);
      if (url.startsWith('https://good-shop.example/')) return json([]);
      if (url.startsWith('https://bad-shop.example/')) return json({ code: 'woocommerce_rest_cannot_view', message: 'Sorry, you cannot list resources.' }, 401);
      if (url.startsWith('https://acme.myshopify.com/admin/api/')) return json({ products: [] });
      if (url.startsWith('https://acme.picqer.com/api/v1/')) return json([]);
      return new Response('not found', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date('2026-02-01T10:00:00.000Z');
  await db.insert(schema.connectorConnections).values([
    {
      id: 'ccn_woo_000000001',
      provider: 'woocommerce',
      displayName: 'WooCommerce (good-shop.example)',
      status: 'active',
      credentials: { storeUrl: 'https://good-shop.example', consumerKey: 'ck_1', consumerSecret: 'cs_1' },
      externalAccountId: 'https://good-shop.example',
      enabledSyncs: ['products'],
      webhookRegistrations: [{ topic: 'product.updated', id: '1' }],
      connectedAt: at,
      connectedBy: 'user_test_default',
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'ccn_mb_0000000001',
      provider: 'moneybird',
      displayName: 'Moneybird',
      status: 'active',
      credentials: { accessToken: 'mb-token', administrationId: '123', entityId: ' ent_books001 ' },
      externalAccountId: '123',
      createdAt: new Date('2026-02-02T10:00:00.000Z'),
      updatedAt: new Date('2026-02-02T10:00:00.000Z'),
    },
    {
      id: 'ccn_pq_0000000001',
      provider: 'picqer',
      displayName: null,
      status: 'pending',
      createdAt: new Date('2026-02-03T10:00:00.000Z'),
      updatedAt: new Date('2026-02-03T10:00:00.000Z'),
    },
  ] as (typeof schema.connectorConnections.$inferInsert)[]);
  await db.insert(schema.connectorSyncRuns).values([
    { id: 'csr_run000000001', connectionId: 'ccn_woo_000000001', syncName: 'woocommerce-products', model: 'WooProduct', status: 'success', trigger: 'manual', createdAt: at },
    { id: 'csr_run000000002', connectionId: 'ccn_woo_000000001', syncName: 'woocommerce-orders', model: 'WooOrder', status: 'error', trigger: 'schedule', error: 'boom', createdAt: new Date('2026-02-01T11:00:00.000Z') },
  ] as (typeof schema.connectorSyncRuns.$inferInsert)[]);
  await db.insert(schema.people).values({ id: 'per_record0000001', displayName: 'Ada Lovelace', fullName: 'Ada Lovelace' } as typeof schema.people.$inferInsert);
  await db.insert(schema.integrationEntityMappings).values([
    { id: 'iem_rec000000001', connectionId: 'ccn_woo_000000001', externalEntityType: 'woocommerce_customer', externalEntityId: '17', internalEntityType: 'person', internalEntityId: 'per_record0000001', lastSyncedAt: at, updatedAt: at },
    { id: 'iem_rec000000002', connectionId: 'ccn_woo_000000001', externalEntityType: 'woocommerce_product', externalEntityId: '99', internalEntityType: 'product', internalEntityId: 'prd_gone00000001', updatedAt: new Date('2026-02-01T12:00:00.000Z') },
  ] as (typeof schema.integrationEntityMappings.$inferInsert)[]);
}, 60_000);

function app(...granted: string[]) {
  return createTestApp<Env, Variables>('/api/connectors', connectorRoutes, {
    context: { tenantDb: db, permissions: permissions(...(granted.length ? granted : ALL)) },
  }).request;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('reading connectors', () => {
  it('lists the catalog with each connector\'s connections', async () => {
    const res = await app('integrations:read')('/api/connectors/catalog');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ provider: string; connectionCount: number; connections: Array<{ entityId: string | null }> }> };
    expect(data.find((c) => c.provider === 'woocommerce')?.connectionCount).toBe(1);
    expect(data.find((c) => c.provider === 'moneybird')?.connections[0].entityId).toBe('ent_books001');
  });

  it('lists connections and reads one', async () => {
    const list = await app()('/api/connectors/connections');
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(3);
    const one = await app()('/api/connectors/connections/ccn_mb_0000000001');
    expect(one.status).toBe(200);
    const pending = await app()('/api/connectors/connections/ccn_pq_0000000001');
    expect(((await pending.json()) as { data: { isConnected: boolean } }).data.isConnected).toBe(false);
    expect((await app()('/api/connectors/connections/ccn_missing0000000')).status).toBe(404);
  });

  it('answers sync runs and imported records', async () => {
    const runs = await app()('/api/connectors/connections/ccn_woo_000000001/runs?limit=1');
    expect(((await runs.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await app()('/api/connectors/connections/ccn_woo_000000001/runs')).status).toBe(200);
    const records = await app()('/api/connectors/connections/ccn_woo_000000001/records');
    const { data } = (await records.json()) as { data: Array<{ label: string }> };
    expect(data.map((r) => r.label)).toEqual(['99', 'Ada Lovelace']);
    expect((await app()('/api/connectors/connections/ccn_missing0000000/runs')).status).toBe(404);
    expect((await app()('/api/connectors/connections/ccn_missing0000000/records')).status).toBe(404);
  });

  it('is refused without integrations:read', async () => {
    expect((await app('companies:read')('/api/connectors/catalog')).status).toBe(403);
  });
});

describe('field mappings', () => {
  it('replaces, lists and suggests mappings', async () => {
    const put = await app('integrations:update')('/api/connectors/connections/ccn_woo_000000001/field-mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'product', mappings: [{ externalFieldPath: 'name', internalFieldPath: 'name' }] }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { data: unknown }).data).toEqual({ entityType: 'product', count: 1 });
    const list = await app()('/api/connectors/connections/ccn_woo_000000001/field-mappings?entityType=product');
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await app()('/api/connectors/connections/ccn_woo_000000001/field-mappings')).status).toBe(200);

    const defaults = await app()('/api/connectors/connections/ccn_woo_000000001/field-mappings/defaults?entityType=product');
    expect(((await defaults.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0);
    const picqer = await app()('/api/connectors/connections/ccn_pq_0000000001/field-mappings/defaults?entityType=product');
    expect(picqer.status).toBe(200);
    expect((await app()('/api/connectors/connections/ccn_woo_000000001/field-mappings/defaults')).status).toBe(400);
  });

  it('refuses an unknown connection and a bad body', async () => {
    expect((await app()('/api/connectors/connections/ccn_missing0000000/field-mappings')).status).toBe(404);
    expect((await app()('/api/connectors/connections/ccn_missing0000000/field-mappings/defaults?entityType=product')).status).toBe(404);
    const missing = await app()('/api/connectors/connections/ccn_missing0000000/field-mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'product', mappings: [] }),
    });
    expect(missing.status).toBe(404);
    const bad = await app()('/api/connectors/connections/ccn_woo_000000001/field-mappings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'product', mappings: [{ externalFieldPath: '' }] }),
    });
    expect(bad.status).toBe(400);
  });
});

describe('POST /test', () => {
  it('tests WooCommerce, Shopify and Picqer credentials', async () => {
    const woo = await app('integrations:create')('/api/connectors/test', post({
      provider: 'woocommerce',
      credentials: { storeUrl: 'good-shop.example', consumerKey: 'ck_1', consumerSecret: 'cs_1' },
    }));
    expect(woo.status).toBe(200);
    expect(((await woo.json()) as { data: unknown }).data).toEqual({ ok: true, storeUrl: 'https://good-shop.example' });
    const shopify = await app()('/api/connectors/test', post({ provider: 'shopify', credentials: { shopDomain: 'acme', accessToken: 'shpat_1' } }));
    expect(shopify.status).toBe(200);
    const picqer = await app()('/api/connectors/test', post({ provider: 'picqer', credentials: { subdomain: 'acme', apiKey: 'pq_1' } }));
    expect(picqer.status).toBe(200);
  });

  it('reports rejected credentials and refuses unknown connectors or bad bodies', async () => {
    const rejected = await app()('/api/connectors/test', post({
      provider: 'woocommerce',
      credentials: { storeUrl: 'https://bad-shop.example', consumerKey: 'ck_x', consumerSecret: 'cs_x' },
    }));
    expect(rejected.status).toBe(400);
    const noStore = await app()('/api/connectors/test', post({ provider: 'shopify', credentials: { accessToken: 'x' } }));
    expect(noStore.status).toBe(400);
    expect((await app()('/api/connectors/test', post({ provider: 'magento', credentials: { a: 'b' } }))).status).toBe(400);
    expect((await app()('/api/connectors/test', post({ provider: 'woocommerce', credentials: { storeUrl: '' } }))).status).toBe(400);
    expect((await app('integrations:read')('/api/connectors/test', post({ provider: 'woocommerce', credentials: {} }))).status).toBe(403);
  });
});

describe('pause and resume', () => {
  it('pauses and resumes a connection', async () => {
    const paused = await app('integrations:update')('/api/connectors/connections/ccn_woo_000000001/pause', { method: 'POST' });
    expect(((await paused.json()) as { data: unknown }).data).toEqual({ status: 'paused' });
    const resumed = await app()('/api/connectors/connections/ccn_woo_000000001/resume', { method: 'POST' });
    expect(((await resumed.json()) as { data: unknown }).data).toEqual({ status: 'active' });
    expect((await app()('/api/connectors/connections/ccn_missing0000000/pause', { method: 'POST' })).status).toBe(404);
    expect((await app()('/api/connectors/connections/ccn_missing0000000/resume', { method: 'POST' })).status).toBe(404);
  });
});
