/**
 * WooCommerce's app-auth callback (`POST /webhooks/woocommerce/auth`, public)
 * on a real (pglite) tenant database: the shop posts the API keys it made
 * for the `user_id` state `POST /api/connectors/authorize` signed, and the
 * pending connection is finished (keys stored, webhooks registered on the
 * store by a fetch stub, the first sync started); a forged, expired or
 * malformed callback is refused with a 400.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { signWooCommerceAuthUserId } from '@weldsuite/connectors';
import { conformanceTenantDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../types';

const holder = vi.hoisted(() => ({ tenant: null as unknown }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/worker-kit/db')>();
  return {
    ...actual,
    getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant as Database),
    getWorkspaceForOrg: async (_env: unknown, orgId: string) => ({ id: 'ws_test_default', clerkOrgId: orgId }),
  };
});

import { woocommerceAuthWebhookRoutes } from './webhooks-woocommerce-auth';

const SECRET = 'internal-test-secret';
const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let hookSeq = 0;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isLoopback(href)) return realFetch(input, init);
      const url = new URL(href);
      if (url.hostname !== 'granted-shop.example') return new Response('not found', { status: 404 });
      if (url.pathname === '/wp-json/wc/v3/webhooks' && init?.method === 'POST') {
        const sent = JSON.parse(String(init.body)) as { topic: string; delivery_url: string };
        hookSeq += 1;
        return json({ id: 800 + hookSeq, topic: sent.topic, delivery_url: sent.delivery_url });
      }
      return json([], 200, { 'X-WP-Total': '0', 'X-WP-TotalPages': '1' });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;
const kv = createMemoryKv();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  holder.tenant = db;
  await db.insert(schema.connectorConnections).values({
    id: 'ccn_wooauth000001',
    provider: 'woocommerce',
    displayName: 'WooCommerce (granted-shop.example)',
    status: 'pending',
    externalAccountId: 'https://granted-shop.example',
    enabledSyncs: ['products'],
    connectedBy: 'user_test_default',
  } as typeof schema.connectorConnections.$inferInsert);
  await db.insert(schema.connectorConnections).values({
    id: 'ccn_woonourl00001',
    provider: 'woocommerce',
    status: 'pending',
  } as typeof schema.connectorConnections.$inferInsert);
}, 60_000);

function app() {
  return createTestApp<Env, Variables>('/webhooks/woocommerce', woocommerceAuthWebhookRoutes, {
    context: { tenantDb: db, permissions: permissions() },
    env: { INTERNAL_API_SECRET: SECRET, CONNECTOR_WEBHOOK_BASE_URL: 'https://hooks.example', WORKSPACE_CACHE: kv } as never,
  }).request;
}

const callback = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const userId = (connectionId: string, secret = SECRET, now?: number) =>
  signWooCommerceAuthUserId({ clerkOrgId: 'org_test_default', connectionId, connectedBy: 'user_test_default' }, secret, now);

describe('POST /webhooks/woocommerce/auth', () => {
  it('stores the keys, registers the store\'s webhooks and activates the connection', async () => {
    const res = await app()('/webhooks/woocommerce/auth', callback({
      key_id: 12,
      user_id: await userId('ccn_wooauth000001'),
      consumer_key: ' ck_granted ',
      consumer_secret: 'cs_granted',
      key_permissions: 'read_write',
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { message: 'connected' } });
    const [row] = await db.select().from(schema.connectorConnections).where(eq(schema.connectorConnections.id, 'ccn_wooauth000001'));
    expect(row).toMatchObject({
      status: 'active',
      credentials: { storeUrl: 'https://granted-shop.example', consumerKey: 'ck_granted', consumerSecret: 'cs_granted' },
      enabledSyncs: ['products'],
    });
    expect(row!.webhookSecret).toBeTruthy();
  });

  it('refuses a forged, an expired or a malformed callback, and one for a connection without a store', async () => {
    const forged = await app()('/webhooks/woocommerce/auth', callback({ user_id: await userId('ccn_wooauth000001', 'wrong'), consumer_key: 'ck', consumer_secret: 'cs' }));
    expect(forged.status).toBe(400);
    expect(await forged.json()).toEqual({ data: { message: 'unknown or expired WooCommerce auth' } });
    const expired = await app()('/webhooks/woocommerce/auth', callback({ user_id: await userId('ccn_wooauth000001', SECRET, 1_000_000), consumer_key: 'ck', consumer_secret: 'cs' }));
    expect(expired.status).toBe(400);
    const malformed = await app()('/webhooks/woocommerce/auth', callback('{"user_id": 1'));
    expect(await malformed.json()).toEqual({ data: { message: 'invalid WooCommerce auth payload' } });
    const noKeys = await app()('/webhooks/woocommerce/auth', callback({ user_id: await userId('ccn_wooauth000001') }));
    expect(noKeys.status).toBe(400);
    const missing = await app()('/webhooks/woocommerce/auth', callback({ user_id: await userId('ccn_gone000000001'), consumer_key: 'ck', consumer_secret: 'cs' }));
    expect(await missing.json()).toEqual({ data: { message: 'connection not found' } });
    const noStore = await app()('/webhooks/woocommerce/auth', callback({ user_id: await userId('ccn_woonourl00001'), consumer_key: 'ck', consumer_secret: 'cs' }));
    expect(await noStore.json()).toEqual({ data: { message: 'connection is missing a store URL' } });
  });
});
