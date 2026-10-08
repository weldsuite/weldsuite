/**
 * Bank connection routes on pglite with a scripted provider. The runtime
 * wiring (provider config, master index, encryption keys) is replaced by the
 * test context; everything under the routes is real.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { FeedProviderError } from '@weldsuite/bank-feeds';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import type { FeedContext } from '../../services/bank-feeds/types';
import {
  FakeProvider,
  feedAccount,
  makeContext,
  page,
  seedBankAccount,
  seedEntity,
  tx,
  type MemoryIndex,
} from '../../services/bank-feeds/testing';

const state = vi.hoisted(() => ({
  ctx: null as unknown as FeedContext,
  institutions: [] as Array<{ id: string; name: string; country: string }>,
}));

vi.mock('../../services/bank-feeds/runtime', async () => {
  const { bankFeedConfigFromEnv: configFromEnv, createBankFeedProvider } = await import('@weldsuite/bank-feeds');
  const config = configFromEnv({ PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', STRIPE_FC_SECRET_KEY: 'sk_test', PONTO_CLIENT_ID: 'p', PONTO_CLIENT_SECRET: 's' });
  return {
    createFeedContext: () => state.ctx,
    createInternalFeedContext: async () => (state.ctx.clerkOrgId === 'org_unknown' ? null : state.ctx),
    feedProviders: () => ({
      config,
      get: (id: string) => {
        if (id === 'enable_banking') {
          return { id, capabilities: {}, listInstitutions: async () => state.institutions };
        }
        return createBankFeedProvider(id, config);
      },
    }),
  };
});

import { bankConnectionsRoutes } from './index';
import { bankConnectionsInternalRoutes } from './internal';

let db: Database;
let provider: FakeProvider;
let ctx: FeedContext & { index: MemoryIndex };
const ENTITY = 'ent_us';
const sent: Array<{ eventType: string; data: Record<string, unknown> }> = [];

const env = { ENTITY_EVENTS: { send: async (m: { eventType: string; data: Record<string, unknown> }) => void sent.push(m) } } as unknown as Partial<Env>;

function client(perms: string[] = ['*'], headers: Record<string, string> = { 'X-Accounting-Entity-Id': ENTITY }) {
  const { request } = createTestApp('/api/bank-connections', bankConnectionsRoutes, {
    context: { tenantDb: db, permissions: permissions(...perms), orgId: 'org_test', workspaceId: 'ws_1' },
    env,
  });
  return async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await request(`/api/bank-connections${path === '/' ? '' : path}`, {
      method: init.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as { data?: any; error?: { code: string; message: string }; pagination?: unknown } | null };
  };
}

function internal(trusted = true) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (trusted) c.set('internalTrusted', true);
    await next();
  });
  app.route('/internal/bank-connections', bankConnectionsInternalRoutes);
  const executionCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
  return async (path: string, body?: unknown, headers: Record<string, string> = { 'X-Workspace-Id': 'org_test' }) => {
    const res = await app.request(
      `/internal/bank-connections${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
      env as unknown as Record<string, unknown>,
      executionCtx,
    );
    return { status: res.status, json: (await res.json()) as { data?: any; error?: { code: string; message: string } } };
  };
}

async function linkAndMap() {
  provider.linkResult = {
    connection: { provider: 'plaid', providerConnectionId: 'item_1', institutionId: 'ins_1', institutionName: 'First Platypus Bank', status: 'active', credentials: { accessToken: 'access-secret-1' }, cursor: null },
    accounts: [feedAccount({ providerAccountId: 'acc_feed_1' }), feedAccount({ providerAccountId: 'acc_card', name: 'Card', mask: '4242', type: 'credit', subtype: 'credit_card' })],
  };
  const api = client();
  const completed = await api('/complete', { method: 'POST', body: { provider: 'plaid', payload: { publicToken: 'public-1' } } });
  const id = completed.json?.data.connection.id as string;
  await api(`/${id}/map-accounts`, { method: 'POST', body: { mappings: [{ feedAccountId: 'acc_feed_1', create: { name: 'Checking' } }], sync: false } });
  return { api, id };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await seedEntity(db, ENTITY);
  await seedEntity(db, 'ent_nl', 'NL', 'EUR');
}, 60_000);

beforeEach(async () => {
  sent.length = 0;
  for (const table of [schema.bankTransactions, schema.bankFeedPendingTransactions, schema.bankAccounts, schema.bankConnections, schema.accounts]) {
    await db.delete(table);
  }
  provider = new FakeProvider();
  ctx = makeContext(db, provider);
  state.ctx = ctx;
  state.institutions = [];
});

describe('GET /providers and /institutions', () => {
  it('offers the configured providers for the country with their capabilities', async () => {
    const api = client();
    const us = await api('/providers?country=US');
    expect(us.status).toBe(200);
    expect(us.json?.data.country).toBe('US');
    expect(us.json?.data.providers.map((p: { id: string }) => p.id)).toEqual(['plaid', 'stripe_fc']);
    expect(us.json?.data.providers[0]).toMatchObject({ kind: 'plaid_link', requiresInstitution: false, capabilities: { changeCursor: true, maxHistoryDays: 730 } });
    expect(us.json?.data.providers[1].kind).toBe('stripe_fc');

    const nl = await api('/providers?country=NL');
    expect(nl.json?.data.providers.map((p: { id: string }) => p.id)).toEqual(['ponto']);
    expect(nl.json?.data.providers[0].kind).toBe('redirect');
  });

  it('defaults the country from the entity jurisdiction', async () => {
    const nl = await client(['*'], { 'X-Accounting-Entity-Id': 'ent_nl' })('/providers');
    expect(nl.json?.data.country).toBe('NL');
    expect(nl.json?.data.providers.map((p: { id: string }) => p.id)).toEqual(['ponto']);
  });

  it('lists institutions for providers that need the bank up front', async () => {
    state.institutions = [{ id: 'ING', name: 'ING', country: 'NL' }];
    const api = client();
    const ok = await api('/institutions?provider=enable_banking&country=NL');
    expect(ok.json?.data).toEqual([{ id: 'ING', name: 'ING', country: 'NL' }]);
    expect((await api('/institutions?provider=enable_banking')).status).toBe(400);
    expect((await api('/institutions?provider=plaid&country=US')).status).toBe(400);
    expect((await api('/institutions?provider=teller&country=US')).status).toBe(400); // unknown provider
  });
});

describe('link flow', () => {
  it('starts a link session', async () => {
    const res = await client()('/link-session', { method: 'POST', body: { provider: 'plaid', redirectUrl: 'https://app.example/weldbooks/banking/callback' } });
    expect(res.status).toBe(201);
    expect(res.json?.data).toMatchObject({ provider: 'plaid', kind: 'plaid_link', token: 'link-create-new', historyDays: 730 });
  });

  it('validates the request and reports an unconfigured provider as 503', async () => {
    const api = client();
    expect((await api('/link-session', { method: 'POST', body: { provider: 'plaid', redirectUrl: 'not a url' } })).status).toBe(400);
    ctx.getProvider = () => {
      throw new FeedProviderError('teller', 'not_configured', "Bank feed provider 'teller' is not configured");
    };
    const unavailable = await api('/link-session', { method: 'POST', body: { provider: 'teller', redirectUrl: 'https://app.example/cb' } });
    expect(unavailable.status).toBe(503);
    expect(unavailable.json?.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('completes a link: 201, the connection with accounts and suggestions, no secrets, one created event', async () => {
    await seedBankAccount(db, { id: 'ba_existing', entityId: ENTITY, name: 'Checking', accountNumberLast4: '0000' });
    provider.linkResult = {
      connection: { provider: 'plaid', providerConnectionId: 'item_1', institutionId: 'ins_1', institutionName: 'First Platypus Bank', status: 'active', credentials: { accessToken: 'access-secret-1' }, cursor: null },
      accounts: [feedAccount({ providerAccountId: 'acc_feed_1' })],
    };

    const res = await client()('/complete', { method: 'POST', body: { provider: 'plaid', payload: { publicToken: 'public-1' } } });

    expect(res.status).toBe(201);
    expect(res.json?.data.connection).toMatchObject({ provider: 'plaid', status: 'active', institutionName: 'First Platypus Bank' });
    expect(res.json?.data.accounts[0]).toMatchObject({ feedAccountId: 'acc_feed_1', bankAccountId: null, suggestion: { bankAccountId: 'ba_existing', reason: 'last4' } });
    expect(JSON.stringify(res.json)).not.toContain('access-secret-1');
    expect(res.json?.data.connection.credentialsEncrypted).toBeUndefined();

    expect(sent.map((m) => m.eventType)).toEqual(['bank_connection:created']);
    expect(JSON.stringify(sent)).not.toContain('access-secret-1');
    expect(sent[0]?.data).toMatchObject({ provider: 'plaid', status: 'active', accountCount: 1 });
    expect(sent[0]?.data).not.toHaveProperty('credentials');
  });

  it('answers a provider rejection with 400 and its message', async () => {
    provider.completeLink = async () => {
      throw new FeedProviderError('plaid', 'permanent', 'Plaid INVALID_PUBLIC_TOKEN');
    };
    const res = await client()('/complete', { method: 'POST', body: { provider: 'plaid', payload: {} } });
    expect(res.status).toBe(400);
    expect(res.json?.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Plaid INVALID_PUBLIC_TOKEN' });
  });
});

describe('connections', () => {
  it('lists, maps, syncs, disconnects and deletes a connection', async () => {
    const { api, id } = await linkAndMap();

    const listed = await api('/');
    expect(listed.status).toBe(200);
    expect(listed.json?.data).toHaveLength(1);
    expect(listed.json?.data[0].accounts.find((a: { feedAccountId: string }) => a.feedAccountId === 'acc_feed_1').bankAccountId).toBeTruthy();
    expect(listed.json?.pagination).toMatchObject({ totalCount: 1, hasMore: false });
    expect(JSON.stringify(listed.json)).not.toContain('access-secret-1');

    provider.script = [page({ upserts: [tx({ providerTransactionId: 't1' }), tx({ providerTransactionId: 'p1', pending: true, amountMinor: -300, description: 'Hold' })] })];
    const synced = await api(`/${id}/sync`, { method: 'POST', body: { refresh: true } });
    expect(synced.status).toBe(200);
    expect(synced.json?.data.outcome).toMatchObject({ added: 1, pending: 1, status: 'active' });
    expect(provider.refreshed).toBe(1);
    expect(synced.json?.data.connection.lastSyncedAt).toBeTruthy();

    const one = await api(`/${id}`);
    expect(one.status).toBe(200);
    expect(one.json?.data).toMatchObject({ id, provider: 'plaid', status: 'active' });
    expect(JSON.stringify(one.json)).not.toContain('access-secret-1');

    const pending = await api(`/${id}/pending`);
    expect(pending.json?.data).toEqual([expect.objectContaining({ amount: '-3.00', description: 'Hold' })]);

    const disconnected = await api(`/${id}/disconnect`, { method: 'POST' });
    expect(disconnected.status).toBe(200);
    expect(disconnected.json?.data.status).toBe('disconnected');
    expect(provider.disconnected).toHaveLength(1);

    const removed = await api(`/${id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await api('/')).json?.data).toEqual([]);
    expect(await db.select().from(schema.bankTransactions)).toHaveLength(1); // the synced line stays

    expect(sent.map((m) => m.eventType)).toEqual([
      'bank_connection:created',
      'bank_connection:updated', // map-accounts
      'bank_connection:synced',
      'bank_connection:updated', // disconnect
      'bank_connection:deleted',
    ]);
    expect(JSON.stringify(sent)).not.toContain('access-secret-1');
  });

  it('maps accounts and starts the first sync in the background by default', async () => {
    provider.linkResult = {
      connection: { provider: 'plaid', providerConnectionId: 'item_1', institutionId: null, institutionName: 'Bank', status: 'active', credentials: { accessToken: 'a' }, cursor: null },
      accounts: [feedAccount({ providerAccountId: 'acc_feed_1' })],
    };
    const api = client();
    const id = (await api('/complete', { method: 'POST', body: { provider: 'plaid', payload: {} } })).json?.data.connection.id as string;
    const res = await api(`/${id}/map-accounts`, { method: 'POST', body: { mappings: [{ feedAccountId: 'acc_feed_1', create: { name: 'Checking', accountType: 'checking' } }] } });
    expect(res.status).toBe(200);
    expect(res.json?.data).toMatchObject({ syncStarted: true, mapped: [{ feedAccountId: 'acc_feed_1', created: true }] });
  });

  it('rejects invalid mappings', async () => {
    const { api, id } = await linkAndMap();
    expect((await api(`/${id}/map-accounts`, { method: 'POST', body: { mappings: [] } })).status).toBe(400);
    expect((await api(`/${id}/map-accounts`, { method: 'POST', body: { mappings: [{ feedAccountId: 'nope', create: { name: 'x' } }] } })).status).toBe(400);
    expect((await api(`/${id}/map-accounts`, { method: 'POST', body: { mappings: [{ feedAccountId: 'acc_card', bankAccountId: 'ba_missing' }] } })).status).toBe(404);
    expect((await api(`/${id}/map-accounts`, { method: 'POST', body: { mappings: [{ feedAccountId: 'acc_card', create: { name: 'x' }, syncFrom: '10/01/2026' }] } })).status).toBe(400);
  });

  it('answers 404 for an unknown id and for a connection of another entity', async () => {
    const { api, id } = await linkAndMap();
    expect((await api('/bkc_nope/sync', { method: 'POST' })).status).toBe(404);
    expect((await api('/bkc_nope/pending')).status).toBe(404);
    expect((await api('/bkc_nope', { method: 'DELETE' })).status).toBe(404);

    const otherEntity = client(['*'], { 'X-Accounting-Entity-Id': 'ent_nl' });
    expect((await otherEntity(`/${id}/pending`)).status).toBe(404);
    expect((await otherEntity(`/${id}/disconnect`, { method: 'POST' })).status).toBe(404);
    expect((await otherEntity('/')).json?.data).toEqual([]);
  });

  it('reports a provider outage on disconnect as 502 and keeps the connection', async () => {
    const { api, id } = await linkAndMap();
    provider.disconnectError = new FeedProviderError('plaid', 'transient', 'Plaid responded 503');
    const res = await api(`/${id}/disconnect`, { method: 'POST' });
    expect(res.status).toBe(502);
    expect(res.json?.error).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect((await api('/')).json?.data[0].status).toBe('active');
  });
});

describe('permissions', () => {
  it('gates every endpoint by banking permission', async () => {
    const { id } = await linkAndMap();
    const readOnly = client(['banking:read']);
    expect((await readOnly('/')).status).toBe(200);
    expect((await readOnly('/providers?country=US')).status).toBe(200);
    expect((await readOnly(`/${id}/pending`)).status).toBe(200);
    expect((await readOnly('/link-session', { method: 'POST', body: { provider: 'plaid', redirectUrl: 'https://a.example' } })).status).toBe(403);
    expect((await readOnly('/complete', { method: 'POST', body: { provider: 'plaid', payload: {} } })).status).toBe(403);
    expect((await readOnly(`/${id}/map-accounts`, { method: 'POST', body: { mappings: [{ feedAccountId: 'a', create: { name: 'x' } }] } })).status).toBe(403);
    expect((await readOnly(`/${id}/sync`, { method: 'POST' })).status).toBe(403);
    expect((await readOnly(`/${id}/disconnect`, { method: 'POST' })).status).toBe(403);
    expect((await readOnly(`/${id}`, { method: 'DELETE' })).status).toBe(403);

    const operator = client(['banking:read', 'banking:create', 'banking:update']);
    expect((await operator(`/${id}/sync`, { method: 'POST' })).status).toBe(200);
    expect((await operator(`/${id}/disconnect`, { method: 'POST' })).status).toBe(403);
    expect((await operator(`/${id}`, { method: 'DELETE' })).status).toBe(403);

    expect((await client([])('/')).status).toBe(403);
  });
});

describe('internal routes (BooksInternal)', () => {
  it('refuses calls that did not come over the service binding', async () => {
    const res = await internal(false)('/bkc_1/sync');
    expect(res.status).toBe(401);
    expect((await internal(false)('/events', { connectionId: 'a', provider: 'plaid', providerConnectionId: 'b', events: [] })).status).toBe(401);
  });

  it('syncs one connection for the due sweep', async () => {
    const { id } = await linkAndMap();
    provider.script = [page({ upserts: [tx({ providerTransactionId: 't1' })] })];

    const res = await internal()(`/${id}/sync`);

    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ connectionId: id, added: 1, status: 'active' });
    expect(sent.at(-1)).toMatchObject({ eventType: 'bank_connection:synced' });
  });

  it('answers 404 for an unknown connection and 400 without a workspace', async () => {
    expect((await internal()('/bkc_nope/sync')).status).toBe(404);
    state.ctx = { ...ctx, clerkOrgId: 'org_unknown' };
    expect((await internal()('/bkc_1/sync')).status).toBe(400);
  });

  it('reports a failed sync in the outcome, so the sweeper can back off', async () => {
    const { id } = await linkAndMap();
    provider.script = [new FeedProviderError('plaid', 'rate_limit', 'Plaid RATE_LIMIT_EXCEEDED')];
    const res = await internal()(`/${id}/sync`);
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ error: 'Plaid RATE_LIMIT_EXCEEDED', retryable: true });
  });

  it('applies status events and runs a sync on sync_available', async () => {
    const { id } = await linkAndMap();

    const reauth = await internal()('/events', {
      connectionId: id,
      provider: 'plaid',
      providerConnectionId: 'item_1',
      events: [{ type: 'reauth_required', providerConnectionId: 'item_1', message: 'login' }],
    });
    expect(reauth.status).toBe(200);
    expect(reauth.json.data).toMatchObject({ applied: 1, synced: false });
    expect((await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id)))[0]?.status).toBe('reauth_required');

    provider.script = [page({ upserts: [tx({ providerTransactionId: 't9' })] })];
    const sync = await internal()('/events', {
      connectionId: id,
      provider: 'plaid',
      providerConnectionId: 'item_1',
      events: [{ type: 'sync_available', providerConnectionId: 'item_1' }],
    });
    expect(sync.json.data).toMatchObject({ applied: 1, synced: true });
    expect((await db.select().from(schema.bankTransactions)).map((r) => r.providerTransactionId)).toEqual(['t9']);
    expect((await db.select().from(schema.bankConnections).where(eq(schema.bankConnections.id, id)))[0]?.status).toBe('active');
  });

  it('drops the stale index row of a deleted connection', async () => {
    await ctx.index.upsert([{ provider: 'plaid', providerConnectionId: 'item_gone', clerkOrgId: 'org_test', connectionId: 'bkc_gone', entityId: ENTITY, syncIntervalHours: 24, nextSyncAt: new Date() }]);
    const res = await internal()('/events', {
      connectionId: 'bkc_gone',
      provider: 'plaid',
      providerConnectionId: 'item_gone',
      events: [{ type: 'sync_available', providerConnectionId: 'item_gone' }],
    });
    expect(res.json.data).toMatchObject({ missing: true });
    expect(ctx.index.rows.size).toBe(0);
  });

  it('rejects a malformed events payload', async () => {
    const res = await internal()('/events', { connectionId: 'a', events: [{ type: 'nonsense' }] });
    expect(res.status).toBe(400);
  });
});
