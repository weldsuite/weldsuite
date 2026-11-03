/**
 * WeldConnect's store and accounting connectors on the webhook worker, end
 * to end through the worker's own `fetch`: a provider's webhook
 * (`POST /webhooks/connectors/:connectionId`), handed with its signature
 * headers to connect-api's `connector-event` route over `CONNECT_INTERNAL`
 * for the workspace the `connconn:<id>` KV entry names, and the Stripe
 * platform's Connect webhook (`POST /webhooks/stripe-connect`), verified and
 * handed to every connection of the event's account (`stripeacct:<account>`).
 * Run on both backends by the `integrations: connectors` conformance suite.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createWebhookTestApp } from './harness';

const SECRET = 'whsec_platform';

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

/** A JSON answer, as connect-api gives one. */
function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** connect-api's internal routes: answers by connection, never by call order. */
function connectStub() {
  return {
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('conn_down')) return json({ error: 'boom' }, 500);
      if (url.includes('conn_gone')) return json({ error: { code: 'NOT_FOUND', message: 'Connection not found' } }, 404);
      return json({ data: { message: 'Ingested 1 record' } }, 200);
    }),
  };
}

const KV = {
  'connconn:conn_shop': JSON.stringify({ workspaceId: 'org_shop', provider: 'shopify' }),
  'connconn:conn_gone': JSON.stringify({ workspaceId: 'org_shop', provider: 'woocommerce' }),
  'connconn:conn_bad': '{not json',
  'stripeacct:acct_1': JSON.stringify([
    { workspaceId: 'org_a', connectionId: 'conn_a' },
    { workspaceId: 'org_b', connectionId: 'conn_b' },
  ]),
  'stripeacct:acct_down': JSON.stringify([
    { workspaceId: 'org_a', connectionId: 'conn_a' },
    { workspaceId: 'org_c', connectionId: 'conn_down' },
  ]),
  'stripeacct:acct_bad': 'nope',
};

function app(env: Record<string, unknown> = {}) {
  return createWebhookTestApp({
    env: { WORKSPACE_CACHE: memoryKv(KV), STRIPE_CONNECT_WEBHOOK_SECRET: SECRET, ...env },
  });
}

function stripeSignature(body: string, secret = SECRET): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

function deliverStripe(target: ReturnType<typeof app>, payload: unknown, signature?: string) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return target.request('/webhooks/stripe-connect', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature ?? stripeSignature(body) },
  });
}

describe('POST /webhooks/connectors/:connectionId', () => {
  it('refuses connections it has no mapping for, or a mapping it cannot read', async () => {
    const connect = connectStub();
    const unknown = await app({ CONNECT_INTERNAL: connect }).request('/webhooks/connectors/conn_nope', {
      method: 'POST',
      body: '{}',
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Unknown connector' });

    const corrupt = await app({ CONNECT_INTERNAL: connect }).request('/webhooks/connectors/conn_bad', {
      method: 'POST',
      body: '{}',
    });
    expect(corrupt.status).toBe(500);
    expect(await corrupt.json()).toEqual({ error: 'Corrupt connector mapping' });
    expect(connect.fetch).not.toHaveBeenCalled();
  });

  it('needs the connect binding', async () => {
    const unbound = await app().request('/webhooks/connectors/conn_shop', { method: 'POST', body: '{}' });
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toEqual({ error: 'Connector ingest unavailable' });
  });

  it('hands the delivery and its signature to connect-api for the mapped workspace, and relays the answer', async () => {
    const connect = connectStub();
    const body = JSON.stringify({ id: 4242, title: 'Mug' });
    const res = await app({ CONNECT_INTERNAL: connect }).request('/webhooks/connectors/conn_shop', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': 'products/update',
        'X-Shopify-Hmac-Sha256': 'c2lnbmF0dXJl',
        'X-Unrelated': 'dropped',
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { message: 'Ingested 1 record' } });
    expect(connect.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = connect.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://internal/api/integrations/connections/conn_shop/connector-event');
    const headers = new Headers(init.headers);
    expect(headers.get('x-internal-workspace-id')).toBe('org_shop');
    expect(headers.get('x-shopify-topic')).toBe('products/update');
    expect(headers.get('x-shopify-hmac-sha256')).toBe('c2lnbmF0dXJl');
    expect(headers.get('x-unrelated')).toBeNull();
    expect(String(init.body)).toBe(body);

    // connect-api's refusal goes back to the provider as it came.
    const gone = await app({ CONNECT_INTERNAL: connect }).request('/webhooks/connectors/conn_gone', {
      method: 'POST',
      body: '{"id":1}',
      headers: { 'Content-Type': 'application/json', 'X-WC-Webhook-Topic': 'order.updated' },
    });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Connection not found' } });
  });
});

describe('POST /webhooks/stripe-connect', () => {
  it('needs the signing secret and a valid signature over JSON', async () => {
    const connect = connectStub();
    const unconfigured = await deliverStripe(
      app({ CONNECT_INTERNAL: connect, STRIPE_CONNECT_WEBHOOK_SECRET: undefined }),
      { account: 'acct_1' },
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: 'Stripe Connect webhook not configured' });

    const forged = await deliverStripe(app({ CONNECT_INTERNAL: connect }), { account: 'acct_1' }, stripeSignature('{}', 'wrong'));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: 'Invalid signature' });

    const stale = await deliverStripe(app({ CONNECT_INTERNAL: connect }), { account: 'acct_1' }, 't=1,v1=00');
    expect(stale.status).toBe(401);

    const garbled = await deliverStripe(app({ CONNECT_INTERNAL: connect }), '{oops');
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toEqual({ error: 'Invalid JSON' });
    expect(connect.fetch).not.toHaveBeenCalled();
  });

  it('ignores platform events and accounts nobody connected', async () => {
    const connect = connectStub();
    const platform = await deliverStripe(app({ CONNECT_INTERNAL: connect }), { id: 'evt_p', type: 'invoice.paid' });
    expect(platform.status).toBe(200);
    expect(await platform.json()).toEqual({ received: true, ignored: 'platform event' });

    for (const account of ['acct_unknown', 'acct_bad']) {
      const res = await deliverStripe(app({ CONNECT_INTERNAL: connect }), { id: 'evt_u', account });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: true, ignored: 'unknown account' });
    }
    expect(connect.fetch).not.toHaveBeenCalled();

    // A known account needs the connect binding.
    const unbound = await deliverStripe(app(), { id: 'evt_1', account: 'acct_1' });
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toEqual({ error: 'Connector ingest unavailable' });
  });

  it('hands the event, marked verified, to every connection of the account', async () => {
    const connect = connectStub();
    const event = { id: 'evt_1', type: 'invoice.paid', account: 'acct_1', data: { object: { id: 'in_1' } } };
    const res = await deliverStripe(app({ CONNECT_INTERNAL: connect }), event);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, delivered: 2 });
    expect(connect.fetch).toHaveBeenCalledTimes(2);
    const [url, init] = connect.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://internal/api/integrations/connections/conn_a/connector-event');
    const headers = new Headers(init.headers);
    expect(headers.get('x-internal-workspace-id')).toBe('org_a');
    expect(headers.get('x-weldsuite-stripe-connect')).toBe('verified');
    expect(JSON.parse(String(init.body))).toEqual(event);
  });

  it('answers 502 when a connection failed, so Stripe retries', async () => {
    const connect = connectStub();
    const res = await deliverStripe(app({ CONNECT_INTERNAL: connect }), { id: 'evt_2', account: 'acct_down' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Ingest failed', failed: 1 });
    expect(connect.fetch).toHaveBeenCalledTimes(2);
  });
});
