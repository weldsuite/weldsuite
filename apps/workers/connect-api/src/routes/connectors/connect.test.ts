/**
 * Making, changing and removing connector connections on a real (pglite)
 * tenant database: connect with credentials (WooCommerce, Shopify, Picqer,
 * a Stripe key) with their webhooks registered on the store, the authorise
 * flows (WooCommerce's app auth, Moneybird's and Stripe's OAuth with the
 * callback and Moneybird's administration picker), PATCH (names, syncs,
 * settings, credentials, the WeldBooks entity) and DELETE with the webhooks
 * removed; then the internal routes the webhook ingress calls: a store's
 * webhook delivery and WooCommerce's API keys. The providers are a fetch
 * stub answering by URL, method and token; the workspace cache is in memory.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { hmacSha256Base64, hmacSha256Hex, signWooCommerceAuthUserId } from '@weldsuite/connectors';
import { conformanceTenantDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const holder = vi.hoisted(() => ({ tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant as Database),
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => ({ id: 'ws_test_default', clerkOrgId: orgId }),
  };
});

import { connectorRoutes } from './index';
import { integrationsInternalRoutes } from '../integrations/internal';

const SECRET = 'internal-test-secret';
const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let hookSeq = 0;
/** The events of the last Moneybird webhook registered. */
let moneybirdWebhookEvents: string[] = [];

const HOOK_SALES_INVOICE = {
  id: 'si_hook',
  invoice_id: '2026-H01',
  contact_id: 'c_hook',
  state: 'open',
  invoice_date: '2026-04-01',
  due_date: '2026-04-15',
  currency: 'EUR',
  prices_are_incl_tax: false,
  total_price_excl_tax: '100.0',
  total_price_incl_tax: '121.0',
  total_paid: '50.0',
  total_unpaid: '71.0',
  details: [{ description: 'Support', amount: '1', price: '100.0', tax_rate_id: 'tr_21', total_price_excl_tax_with_discount: '100.0' }],
  tax_totals: [{ tax_rate_id: 'tr_21', taxable_amount: '100.0', tax_amount: '21.0' }],
  attachments: [],
  updated_at: '2026-04-03T10:00:00.000Z',
};

const HOOK_RECEIPT = {
  id: 'doc_r1',
  reference: 'R-77',
  contact_id: 'c_hook',
  state: 'open',
  date: '2026-04-02',
  currency: 'EUR',
  total_price_excl_tax: '10.0',
  total_price_incl_tax: '12.1',
  details: [{ description: 'Parking', amount: '1', price: '10.0' }],
  payments: [],
  attachments: [],
  updated_at: '2026-04-02T10:00:00.000Z',
};

/** The administration webhooks are delivered for (`ccn_hookmb0000001`). */
function hookedMoneybird(path: string, method: string, body: string | null): Response {
  if (path === 'sales_invoices/si_hook' && method === 'GET') return json(HOOK_SALES_INVOICE);
  if (path === 'documents/receipts/doc_r1' && method === 'GET') return json(HOOK_RECEIPT);
  if (path === 'financial_mutations/synchronization' && method === 'POST') {
    const { ids } = JSON.parse(body ?? '{}') as { ids?: string[] };
    const known = [{ id: 'fm_1', financial_account_id: 'fa_hook', amount: '50.0', date: '2026-04-03', message: 'Payment 2026-H01', contra_account_name: 'Hook BV', state: 'processed', updated_at: '2026-04-03T10:00:00.000Z' }];
    return json(known.filter((m) => ids?.includes(m.id)));
  }
  return json({ error: 'record not found' }, 404);
}

function provider(url: URL, method: string, token: string | null, body: string | null): Response {
  const host = url.hostname;
  const path = url.pathname;
  if (host === 'good-shop.example' || host === 'new-shop.example') {
    if (path === '/wp-json/wc/v3/webhooks' && method === 'POST') {
      const sent = JSON.parse(body ?? '{}') as { topic: string; delivery_url: string };
      hookSeq += 1;
      return json({ id: 900 + hookSeq, topic: sent.topic, delivery_url: sent.delivery_url });
    }
    if (path.startsWith('/wp-json/wc/v3/webhooks/') && method === 'DELETE') return json({ id: 1 });
    if (path.startsWith('/wp-json/wc/v3/')) return json([], 200, { 'X-WP-Total': '0', 'X-WP-TotalPages': '1' });
  }
  if (host === 'bad-shop.example') return json({ code: 'woocommerce_rest_cannot_view' }, 401);
  if (host === 'acme.myshopify.com') {
    if (path.endsWith('/webhooks.json') && method === 'POST') {
      const sent = JSON.parse(body ?? '{}') as { webhook: { topic: string; address: string } };
      hookSeq += 1;
      return json({ webhook: { id: 700 + hookSeq, topic: sent.webhook.topic, address: sent.webhook.address } });
    }
    return json({ products: [], orders: [], customers: [] });
  }
  if (host === 'acme.picqer.com') {
    if (path === '/api/v1/hooks' && method === 'POST') {
      hookSeq += 1;
      return json({ idhook: 500 + hookSeq });
    }
    return json([]);
  }
  if (host === 'connect.stripe.com') {
    if (path === '/oauth/token') return body?.includes('code=bad') ? json({ error: 'invalid_grant', error_description: 'Authorization code expired' }, 400) : json({ stripe_user_id: 'acct_oauth', livemode: false, scope: 'read_write' });
    if (path === '/oauth/deauthorize') return json({ stripe_user_id: 'acct_oauth' });
  }
  if (host === 'api.stripe.com') {
    const p = path.replace('/v1/', '');
    if (p === 'account' && token === 'Bearer rk_live_patch') return json({ id: 'acct_patched' });
    if (p === 'account') return token === 'Bearer rk_live_conn' ? json({ id: 'acct_key', settings: { dashboard: { display_name: 'Key Co' } } }) : json({ id: 'acct_oauth', business_profile: { name: 'Oauth Co' } });
    if (p === 'webhook_endpoints' && method === 'POST') return json({ id: 'we_1', url: 'https://hooks.example/webhooks/connectors/x', secret: 'whsec_from_stripe' });
    if (p.startsWith('webhook_endpoints/') && method === 'DELETE') return json({ id: 'we_1', deleted: true });
    if (p === 'balance') return json({ object: 'balance', available: [], pending: [] });
    return json({ object: 'list', data: [], has_more: false });
  }
  if (host === 'moneybird.com') {
    if (path === '/oauth/token') {
      const params = new URLSearchParams(body ?? '');
      if (params.get('code') === 'one-admin') return json({ access_token: 'mb-at-one', refresh_token: 'mb-rt-one', scope: 'sales_invoices' });
      return json({ access_token: 'mb-at-two', refresh_token: 'mb-rt-two' });
    }
    if (path === '/api/v2/administrations.json') {
      if (token === 'Bearer mb-at-one') return json([{ id: 111, name: 'Solo BV', language: 'nl', currency: 'EUR' }]);
      return json([{ id: 211, name: 'Alpha BV' }, { id: '212', name: 'Beta BV', currency: 'EUR' }]);
    }
    if (path.startsWith('/api/v2/311/')) return hookedMoneybird(path.replace('/api/v2/311/', '').replace(/\.json$/, ''), method, body);
    if (path.endsWith('/webhooks.json') && method === 'POST') {
      moneybirdWebhookEvents = (JSON.parse(body ?? '{}') as { enabled_events?: string[] }).enabled_events ?? [];
      return json({ id: 'mbwh_1', url: 'https://hooks.example/x', secret: 'mb-webhook-secret', enabled_events: ['contact_created'] });
    }
    if (path.endsWith('/financial_mutations/synchronization.json')) return json([]);
    return json([]);
  }
  return new Response('not found', { status: 404 });
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(href)) return realFetch(input, init);
      const body = typeof init?.body === 'string' ? init.body : null;
      return provider(new URL(href), (init?.method ?? 'GET').toUpperCase(), new Headers(init?.headers).get('authorization'), body);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;
const kv = createMemoryKv();
const at = new Date('2026-01-15T10:00:00.000Z');

const ENV = {
  WORKSPACE_CACHE: kv,
  INTERNAL_API_SECRET: SECRET,
  CONNECTOR_WEBHOOK_BASE_URL: 'https://hooks.example',
  PUBLIC_APP_URL: 'https://app-test.weldsuite.org',
  APP_API_PUBLIC_URL: 'https://app-api-test.weldsuite.org',
  MONEYBIRD_CLIENT_ID: 'mb-client',
  MONEYBIRD_CLIENT_SECRET: 'mb-secret',
  STRIPE_CONNECT_CLIENT_ID: 'ca_platform',
  STRIPE_SECRET_KEY: 'sk_platform',
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  holder.tenant = db;
  await db.insert(schema.entities).values({ id: 'ent_books0000001', name: 'Acme BV', legalName: 'Acme BV', entityType: 'company', jurisdictionCode: 'NL', baseCurrency: 'EUR' } as typeof schema.entities.$inferInsert);
  // WeldBooks is enabled for an entity by its extension row; connections only take such an entity.
  await db.insert(schema.accountingEntitySettings).values({ entityId: 'ent_books0000001' });
  await db.insert(schema.connectorConnections).values([
    { id: 'ccn_patchwoo00001', provider: 'woocommerce', displayName: 'Shop', status: 'active', credentials: { storeUrl: 'https://good-shop.example', consumerKey: 'ck_1', consumerSecret: 'cs_1' }, externalAccountId: 'https://good-shop.example', enabledSyncs: ['products'], webhookRegistrations: [{ id: '17', topic: 'product.updated', deliveryUrl: 'https://hooks.example/x' }], createdAt: at, updatedAt: at },
    { id: 'ccn_patchmb000001', provider: 'moneybird', displayName: 'Moneybird (Alpha BV)', status: 'active', credentials: { accessToken: 'mb-at-two', administrationId: '211' }, externalAccountId: '211', createdAt: at, updatedAt: at },
    { id: 'ccn_patchst000001', provider: 'stripe', displayName: 'Stripe (Oauth Co)', status: 'active', credentials: { stripeUserId: 'acct_oauth' }, externalAccountId: 'acct_oauth', createdAt: at, updatedAt: at },
    { id: 'ccn_patchsk000001', provider: 'stripe', displayName: 'Stripe (Key Co)', status: 'active', credentials: { apiKey: 'rk_live_old' }, externalAccountId: 'acct_key_old', webhookRegistrations: [{ id: 'we_9', topic: 'invoice.paid', deliveryUrl: 'https://hooks.example/y' }], createdAt: at, updatedAt: at },
    { id: 'ccn_hookwoo000001', provider: 'woocommerce', displayName: 'Hooked shop', status: 'active', credentials: { storeUrl: 'https://good-shop.example/hooked', consumerKey: 'ck_h', consumerSecret: 'cs_h' }, externalAccountId: 'https://good-shop.example/hooked', webhookSecret: 'hook-secret', enabledSyncs: ['products', 'orders'], createdAt: at, updatedAt: at },
    { id: 'ccn_hookmb0000001', provider: 'moneybird', displayName: 'Hooked books', status: 'active', credentials: { accessToken: 'mb-at-hook', administrationId: '311', entityId: 'ent_books0000001' }, externalAccountId: '311', webhookSecret: 'mb-hook-secret', enabledSyncs: ['contacts', 'invoices', 'bills', 'bankTransactions'], createdAt: at, updatedAt: at },
  ] as (typeof schema.connectorConnections.$inferInsert)[]);
  await kv.put('stripeacct:acct_oauth', JSON.stringify([{ workspaceId: 'ws_test_default', connectionId: 'ccn_patchst000001' }]));
}, 60_000);

function app(...granted: string[]) {
  return createTestApp<Env, Variables>('/api/connectors', connectorRoutes, {
    context: { tenantDb: db, permissions: permissions(...(granted.length ? granted : ['integrations:read', 'integrations:create', 'integrations:update', 'integrations:delete'])) },
    env: ENV as never,
  }).request;
}

const internalRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
internalRoutes.route('/', integrationsInternalRoutes);

function internalApp() {
  return createTestApp<Env, Variables>('/api/integrations', internalRoutes, {
    context: { tenantDb: db, permissions: permissions() },
    env: ENV as never,
  }).request;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const post = (body?: unknown) => send('POST', body);

async function row(id: string) {
  const [found] = await db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.id, id));
  return found!;
}

describe('POST /connect', () => {
  it('connects a WooCommerce store with its keys and registers its webhooks', async () => {
    const res = await app('integrations:create')('/api/connectors/connect', post({
      provider: 'woocommerce',
      credentials: { storeUrl: 'good-shop.example', consumerKey: 'ck_new', consumerSecret: 'cs_new' },
      enabledSyncs: ['products', 'orders', 'nonsense'],
    }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ provider: 'woocommerce', displayName: 'WooCommerce (good-shop.example)', status: 'active', externalAccountId: 'https://good-shop.example', enabledSyncs: ['products', 'orders'], webhookCount: 6, warning: null, isConnected: true });
    const stored = await row(data.id as string);
    expect(stored.webhookRegistrations?.map((r) => r.topic)).toEqual(['product.created', 'product.updated', 'product.deleted', 'order.created', 'order.updated', 'order.deleted']);
    expect(stored.webhookSecret).toBeTruthy();
    expect(await kv.get(`connconn:${data.id as string}`)).toBe(JSON.stringify({ workspaceId: 'ws_test_default', provider: 'woocommerce' }));
    const mappings = await db.select().from(schema.integrationFieldMappings).where(eq(schema.integrationFieldMappings.connectionId, data.id as string));
    expect(mappings.length).toBeGreaterThan(0);
  });

  it('connects Shopify (its app secret signs the webhooks), Picqer and a Stripe key with an entity', async () => {
    const shopify = await app()('/api/connectors/connect', post({ provider: 'shopify', displayName: '  Acme store ', credentials: { shopDomain: 'acme', accessToken: 'shpat_1', apiSecret: 'shpss_1' } }));
    expect(shopify.status).toBe(201);
    expect(((await shopify.json()) as { data: unknown }).data).toMatchObject({ displayName: 'Acme store', externalAccountId: 'https://acme.myshopify.com', webhookCount: 9 });
    const picqer = await app()('/api/connectors/connect', post({ provider: 'picqer', credentials: { subdomain: 'acme', apiKey: 'pq_1' }, enabledSyncs: ['products'] }));
    expect(((await picqer.json()) as { data: unknown }).data).toMatchObject({ displayName: 'Picqer (acme.picqer.com)', webhookCount: 2 });
    const stripe = await app()('/api/connectors/connect', post({ provider: 'stripe', credentials: { apiKey: 'rk_live_conn', platformSecretKey: 'sk_injected' }, entityId: 'ent_books0000001', settings: { importStartDate: '2026-01-01' } }));
    expect(stripe.status).toBe(201);
    const { data } = (await stripe.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({ displayName: 'Stripe (Key Co)', externalAccountId: 'acct_key', settings: { importStartDate: '2026-01-01' }, webhookCount: 1 });
    const stored = await row(data.id as string);
    expect(stored.credentials).toEqual({ apiKey: 'rk_live_conn', entityId: 'ent_books0000001' });
    expect(stored.webhookSecret).toBe('whsec_from_stripe');
  });

  it('refuses what cannot be connected this way', async () => {
    const cases: Array<[unknown, number, string?]> = [
      [{ provider: 'magento', credentials: { a: 'b' } }, 400, "Unknown connector 'magento'"],
      [{ provider: 'moneybird', credentials: { accessToken: 'x' } }, 400, 'Connect from the Connect button — Moneybird authorises via OAuth'],
      [{ provider: 'woocommerce', credentials: { storeUrl: 'good-shop.example' } }, 400, 'Connect this store from the Connect button — WooCommerce creates the API keys after you approve access'],
      [{ provider: 'stripe', credentials: { stripeUserId: 'acct_1' } }, 400, 'Paste a Stripe API key, or use Connect with Stripe'],
      [{ provider: 'picqer', credentials: { subdomain: 'acme' } }, 400, 'API key is required'],
      [{ provider: 'woocommerce', credentials: { storeUrl: 'bad-shop.example', consumerKey: 'ck', consumerSecret: 'cs' } }, 400, 'WooCommerce rejected the consumer key or secret'],
      [{ provider: 'picqer', credentials: { subdomain: 'acme', apiKey: 'x' }, entityId: 'ent_missing' }, 400, 'Accounting entity not found'],
      [{ provider: 'picqer', credentials: { subdomain: 'acme', apiKey: 'x' }, settings: { importStartDate: '2026-01-01' } }, 400, 'importStartDate only applies to Stripe connections'],
      [{ provider: 'shopify', credentials: {} , settings: { importStartDate: 'soon', other: 1 } }, 400],
      [{ credentials: { a: '' } }, 400],
    ];
    for (const [body, status, message] of cases) {
      const res = await app()('/api/connectors/connect', post(body));
      expect(res.status).toBe(status);
      if (message) expect(await res.json()).toMatchObject({ error: { message } });
    }
    expect((await app('integrations:read')('/api/connectors/connect', post({ provider: 'picqer', credentials: { subdomain: 'acme', apiKey: 'k' } }))).status).toBe(403);
  });
});

describe('POST /authorize and the OAuth callback', () => {
  it('starts WooCommerce\'s app authorisation on a pending connection', async () => {
    const res = await app()('/api/connectors/authorize', post({ provider: 'woocommerce', storeUrl: 'https://new-shop.example/', enabledSyncs: ['orders'], returnUrl: 'https://app-test.weldsuite.org/weldconnect/connectors' }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { authorizeUrl: string; connectionId: string } };
    const url = new URL(data.authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe('https://new-shop.example/wc-auth/v1/authorize');
    expect(url.searchParams.get('return_url')).toBe('https://app-test.weldsuite.org/weldconnect/connectors');
    expect(url.searchParams.get('scope')).toBe('read_write');
    expect(url.searchParams.get('user_id')?.startsWith('wooa.')).toBe(true);
    expect(await row(data.connectionId)).toMatchObject({ status: 'pending', displayName: 'WooCommerce (new-shop.example)', enabledSyncs: ['orders'] });

    // The shop posts its keys to the callback, through the webhook ingress.
    const keys = await internalApp()('/api/integrations/woocommerce-auth', {
      method: 'POST',
      headers: { 'X-Internal-Secret': SECRET, 'X-Workspace-Id': 'org_test_default', 'Content-Type': 'application/json' },
      body: JSON.stringify({ key_id: 5, user_id: url.searchParams.get('user_id'), consumer_key: 'ck_granted', consumer_secret: 'cs_granted', key_permissions: 'read_write' }),
    });
    expect(keys.status).toBe(200);
    expect(await keys.json()).toEqual({ data: { message: 'connected' } });
    expect(await row(data.connectionId)).toMatchObject({ status: 'active', credentials: { storeUrl: 'https://new-shop.example', consumerKey: 'ck_granted', consumerSecret: 'cs_granted' } });
  });

  it('refuses a WooCommerce callback without a valid state', async () => {
    const forged = await signWooCommerceAuthUserId({ clerkOrgId: 'org_test_default', connectionId: 'ccn_patchwoo00001', connectedBy: 'user_x' }, 'another-secret');
    for (const body of [{ user_id: forged, consumer_key: 'ck', consumer_secret: 'cs' }, { user_id: 'x' }, 'not json']) {
      const res = await internalApp()('/api/integrations/woocommerce-auth', {
        method: 'POST',
        headers: { 'X-Internal-Secret': SECRET, 'X-Workspace-Id': 'org_test_default' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('connects Moneybird with one administration straight away', async () => {
    const start = await app()('/api/connectors/authorize', post({ provider: 'moneybird', enabledSyncs: ['contacts'], returnUrl: 'https://app-test.weldsuite.org/w/acme/weldconnect/connectors', entityId: 'ent_books0000001' }));
    const { data } = (await start.json()) as { data: { authorizeUrl: string } };
    const url = new URL(data.authorizeUrl);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app-test.weldsuite.org/weldconnect/connectors/callback');
    expect(url.searchParams.get('scope')).toBe('sales_invoices documents settings bank');
    const callback = await app()('/api/connectors/oauth/callback', post({ provider: 'moneybird', code: 'one-admin', state: url.searchParams.get('state') }));
    expect(callback.status).toBe(200);
    const result = ((await callback.json()) as { data: { connection: Record<string, unknown>; administrations: unknown[]; needsPicker: boolean; returnUrl: string } }).data;
    expect(result).toMatchObject({ needsPicker: false, returnUrl: 'https://app-test.weldsuite.org/w/acme/weldconnect/connectors', administrations: [{ id: '111', name: 'Solo BV', language: 'nl', currency: 'EUR' }] });
    expect(result.connection).toMatchObject({ provider: 'moneybird', displayName: 'Moneybird (Solo BV)', externalAccountId: '111', entityId: 'ent_books0000001', status: 'active' });
    const stored = await row(result.connection.id as string);
    expect(stored.credentials).toEqual({ accessToken: 'mb-at-one', refreshToken: 'mb-rt-one', administrationId: '111', entityId: 'ent_books0000001' });
    expect(stored.webhookSecret).toBe('mb-webhook-secret');
    // Moneybird's own event names for contacts.
    expect(moneybirdWebhookEvents).toEqual([
      'contact_created',
      'contact_created_from_checkout_order',
      'contact_changed',
      'contact_activated',
      'contact_archived',
      'contact_merged',
      'contact_tax_number_validated',
      'contact_destroyed',
    ]);
    // A state is used once.
    const again = await app()('/api/connectors/oauth/callback', post({ provider: 'moneybird', code: 'one-admin', state: url.searchParams.get('state') }));
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { message: 'Unknown or expired Moneybird authorisation' } });
  });

  it('lets the merchant pick one of several Moneybird administrations', async () => {
    const start = await app()('/api/connectors/authorize', post({ provider: 'moneybird', displayName: 'Books', returnUrl: 'https://app-test.weldsuite.org/weldconnect/connectors' }));
    const state = new URL(((await start.json()) as { data: { authorizeUrl: string } }).data.authorizeUrl).searchParams.get('state');
    const callback = await app()('/api/connectors/oauth/callback', post({ provider: 'moneybird', code: 'two-admins', state }));
    const result = ((await callback.json()) as { data: { connection: Record<string, unknown>; needsPicker: boolean } }).data;
    expect(result.needsPicker).toBe(true);
    expect(result.connection).toMatchObject({ status: 'pending', displayName: 'Books', isConnected: false });
    const id = result.connection.id as string;
    expect((await row(id)).externalAccountId).toBe(`pending:${id}`);

    const unknown = await app()(`/api/connectors/connections/${id}/select-account`, post({ administrationId: '999' }));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toMatchObject({ error: { message: 'That administration is not available on this Moneybird account' } });
    const picked = await app()(`/api/connectors/connections/${id}/select-account`, post({ administrationId: '212' }));
    expect(picked.status).toBe(200);
    expect(((await picked.json()) as { data: { connection: unknown } }).data.connection).toMatchObject({ status: 'active', externalAccountId: '212', displayName: 'Moneybird (Beta BV)' });
    expect((await app()('/api/connectors/connections/ccn_patchwoo00001/select-account', post({ administrationId: '212' }))).status).toBe(404);
    expect((await app()(`/api/connectors/connections/${id}/select-account`, post({}))).status).toBe(400);
  });

  it('connects a Stripe account through Connect OAuth', async () => {
    const start = await app()('/api/connectors/authorize', post({ provider: 'stripe', returnUrl: 'https://app-test.weldsuite.org/weldconnect/connectors', importStartDate: '2026-02-01', enabledSyncs: ['invoices'] }));
    const { data } = (await start.json()) as { data: { authorizeUrl: string } };
    const url = new URL(data.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe('ca_platform');
    expect(url.searchParams.get('state')?.startsWith('stripe_')).toBe(true);
    const callback = await app()('/api/connectors/oauth/callback', post({ provider: 'stripe', code: 'ac_good', state: url.searchParams.get('state') }));
    expect(callback.status).toBe(200);
    const result = ((await callback.json()) as { data: { connection: Record<string, unknown> } }).data;
    expect(result).toMatchObject({ administrations: [], needsPicker: false });
    expect(result.connection).toMatchObject({ displayName: 'Stripe (Oauth Co)', externalAccountId: 'acct_oauth', settings: { importStartDate: '2026-02-01' } });
    expect(JSON.parse((await kv.get('stripeacct:acct_oauth'))!)).toContainEqual({ workspaceId: 'ws_test_default', connectionId: result.connection.id });
  });

  it('refuses a bad return URL, a stale state and a refused code', async () => {
    const bad = await app()('/api/connectors/authorize', post({ provider: 'stripe', returnUrl: 'https://evil.example/weldconnect/connectors' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { message: 'Return URL is not a WeldSuite page' } });
    expect((await app()('/api/connectors/authorize', post({ provider: 'xero', returnUrl: 'https://app-test.weldsuite.org/weldconnect/connectors' }))).status).toBe(400);
    expect((await app()('/api/connectors/authorize', post({ provider: 'woocommerce', returnUrl: 'not a url' }))).status).toBe(400);
    expect((await app()('/api/connectors/authorize', post({ provider: 'moneybird', returnUrl: 'https://app-test.weldsuite.org/weldconnect/connectors', entityId: 'ent_missing' }))).status).toBe(400);
    const stale = await app()('/api/connectors/oauth/callback', post({ provider: 'stripe', code: 'x', state: 'stripe_unknown' }));
    expect(await stale.json()).toMatchObject({ error: { message: 'Unknown or expired Stripe authorisation' } });
    const start = await app()('/api/connectors/authorize', post({ provider: 'stripe', returnUrl: 'https://app-test.weldsuite.org/weldconnect/connectors' }));
    const state = new URL(((await start.json()) as { data: { authorizeUrl: string } }).data.authorizeUrl).searchParams.get('state');
    const refused = await app()('/api/connectors/oauth/callback', post({ provider: 'stripe', code: 'bad', state }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { message: 'Authorization code expired' } });
    expect((await app()('/api/connectors/oauth/callback', post({ provider: 'xero', code: 'x', state: 'y' }))).status).toBe(400);
  });
});

describe('PATCH and DELETE /connections/:id', () => {
  it('renames, picks syncs and directions, and sets the WeldBooks entity', async () => {
    const res = await app('integrations:update')('/api/connectors/connections/ccn_patchwoo00001', send('PATCH', { displayName: 'Main shop', enabledSyncs: ['orders', 'woocommerce-products'], direction: 'bidirectional', objectSyncDirections: { orders: 'inbound' }, entityId: 'ent_books0000001' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({ displayName: 'Main shop', enabledSyncs: ['orders', 'woocommerce-products'], direction: 'bidirectional', objectSyncDirections: { orders: 'inbound' }, entityId: 'ent_books0000001' });
    const cleared = await app()('/api/connectors/connections/ccn_patchwoo00001', send('PATCH', { entityId: null, objectSyncDirections: null }));
    expect(((await cleared.json()) as { data: unknown }).data).toMatchObject({ entityId: null, objectSyncDirections: {} });
  });

  it('re-tests changed credentials, and keeps Stripe\'s account fixed', async () => {
    const swapped = await app()('/api/connectors/connections/ccn_patchsk000001', send('PATCH', { credentials: { apiKey: 'rk_live_patch' } }));
    expect(swapped.status).toBe(200);
    expect(((await swapped.json()) as { data: unknown }).data).toMatchObject({ externalAccountId: 'acct_patched' });
    const other = await app()('/api/connectors/connections/ccn_patchsk000001', send('PATCH', { credentials: { stripeUserId: 'acct_x' } }));
    expect(await other.json()).toMatchObject({ error: { message: 'Only the Stripe API key can be changed' } });
    const oauth = await app()('/api/connectors/connections/ccn_patchst000001', send('PATCH', { credentials: { apiKey: 'rk_x' } }));
    expect(await oauth.json()).toMatchObject({ error: { message: 'Connect Stripe again to change the account of this connection' } });
    const rejected = await app()('/api/connectors/connections/ccn_patchwoo00001', send('PATCH', { credentials: { storeUrl: 'https://bad-shop.example' } }));
    expect(rejected.status).toBe(400);
  });

  it('stores the Stripe start date and the Moneybird push settings', async () => {
    const stripe = await app()('/api/connectors/connections/ccn_patchst000001', send('PATCH', { settings: { importStartDate: '2026-03-01' } }));
    expect(((await stripe.json()) as { data: unknown }).data).toMatchObject({ settings: { importStartDate: '2026-03-01' } });
    const push = { enabled: false, revenueLedgerAccountId: '501', taxRateOverrides: { exempt: 'tr_0' }, startDate: '2026-01-01' };
    const mb = await app()('/api/connectors/connections/ccn_patchmb000001', send('PATCH', { settings: { moneybirdPush: push } }));
    expect(mb.status).toBe(200);
    expect(((await mb.json()) as { data: { settings: unknown } }).data.settings).toEqual({
      moneybirdPush: { enabled: false, sourceConnectionIds: [], revenueLedgerAccountId: '501', financialAccountId: null, feeLedgerAccountId: null, payoutLedgerAccountId: null, taxRateOverrides: { reverseCharge: null, outsideEu: null, exempt: 'tr_0', noTax: null }, startDate: '2026-01-01' },
    });
    const wrong = await app()('/api/connectors/connections/ccn_patchmb000001', send('PATCH', { settings: { importStartDate: '2026-01-01' } }));
    expect(await wrong.json()).toMatchObject({ error: { message: 'importStartDate only applies to Stripe connections' } });
    const refused = await app()('/api/connectors/connections/ccn_patchmb000001', send('PATCH', { settings: { moneybirdPush: { enabled: true, financialAccountId: 'fa_1' } } }));
    expect(refused.status).toBe(400);
    const typo = await app()('/api/connectors/connections/ccn_patchmb000001', send('PATCH', { settings: { moneybirdPush: { enabled: 'yes' }, extra: true } }));
    expect(typo.status).toBe(400);
  });

  it('refuses an unknown connection, an unknown entity and a missing permission', async () => {
    expect((await app()('/api/connectors/connections/ccn_missing000001', send('PATCH', { displayName: 'x' }))).status).toBe(404);
    expect((await app()('/api/connectors/connections/ccn_patchwoo00001', send('PATCH', { entityId: 'ent_missing' }))).status).toBe(400);
    expect((await app()('/api/connectors/connections/ccn_patchwoo00001', send('PATCH', { direction: 'sideways' }))).status).toBe(400);
    expect((await app('integrations:read')('/api/connectors/connections/ccn_patchwoo00001', send('PATCH', { displayName: 'x' }))).status).toBe(403);
    expect((await app('integrations:update')('/api/connectors/connections/ccn_patchwoo00001', send('DELETE'))).status).toBe(403);
  });

  it('disconnects, removing the store\'s webhooks and the Stripe authorisation', async () => {
    await kv.put('connconn:ccn_patchwoo00001', JSON.stringify({ workspaceId: 'ws_test_default', provider: 'woocommerce' }));
    const woo = await app()('/api/connectors/connections/ccn_patchwoo00001', send('DELETE'));
    expect(woo.status).toBe(200);
    expect(await woo.json()).toEqual({ data: { id: 'ccn_patchwoo00001', disconnected: true } });
    expect(await kv.get('connconn:ccn_patchwoo00001')).toBeNull();
    const [gone] = await db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.id, 'ccn_patchwoo00001'));
    expect(gone).toMatchObject({ status: 'paused', credentials: null, webhookRegistrations: null });
    expect(gone!.deletedAt).not.toBeNull();
    const stripe = await app()('/api/connectors/connections/ccn_patchst000001', send('DELETE'));
    expect(stripe.status).toBe(200);
    const left = await kv.get('stripeacct:acct_oauth');
    expect(left === null || !JSON.parse(left).some((e: { connectionId: string }) => e.connectionId === 'ccn_patchst000001')).toBe(true);
    const key = await app()('/api/connectors/connections/ccn_patchsk000001', send('DELETE'));
    expect(key.status).toBe(200);
    expect((await app()('/api/connectors/connections/ccn_patchwoo00001', send('DELETE'))).status).toBe(404);
  });
});

describe('POST /api/integrations/connections/:id/connector-event', () => {
  const deliver = async (body: string, headers: Record<string, string>) =>
    internalApp()('/api/integrations/connections/ccn_hookwoo000001/connector-event', {
      method: 'POST',
      headers: { 'X-Internal-Secret': SECRET, 'X-Workspace-Id': 'org_test_default', 'Content-Type': 'application/json', ...headers },
      body,
    });

  it('ingests a signed product delivery and a delete', async () => {
    const body = JSON.stringify({ id: 4242, name: 'Hooked hat', sku: 'HAT-1', price: '15.00', status: 'publish', date_modified_gmt: '2026-04-01T10:00:00' });
    const res = await deliver(body, { 'X-WC-Webhook-Topic': 'product.updated', 'X-WC-Webhook-Signature': await hmacSha256Base64('hook-secret', body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { message: 'ingested' } });
    const [hat] = await db.select().from(schema.products).where(eq(schema.products.sku, 'HAT-1'));
    expect(hat).toMatchObject({ name: 'Hooked hat', price: '15.00', status: 'active' });
    const runs = await db.select().from(schema.connectorSyncRuns).where(eq(schema.connectorSyncRuns.connectionId, 'ccn_hookwoo000001'));
    expect(runs.map((r) => [r.syncName, r.trigger, r.syncType, r.status, r.recordsCreated])).toEqual([['woocommerce-products', 'webhook', 'WEBHOOK', 'success', 1]]);

    const removal = JSON.stringify({ id: 4242 });
    const deleted = await deliver(removal, { 'X-WC-Webhook-Topic': 'product.deleted', 'X-WC-Webhook-Signature': await hmacSha256Base64('hook-secret', removal) });
    expect(await deleted.json()).toEqual({ data: { message: 'ingested' } });
    const [after] = await db.select().from(schema.products).where(eq(schema.products.sku, 'HAT-1'));
    expect(after!.deletedAt).not.toBeNull();
  });

  it('answers what it does not ingest, and refuses a bad signature', async () => {
    const body = JSON.stringify({ id: 1 });
    const signature = await hmacSha256Base64('hook-secret', body);
    expect(await (await deliver(body, { 'X-WC-Webhook-Topic': 'coupon.created', 'X-WC-Webhook-Signature': signature })).json()).toEqual({ data: { message: 'ignored topic coupon.created' } });
    expect(await (await deliver(body, { 'X-WC-Webhook-Topic': 'customer.created', 'X-WC-Webhook-Signature': signature })).json()).toEqual({ data: { message: 'sync disabled' } });
    const missing = await deliver(body, { 'X-WC-Webhook-Signature': signature });
    expect(missing.status).toBe(400);
    const forged = await deliver(body, { 'X-WC-Webhook-Topic': 'product.updated', 'X-WC-Webhook-Signature': 'bm9wZQ==' });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ data: { message: 'invalid webhook signature' } });
    const broken = await deliver('{not json', { 'X-WC-Webhook-Topic': 'product.updated', 'X-WC-Webhook-Signature': await hmacSha256Base64('hook-secret', '{not json') });
    expect(broken.status).toBe(400);
    expect((await internalApp()('/api/integrations/connections/ccn_missing000001/connector-event', { method: 'POST', headers: { 'X-Internal-Secret': SECRET, 'X-Workspace-Id': 'org_test_default' }, body })).status).toBe(404);
  });
});

describe('POST /api/integrations/connections/:id/connector-event · Moneybird', () => {
  const deliver = async (action: string, extra: Record<string, unknown>) => {
    const body = JSON.stringify({ administration_id: '311', webhook_id: 'mbwh_hook', action, ...extra });
    const t = Math.floor(Date.now() / 1000);
    const signature = `t=${t},v1=${await hmacSha256Hex('mb-hook-secret', `${t}.${body}`)}`;
    const res = await internalApp()('/api/integrations/connections/ccn_hookmb0000001/connector-event', {
      method: 'POST',
      headers: { 'X-Internal-Secret': SECRET, 'X-Workspace-Id': 'org_test_default', 'Content-Type': 'application/json', 'Moneybird-Signature': signature },
      body,
    });
    return { status: res.status, body: (await res.json()) as { data: { message: string } } };
  };
  const runs = async () =>
    (await db.select().from(schema.connectorSyncRuns).where(eq(schema.connectorSyncRuns.connectionId, 'ccn_hookmb0000001')))
      .map((r) => [r.syncName, r.status, r.recordsCreated])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  it('imports contacts, payments, documents and statement lines from their own events', async () => {
    // contact_changed: the entity is the contact.
    const contact = await deliver('contact_changed', {
      entity_type: 'Contact',
      entity_id: 'c_hook',
      entity: { id: 'c_hook', company_name: 'Hook BV', email: 'hook@example.test', updated_at: '2026-04-01T09:00:00.000Z' },
    });
    expect(contact).toEqual({ status: 200, body: { data: { message: 'ingested' } } });

    // A payment: the sales invoice it paid and the bank line it was linked to are read back.
    const payment = await deliver('payment_registered', {
      entity_type: 'Payment',
      entity_id: 'pay_1',
      entity: { id: 'pay_1', invoice_type: 'SalesInvoice', invoice_id: 'si_hook', financial_mutation_id: 'fm_1', price: '50.0' },
    });
    expect(payment.body).toEqual({ data: { message: 'ingested' } });
    const [invoice] = await db.select().from(schema.invoices).where(eq(schema.invoices.invoiceNumber, '2026-H01'));
    expect(invoice).toMatchObject({ status: 'partial', taxTotal: '21.00', total: '121.00', amountPaid: '50.00', balanceDue: '71.00' });
    const [paid] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.externalId, 'fm_1'));
    expect(paid).toMatchObject({ amount: '50.00', status: 'reconciled', description: 'Payment 2026-H01' });

    // A document the payload doesn't type: read back as a purchase invoice (404), then as a receipt.
    const saved = await deliver('document_saved', { entity_type: 'Document', entity_id: 'doc_r1', entity: { id: 'doc_r1' } });
    expect(saved.body).toEqual({ data: { message: 'ingested' } });
    const [bill] = await db.select().from(schema.bills).where(eq(schema.bills.billNumber, 'R-77'));
    expect(bill).toMatchObject({ status: 'approved', total: '12.10', taxTotal: '2.10' });
    const [billMapping] = await db
      .select()
      .from(schema.integrationEntityMappings)
      .where(eq(schema.integrationEntityMappings.internalEntityId, bill!.id));
    expect(billMapping).toMatchObject({ externalEntityType: 'moneybird_receipt', externalEntityId: 'doc_r1' });

    // A statement: its lines are the bank lines, on the statement's account.
    const statement = await deliver('financial_statement_created', {
      entity_type: 'FinancialStatement',
      entity_id: 'fs_1',
      entity: {
        id: 'fs_1',
        financial_account_id: 'fa_hook',
        reference: 'Import 4',
        financial_mutations: [{ id: 'fm_2', amount: '-12.5', date: '2026-04-04', message: 'Bank fee', state: 'unprocessed', updated_at: '2026-04-04T08:00:00.000Z' }],
      },
    });
    expect(statement.body).toEqual({ data: { message: 'ingested' } });
    const [fee] = await db.select().from(schema.bankTransactions).where(eq(schema.bankTransactions.externalId, 'fm_2'));
    expect(fee).toMatchObject({ amount: '-12.50', status: 'unreconciled', bankAccountId: paid!.bankAccountId });

    // What WeldBooks sent to Moneybird itself is left alone.
    const external = await deliver('payment_registered', {
      entity_type: 'Payment',
      entity: { id: 'pay_2', invoice_type: 'ExternalSalesInvoice', invoice_id: 'mb_ext_1', financial_mutation_id: 'fm_1' },
    });
    expect(external.body).toEqual({ data: { message: 'nothing to import for payment_registered' } });

    // Deleted: removed under the kind WeldBooks has it as.
    const destroyed = await deliver('document_destroyed', { entity_type: 'Document', entity_id: 'doc_r1', entity: { id: 'doc_r1' } });
    expect(destroyed.body).toEqual({ data: { message: 'ingested' } });
    const [gone] = await db.select().from(schema.bills).where(eq(schema.bills.id, bill!.id));
    expect(gone!.deletedAt).not.toBeNull();

    // One run per sync a delivery fed; the delete ran for both kinds of document.
    expect(await runs()).toEqual([
      ['moneybird-contacts', 'success', 1],
      ['moneybird-financial-mutations', 'success', 1],
      ['moneybird-financial-mutations', 'success', 1],
      ['moneybird-purchase-invoices', 'success', 0],
      ['moneybird-receipts', 'success', 0],
      ['moneybird-receipts', 'success', 1],
      ['moneybird-sales-invoices', 'success', 1],
    ]);
  });
});
