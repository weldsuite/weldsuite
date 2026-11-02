/**
 * `POST /webhooks/bank-feeds/:provider` end to end, through the worker's own
 * `fetch`: the provider's signature, the master `bank_feed_connection_index`
 * lookup on pglite, and the forward to books-api's `BOOKS_INTERNAL` stub.
 * Run on both backends by the `integrations: bank feeds` conformance suite.
 */

import { webcrypto } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStripeSignatureHeader, sha256Hex } from '@weldsuite/bank-feeds';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { conformanceMasterDb } from '@weldsuite/worker-kit/testing/conformance';
import { createWebhookTestApp } from './harness';

const holder = vi.hoisted(() => ({ masterDb: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.masterDb),
}));

type MasterDb = Awaited<ReturnType<typeof createMasterPgliteDb>>['db'];
let masterDb: MasterDb;

const STRIPE_SECRET = 'whsec_fc_test';
const PLAID_URL = 'https://sandbox.plaid.com/webhook_verification_key/get';

function memoryKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  };
}

function booksStub() {
  return {
    fetch: vi.fn(async () => new Response(JSON.stringify({ data: { applied: 1, synced: true } }), { status: 200 })),
  };
}

beforeAll(async () => {
  masterDb = (await createMasterPgliteDb()).db;
  holder.masterDb = masterDb;
});

beforeEach(async () => {
  await masterDb.delete(masterSchema.bankFeedConnectionIndex);
  const now = new Date('2026-10-01T09:00:00.000Z');
  await masterDb.insert(masterSchema.bankFeedConnectionIndex).values([
    {
      id: 'bfi_plaid',
      provider: 'plaid',
      providerConnectionId: 'item_1',
      clerkOrgId: 'org_bank',
      connectionId: 'bkc_plaid',
      entityId: 'ent_1',
      isActive: true,
      syncIntervalHours: 24,
      nextSyncAt: now,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'bfi_fc',
      provider: 'stripe_fc',
      providerConnectionId: 'fca_1',
      clerkOrgId: 'org_bank',
      connectionId: 'bkc_fc',
      entityId: 'ent_1',
      isActive: true,
      syncIntervalHours: 24,
      nextSyncAt: now,
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(app: ReturnType<typeof createWebhookTestApp>, provider: string, body: string, headers: Record<string, string> = {}) {
  return app.request(`/webhooks/bank-feeds/${provider}`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('Stripe Financial Connections', () => {
  const refreshed = (account: string, status = 'succeeded') =>
    JSON.stringify({
      id: 'evt_1',
      type: 'financial_connections.account.refreshed_transactions',
      data: { object: { id: account, transaction_refresh: { status } } },
    });

  async function signed(body: string, secret = STRIPE_SECRET, at = Math.floor(Date.now() / 1000)) {
    return { 'Stripe-Signature': await buildStripeSignatureHeader(body, secret, at) };
  }

  it('verifies the signature, answers 200 and forwards the events of a known account to books-api', async () => {
    const books = booksStub();
    const app = createWebhookTestApp({ masterDb, env: { STRIPE_FC_WEBHOOK_SECRET: STRIPE_SECRET, BOOKS_INTERNAL: books } });
    const body = refreshed('fca_1');

    const res = await post(app, 'stripe-fc', body, await signed(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, events: 1 });
    expect(books.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = books.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://internal/internal/bank-connections/events');
    expect(new Headers(init.headers).get('X-Workspace-Id')).toBe('org_bank');
    expect(JSON.parse(String(init.body))).toEqual({
      connectionId: 'bkc_fc',
      provider: 'stripe_fc',
      providerConnectionId: 'fca_1',
      events: [{ type: 'sync_available', providerConnectionId: 'fca_1', accountIds: ['fca_1'] }],
    });
  });

  it('answers 200 for an account no workspace has, and forwards nothing', async () => {
    const books = booksStub();
    const app = createWebhookTestApp({ masterDb, env: { STRIPE_FC_WEBHOOK_SECRET: STRIPE_SECRET, BOOKS_INTERNAL: books } });
    const body = JSON.stringify({
      id: 'evt_2',
      type: 'financial_connections.account.disconnected',
      data: { object: { id: 'fca_unknown' } },
    });

    const res = await post(app, 'stripe_fc', body, await signed(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, events: 1 });
    expect(books.fetch).not.toHaveBeenCalled();
  });

  it('answers 200 with no events for a delivery it does not act on', async () => {
    const books = booksStub();
    const app = createWebhookTestApp({ masterDb, env: { STRIPE_FC_WEBHOOK_SECRET: STRIPE_SECRET, BOOKS_INTERNAL: books } });
    const body = refreshed('fca_1', 'failed');

    const res = await post(app, 'stripe_fc', body, await signed(body));

    expect(await res.json()).toEqual({ received: true, events: 0 });
    expect(books.fetch).not.toHaveBeenCalled();
  });

  it('still answers 200 when books-api cannot be reached (the due sweep is the safety net)', async () => {
    const app = createWebhookTestApp({ masterDb, env: { STRIPE_FC_WEBHOOK_SECRET: STRIPE_SECRET } });
    const body = JSON.stringify({
      id: 'evt_3',
      type: 'financial_connections.account.deactivated',
      data: { object: { id: 'fca_1' } },
    });

    const res = await post(app, 'stripe_fc', body, await signed(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, events: 1 });
  });

  it('refuses a wrong signature, a stale one and a delivery without the endpoint secret', async () => {
    const books = booksStub();
    const app = createWebhookTestApp({ masterDb, env: { STRIPE_FC_WEBHOOK_SECRET: STRIPE_SECRET, BOOKS_INTERNAL: books } });
    const body = refreshed('fca_1');

    const wrong = await post(app, 'stripe_fc', body, await signed(body, 'whsec_other'));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } });

    const stale = await post(app, 'stripe_fc', body, await signed(body, STRIPE_SECRET, Math.floor(Date.now() / 1000) - 3600));
    expect(stale.status).toBe(401);

    const unsigned = await post(app, 'stripe_fc', body);
    expect(unsigned.status).toBe(401);

    const unconfigured = createWebhookTestApp({ masterDb, env: { BOOKS_INTERNAL: books } });
    const noSecret = await post(unconfigured, 'stripe_fc', body, await signed(body));
    expect(noSecret.status).toBe(401);
    expect(books.fetch).not.toHaveBeenCalled();
  });
});

describe('providers', () => {
  it('answers 404 for an unknown provider and for one without credentials', async () => {
    const app = createWebhookTestApp({ masterDb, env: {} });

    const unknown = await post(app, 'teller', '{}');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Unknown bank feed provider' } });

    expect((await post(app, 'plaid', '{}')).status).toBe(404);
    expect((await post(app, 'ponto', '{}')).status).toBe(404);
    expect((await post(app, 'enable-banking', '{}')).status).toBe(404);
  });

  it('refuses deliveries for providers that are polled (Ponto, Enable Banking)', async () => {
    const app = createWebhookTestApp({
      masterDb,
      env: {
        PONTO_CLIENT_ID: 'ponto-id',
        PONTO_CLIENT_SECRET: 'ponto-secret',
        ENABLE_BANKING_APP_ID: 'eb-app',
        ENABLE_BANKING_PRIVATE_KEY: 'eb-key',
      },
    });

    expect((await post(app, 'ponto', '{}')).status).toBe(401);
    expect((await post(app, 'enable_banking', '{}')).status).toBe(401);
  });
});

describe('Plaid', () => {
  const kid = 'kid-conformance-1';
  let keys: CryptoKeyPair;
  let jwk: JsonWebKey;

  beforeAll(async () => {
    keys = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    jwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey);
  });

  const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

  async function token(body: string, claims: Record<string, unknown> = {}, signer = keys.privateKey) {
    const header = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' })));
    const payload = b64url(
      Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), request_body_sha256: await sha256Hex(body), ...claims })),
    );
    const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, Buffer.from(`${header}.${payload}`));
    return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
  }

  function stubPlaid() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === PLAID_URL && (init?.method ?? 'GET') === 'POST') {
        const requested = JSON.parse(String(init?.body)) as { key_id: string };
        if (requested.key_id !== kid) return new Response(JSON.stringify({ error_code: 'INVALID_KEY' }), { status: 400 });
        return new Response(
          JSON.stringify({
            key: { alg: 'ES256', crv: jwk.crv, kid, kty: jwk.kty, use: 'sig', x: jwk.x, y: jwk.y, created_at: 1700000000, expired_at: null },
            request_id: 'req_1',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const plaidEnv = () => ({ PLAID_CLIENT_ID: 'plaid-client', PLAID_SECRET: 'plaid-secret', PLAID_ENV: 'sandbox' });
  const syncBody = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item_1' });

  it('fetches the verification key, caches it, verifies the token and forwards the item', async () => {
    const fetchMock = stubPlaid();
    const books = booksStub();
    const kv = memoryKv();
    const app = createWebhookTestApp({ masterDb, env: { ...plaidEnv(), WORKSPACE_CACHE: kv, BOOKS_INTERNAL: books } });

    const res = await post(app, 'plaid', syncBody, { 'Plaid-Verification': await token(syncBody) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, events: 1 });
    expect(fetchMock).toHaveBeenCalledWith(PLAID_URL, expect.objectContaining({ method: 'POST' }));
    expect(books.fetch).toHaveBeenCalledTimes(1);
    const [, init] = books.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      connectionId: 'bkc_plaid',
      provider: 'plaid',
      providerConnectionId: 'item_1',
      events: [{ type: 'sync_available', providerConnectionId: 'item_1' }],
    });

    // The key is cached now: the next delivery verifies without a fetch.
    fetchMock.mockClear();
    const login = JSON.stringify({
      webhook_type: 'ITEM',
      webhook_code: 'ERROR',
      item_id: 'item_1',
      error: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'the login details changed' },
    });
    const again = await post(app, 'plaid', login, { 'Plaid-Verification': await token(login) });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ received: true, events: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps the item webhooks it acts on, and ignores the rest', async () => {
    stubPlaid();
    const books = booksStub();
    const app = createWebhookTestApp({ masterDb, env: { ...plaidEnv(), WORKSPACE_CACHE: memoryKv(), BOOKS_INTERNAL: books } });

    const deliveries = [
      { webhook_type: 'ITEM', webhook_code: 'PENDING_EXPIRATION', item_id: 'item_1', consent_expiration_time: '2026-12-01T00:00:00Z' },
      { webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: 'item_1' },
      { webhook_type: 'ITEM', webhook_code: 'USER_ACCOUNT_REVOKED', item_id: 'item_1', account_id: 'acc_9' },
      { webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item_1', error: { error_code: 'INSTITUTION_DOWN' } },
      { webhook_type: 'ITEM', webhook_code: 'WEBHOOK_UPDATE_ACKNOWLEDGED', item_id: 'item_1' },
      { webhook_type: 'AUTH', webhook_code: 'AUTOMATICALLY_VERIFIED', item_id: 'item_1' },
      { webhook_type: 'TRANSACTIONS', webhook_code: 'RECURRING_TRANSACTIONS_UPDATE', item_id: 'item_unknown' },
    ];
    const counts: number[] = [];
    for (const delivery of deliveries) {
      const body = JSON.stringify(delivery);
      const res = await post(app, 'plaid', body, { 'Plaid-Verification': await token(body) });
      expect(res.status).toBe(200);
      counts.push(((await res.json()) as { events: number }).events);
    }
    expect(counts).toEqual([1, 1, 1, 1, 0, 0, 0]);
    expect(books.fetch).toHaveBeenCalledTimes(4);
  });

  it('refuses a missing, malformed, forged, stale or mismatched token', async () => {
    stubPlaid();
    const books = booksStub();
    const app = createWebhookTestApp({ masterDb, env: { ...plaidEnv(), WORKSPACE_CACHE: memoryKv(), BOOKS_INTERNAL: books } });
    const other = (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;

    const cases: Array<Record<string, string>> = [
      {},
      { 'Plaid-Verification': 'not-a-token' },
      { 'Plaid-Verification': await token(syncBody, {}, other.privateKey) },
      { 'Plaid-Verification': await token(syncBody, { iat: Math.floor(Date.now() / 1000) - 3600 }) },
      { 'Plaid-Verification': await token('{"something":"else"}') },
    ];
    for (const headers of cases) {
      const res = await post(app, 'plaid', syncBody, headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } });
    }
    expect(books.fetch).not.toHaveBeenCalled();
  });

  it('refuses a token whose key Plaid does not know', async () => {
    stubPlaid();
    const app = createWebhookTestApp({ masterDb, env: { ...plaidEnv(), WORKSPACE_CACHE: memoryKv(), BOOKS_INTERNAL: booksStub() } });
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'kid-unknown' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000) })).toString('base64url');

    const res = await post(app, 'plaid', syncBody, { 'Plaid-Verification': `${header}.${claims}.c2ln` });

    expect(res.status).toBe(401);
  });
});
