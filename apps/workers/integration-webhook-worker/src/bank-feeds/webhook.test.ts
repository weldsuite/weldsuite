import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStripeSignatureHeader, sha256Hex, type FeedEvent } from '@weldsuite/bank-feeds';
import type { Env } from '../index';

const masterRows = vi.hoisted(() => ({ rows: [] as Array<{ connectionId: string; clerkOrgId: string }> }));

vi.mock('../db', async () => {
  const actual = await vi.importActual<typeof import('../db')>('../db');
  const chain = { from: () => chain, where: () => chain, limit: async () => masterRows.rows };
  return { ...actual, getMasterDb: () => ({ select: () => chain }) };
});

import { bankFeedWebhookRoutes, defaultDeps, dispatchBankFeedEvents, type BankFeedWebhookDeps } from './webhook';

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Harness {
  deps: BankFeedWebhookDeps & { forwarded: Array<{ hit: unknown; body: { events: FeedEvent[]; provider: string; connectionId: string; providerConnectionId: string } }> };
  post(path: string, body: string, headers?: Record<string, string>, env?: Partial<Env>): Promise<{ status: number; json: any }>;
}

function harness(index: Record<string, { connectionId: string; clerkOrgId: string }>): Harness {
  const forwarded: Harness['deps']['forwarded'] = [];
  const deps: Harness['deps'] = {
    forwarded,
    lookup: async (provider, id) => index[`${provider}:${id}`] ?? null,
    forward: async (hit, body) => void forwarded.push({ hit, body }),
  };
  const app = bankFeedWebhookRoutes(() => deps);
  return {
    deps,
    async post(path, body, headers = {}, env = {}) {
      const waiting: Promise<unknown>[] = [];
      const executionCtx = { waitUntil: (p: Promise<unknown>) => void waiting.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
      const res = await app.request(
        `/bank-feeds/${path}`,
        { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } },
        { WORKSPACE_CACHE: memoryKv(), ...env } as unknown as Record<string, unknown>,
        executionCtx,
      );
      await Promise.all(waiting);
      return { status: res.status, json: await res.json() };
    },
  };
}

function memoryKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
  } as unknown as KVNamespace;
}

describe('Stripe Financial Connections deliveries', () => {
  const secret = 'whsec_fc_test';
  const body = JSON.stringify({
    id: 'evt_1',
    type: 'financial_connections.account.refreshed_transactions',
    data: { object: { id: 'fca_1', transaction_refresh: { status: 'succeeded' } } },
  });

  async function signed(timestamp = Math.floor(Date.now() / 1000)) {
    return { 'Stripe-Signature': await buildStripeSignatureHeader(body, secret, timestamp) };
  }

  it('verifies the signature, answers 200, and forwards the event keyed by account to books-api', async () => {
    const h = harness({ 'stripe_fc:fca_1': { connectionId: 'bkc_1', clerkOrgId: 'org_1' } });

    const res = await h.post('stripe_fc', body, await signed(), { STRIPE_FC_WEBHOOK_SECRET: secret });

    expect(res).toEqual({ status: 200, json: { received: true, events: 1 } });
    expect(h.deps.forwarded).toEqual([
      {
        hit: { connectionId: 'bkc_1', clerkOrgId: 'org_1' },
        body: {
          connectionId: 'bkc_1',
          provider: 'stripe_fc',
          providerConnectionId: 'fca_1',
          events: [{ type: 'sync_available', providerConnectionId: 'fca_1', accountIds: ['fca_1'] }],
        },
      },
    ]);
  });

  it('accepts the url spelling stripe-fc', async () => {
    const h = harness({ 'stripe_fc:fca_1': { connectionId: 'bkc_1', clerkOrgId: 'org_1' } });
    expect((await h.post('stripe-fc', body, await signed(), { STRIPE_FC_WEBHOOK_SECRET: secret })).status).toBe(200);
    expect(h.deps.forwarded).toHaveLength(1);
  });

  it('answers 401 and forwards nothing for a bad signature, a stale one, or a missing secret', async () => {
    const h = harness({ 'stripe_fc:fca_1': { connectionId: 'bkc_1', clerkOrgId: 'org_1' } });
    const env = { STRIPE_FC_WEBHOOK_SECRET: secret };

    expect((await h.post('stripe_fc', body, { 'Stripe-Signature': 't=1,v1=deadbeef' }, env)).status).toBe(401);
    expect((await h.post('stripe_fc', body, {}, env)).status).toBe(401);
    expect((await h.post('stripe_fc', body, await signed(Math.floor(Date.now() / 1000) - 3600), env)).status).toBe(401);
    expect((await h.post('stripe_fc', body, await signed(), {})).status).toBe(401);
    expect(h.deps.forwarded).toEqual([]);
  });

  it('acknowledges events it has nothing to do for', async () => {
    const h = harness({});
    const ignored = JSON.stringify({ id: 'evt_2', type: 'financial_connections.account.created', data: { object: { id: 'fca_1' } } });
    const headers = { 'Stripe-Signature': await buildStripeSignatureHeader(ignored, secret, Math.floor(Date.now() / 1000)) };
    expect(await h.post('stripe_fc', ignored, headers, { STRIPE_FC_WEBHOOK_SECRET: secret })).toEqual({ status: 200, json: { received: true, events: 0 } });
    expect(h.deps.forwarded).toEqual([]);
  });
});

describe('Plaid deliveries', () => {
  const body = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item_1' });
  const env = { PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', PLAID_ENV: 'sandbox' };

  async function plaidDelivery(payload: string, signedBody = payload) {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    const header = b64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: 'kid-1', typ: 'JWT' })));
    const claims = b64url(encoder.encode(JSON.stringify({ iat: Math.floor(Date.now() / 1000), request_body_sha256: await sha256Hex(signedBody) })));
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, encoder.encode(`${header}.${claims}`));
    const keyFetches: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      keyFetches.push(url);
      return new Response(JSON.stringify({ key: { alg: 'ES256', crv: 'P-256', kid: 'kid-1', kty: 'EC', use: 'sig', x: jwk.x, y: jwk.y, expired_at: null } }), { status: 200 });
    });
    return { headers: { 'Plaid-Verification': `${header}.${claims}.${b64url(new Uint8Array(signature))}` }, keyFetches };
  }

  beforeEach(() => vi.unstubAllGlobals());

  it('verifies the ES256 token (key fetched from Plaid and cached in KV) and forwards by item id', async () => {
    const h = harness({ 'plaid:item_1': { connectionId: 'bkc_7', clerkOrgId: 'org_7' } });
    const delivery = await plaidDelivery(body);
    const kv = memoryKv();

    const first = await h.post('plaid', body, delivery.headers, { ...env, WORKSPACE_CACHE: kv });
    const second = await h.post('plaid', body, delivery.headers, { ...env, WORKSPACE_CACHE: kv });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(delivery.keyFetches).toEqual(['https://sandbox.plaid.com/webhook_verification_key/get']);
    expect(h.deps.forwarded).toHaveLength(2);
    expect(h.deps.forwarded[0]?.body).toMatchObject({ connectionId: 'bkc_7', provider: 'plaid', providerConnectionId: 'item_1', events: [{ type: 'sync_available' }] });
  });

  it('answers 401 when the body does not match the signed hash', async () => {
    const h = harness({ 'plaid:item_1': { connectionId: 'bkc_7', clerkOrgId: 'org_7' } });
    const delivery = await plaidDelivery(body, `${body} `);
    expect((await h.post('plaid', body, delivery.headers, env)).status).toBe(401);
    expect(h.deps.forwarded).toEqual([]);
  });

  it('answers 401 without a Plaid-Verification header', async () => {
    const h = harness({});
    expect((await h.post('plaid', body, {}, env)).status).toBe(401);
  });
});

describe('routing', () => {
  it('answers 404 for an unknown provider or one that is not configured here', async () => {
    const h = harness({});
    expect((await h.post('teller', '{}')).status).toBe(404);
    expect((await h.post('plaid', '{}')).status).toBe(404); // no PLAID_* secrets on this env
    expect((await h.post('ponto', '{}')).status).toBe(404);
  });
});

describe('dispatchBankFeedEvents', () => {
  const sync = (id: string): FeedEvent => ({ type: 'sync_available', providerConnectionId: id });

  it('groups events per provider connection and skips ids that are not indexed', async () => {
    const h = harness({ 'plaid:a': { connectionId: 'bkc_a', clerkOrgId: 'org_a' } });
    const result = await dispatchBankFeedEvents('plaid', [sync('a'), { type: 'expiring', providerConnectionId: 'a' }, sync('unknown')], h.deps);
    expect(result).toEqual({ forwarded: 1, unknown: 1, failed: 0 });
    expect(h.deps.forwarded[0]?.body.events.map((e) => e.type)).toEqual(['sync_available', 'expiring']);
  });

  it('keeps going when one forward fails', async () => {
    const forwarded: string[] = [];
    const deps: BankFeedWebhookDeps = {
      lookup: async (_p, id) => ({ connectionId: `bkc_${id}`, clerkOrgId: 'org' }),
      forward: async (hit) => {
        if (hit.connectionId === 'bkc_a') throw new Error('books-api answered 500');
        forwarded.push(hit.connectionId);
      },
    };
    const result = await dispatchBankFeedEvents('plaid', [sync('a'), sync('b')], deps);
    expect(result).toEqual({ forwarded: 1, unknown: 0, failed: 1 });
    expect(forwarded).toEqual(['bkc_b']);
  });
});

describe('default dependencies', () => {
  it('forwards over BOOKS_INTERNAL with the workspace header and fails on a non-2xx answer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    const BOOKS_INTERNAL = { fetch: async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response('{}', { status })) } as unknown as Fetcher;
    const deps = defaultDeps({ BOOKS_INTERNAL } as unknown as Env);
    const body = { connectionId: 'bkc_1', provider: 'plaid', providerConnectionId: 'item_1', events: [{ type: 'sync_available' as const, providerConnectionId: 'item_1' }] };

    await deps.forward({ connectionId: 'bkc_1', clerkOrgId: 'org_1' }, body);

    expect(calls[0]?.url).toBe('https://internal/internal/bank-connections/events');
    expect(calls[0]?.init.method).toBe('POST');
    expect((calls[0]?.init.headers as Record<string, string>)['X-Workspace-Id']).toBe('org_1');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(body);

    status = 500;
    await expect(deps.forward({ connectionId: 'bkc_1', clerkOrgId: 'org_1' }, body)).rejects.toThrow('500');
    await expect(defaultDeps({} as Env).forward({ connectionId: 'bkc_1', clerkOrgId: 'org_1' }, body)).rejects.toThrow('BOOKS_INTERNAL');
  });

  it('looks the connection up in the master index', async () => {
    const deps = defaultDeps({} as Env);
    masterRows.rows = [{ connectionId: 'bkc_1', clerkOrgId: 'org_1' }];
    expect(await deps.lookup('plaid', 'item_1')).toEqual({ connectionId: 'bkc_1', clerkOrgId: 'org_1' });
    masterRows.rows = [];
    expect(await deps.lookup('plaid', 'item_x')).toBeNull();
  });
});
