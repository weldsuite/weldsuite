/**
 * `/api/integrations` on a real (pglite) tenant database: the object CRUD,
 * MCP server connections (create, tool discovery, connectivity test), the
 * Attio / HubSpot / Google Calendar OAuth connect flows, disconnect, manual
 * sync (the CRM_SYNC Workflow binding), Google Calendar watch renewal, sync
 * logs, field mappings, conflicts and entity mappings, with the permission
 * and validation refusals. Third parties answer from a fetch stub keyed by
 * method and URL; the OAuth state lives in a KV namespace.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { integrationsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

const ALL = ['integrations:read', 'integrations:create', 'integrations:update', 'integrations:delete'] as const;
const t = schema.integrationConnections;

const OAUTH_ENV = {
  ATTIO_CLIENT_ID: 'attio-client',
  ATTIO_CLIENT_SECRET: 'attio-secret',
  HUBSPOT_CLIENT_ID: 'hubspot-client',
  HUBSPOT_CLIENT_SECRET: 'hubspot-secret',
  GOOGLE_CALENDAR_CLIENT_ID: 'gcal-client',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'gcal-secret',
};

/** The fetch the stub hands loopback calls to: the conformance harness's own. */
const realFetch = globalThis.fetch;
const isLoopback = (url: string) => url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Third parties, by method and URL (both backends' calls reach it). */
async function thirdParty(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : '';
  if (method === 'POST' && url === 'https://app.attio.com/oauth/token') {
    if (body.includes('code=bad')) return new Response('invalid code', { status: 400 });
    return jsonResponse({ access_token: 'attio-at', refresh_token: 'attio-rt', token_type: 'bearer' });
  }
  if (method === 'POST' && url === 'https://api.attio.com/v2/webhooks') {
    return jsonResponse({ data: { id: { webhook_id: 'attio-wh-1' }, secret: 'attio-wh-secret' } });
  }
  if (method === 'DELETE' && url.startsWith('https://api.attio.com/v2/webhooks/')) return new Response(null, { status: 204 });
  if (method === 'POST' && url === 'https://api.hubapi.com/oauth/v1/token') {
    return jsonResponse({ access_token: 'hs-at', refresh_token: 'hs-rt', expires_in: 1800, token_type: 'bearer' });
  }
  if (method === 'GET' && url === 'https://api.hubapi.com/oauth/v1/access-tokens/hs-at') return jsonResponse({ hub_id: 4242 });
  if (method === 'POST' && url === 'https://oauth2.googleapis.com/token') {
    if (body.includes('grant_type=refresh_token')) return jsonResponse({ access_token: 'g-at-2', token_type: 'Bearer' });
    return jsonResponse({ access_token: 'g-at', refresh_token: 'g-rt', token_type: 'Bearer' });
  }
  if (method === 'POST' && url === 'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch') {
    return jsonResponse({ id: 'chan-1', resourceId: 'res-1', expiration: '1893456000000' });
  }
  if (method === 'POST' && url === 'https://www.googleapis.com/calendar/v3/channels/stop') return new Response(null, { status: 204 });
  if (url === 'https://mcp.example.com/rpc') {
    if (method === 'HEAD') return new Response(null, { status: 405 });
    return jsonResponse({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'search', description: 'Search things', inputSchema: { type: 'object' } }, { name: 'ping' }] },
    });
  }
  if (url === 'https://mcp-error.example.com/rpc') return jsonResponse({ jsonrpc: '2.0', id: 1, error: { message: 'unknown method' } });
  if (url === 'https://mcp-down.example.com/rpc') return new Response('service unavailable', { status: 503 });
  return new Response('not found', { status: 404 });
}

function stubThirdParties() {
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (isLoopback(url)) return realFetch(input, init);
    return thirdParty(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** A CRM_SYNC Workflow binding that answers by method. */
function crmSyncBinding() {
  return {
    create: vi.fn(async (options: { id?: string }) => ({ id: options?.id ?? 'crm-run' })),
    get: vi.fn(async (id: string) => ({ id, status: async () => ({ status: 'running' }) })),
  };
}

beforeEach(() => {
  stubThirdParties();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let db: Database;
const kv = createMemoryKv();

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function app(options: { grants?: readonly string[]; env?: Record<string, unknown>; orgId?: string | null } = {}) {
  return createTestApp<Env, Variables>('/api/integrations', integrationsRoutes, {
    context: {
      tenantDb: db,
      permissions: permissions(...(options.grants ?? ALL)),
      ...(options.orgId === undefined ? {} : { orgId: options.orgId }),
    },
    env: { WORKSPACE_CACHE: kv, ...OAUTH_ENV, ...(options.env ?? {}) } as never,
  }).request;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function seedConnection(id: string, values: Partial<typeof t.$inferInsert> = {}) {
  await db.insert(t).values({
    id,
    provider: 'attio',
    name: 'Seeded',
    status: 'active',
    direction: 'inbound',
    oauthTokens: { accessToken: 'seed-at' },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...values,
  } as typeof t.$inferInsert);
}

describe('object CRUD', () => {
  it('creates, reads, pages, filters, updates and deletes an integration', async () => {
    const created = await app()('/api/integrations', json({ provider: 'zapier', name: 'Zaps', status: 'active', config: { a: 1 } }));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    await app()('/api/integrations', json({ provider: 'zapier', name: 'More zaps' }));

    const one = await app({ grants: ['integrations:read'] })(`/api/integrations/${data.id}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as { data: { name: string } }).data.name).toBe('Zaps');

    const first = await app()('/api/integrations?provider=zapier&limit=1');
    const page = (await first.json()) as { data: unknown[]; pagination: { hasMore: boolean; cursor: string } };
    expect(page.data).toHaveLength(1);
    expect(page.pagination.hasMore).toBe(true);
    const next = await app()(`/api/integrations?provider=zapier&limit=1&cursor=${page.pagination.cursor}`);
    expect(next.status).toBe(200);
    const filtered = await app()('/api/integrations?status=active&provider=');
    expect(filtered.status).toBe(200);

    const patched = await app({ grants: ['integrations:update'] })(`/api/integrations/${data.id}`, json({ name: 'Renamed', status: 'paused' }, 'PATCH'));
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { data: { id: string } }).data.id).toBe(data.id);

    expect((await app({ grants: ['integrations:delete'] })(`/api/integrations/${data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app()(`/api/integrations/${data.id}`)).status).toBe(404);
  });

  it('refuses a body without a provider, and 404s unknown ids', async () => {
    expect((await app()('/api/integrations', json({ name: 'x' }))).status).toBe(400);
    expect((await app()('/api/integrations/int_missing0000000', json({ name: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await app()('/api/integrations/int_missing0000000', json({ provider: '' }, 'PATCH'))).status).toBe(400);
    expect((await app()('/api/integrations/int_missing0000000', { method: 'DELETE' })).status).toBe(404);
  });

  it('is refused without the matching permission', async () => {
    expect((await app({ grants: ['companies:read'] })('/api/integrations')).status).toBe(403);
    expect((await app({ grants: ['integrations:read'] })('/api/integrations', json({ provider: 'x' }))).status).toBe(403);
  });
});

describe('MCP server connections', () => {
  async function createMcp(url: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await app()('/api/integrations/connections', json({
      provider: 'mcp_server',
      name: `MCP ${url}`,
      settings: { transportType: 'streamable-http', url, authType: 'bearer', ...extra },
      accessToken: 'mcp-token',
    }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  it('creates one, lists it without secrets and reads it with its sync logs', async () => {
    const id = await createMcp('https://mcp.example.com/rpc');
    await db.insert(schema.syncLogs).values({
      id: 'slog_mcp000000001',
      platform: 'attio',
      connectionId: id,
      syncType: 'all',
      status: 'completed',
      triggeredBy: 'manual',
    } as typeof schema.syncLogs.$inferInsert);

    const list = await app({ grants: ['integrations:read'] })('/api/integrations/connections');
    expect(list.status).toBe(200);
    const rows = ((await list.json()) as { data: Array<Record<string, unknown>> }).data;
    const row = rows.find((r) => r.id === id)!;
    expect(row.oauthTokens).toBeUndefined();

    const one = await app()(`/api/integrations/connections/${id}`);
    expect(one.status).toBe(200);
    const detail = ((await one.json()) as { data: { recentLogs: unknown[] } }).data;
    expect(detail.recentLogs).toHaveLength(1);
    expect((await app()(`/api/integrations/connections/${id}/logs`)).status).toBe(200);
    expect((await app()('/api/integrations/connections/intc_missing000000')).status).toBe(404);
  });

  it('refuses an unsupported provider and a bad settings block', async () => {
    expect((await app()('/api/integrations/connections', json({ provider: 'attio', name: 'x', settings: { transportType: 'sse' } }))).status).toBe(400);
    expect((await app()('/api/integrations/connections', json({ provider: 'mcp_server', name: 'x', settings: { transportType: 'pigeon', url: 'nope' } }))).status).toBe(400);
  });

  it('discovers tools, and reports server errors', async () => {
    const id = await createMcp('https://mcp.example.com/rpc');
    const res = await app({ grants: ['integrations:update'] })(`/api/integrations/connections/${id}/discover-tools`, { method: 'POST' });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { tools: Array<{ name: string; description: string }> } };
    expect(data.tools.map((tool) => tool.name)).toEqual(['search', 'ping']);
    expect(data.tools[1].description).toBe('');

    const failing = await createMcp('https://mcp-error.example.com/rpc', { authType: 'api_key' });
    expect((await app()(`/api/integrations/connections/${failing}/discover-tools`, { method: 'POST' })).status).toBe(400);
    const down = await createMcp('https://mcp-down.example.com/rpc', { authType: 'header', headerName: 'X-Key' });
    const downRes = await app()(`/api/integrations/connections/${down}/discover-tools`, { method: 'POST' });
    expect(downRes.status).toBe(400);
    expect(((await downRes.json()) as { error: { message: string } }).error.message).toContain('MCP server returned 503');
  });

  it('refuses discovery for another provider, without a URL, and for an unknown connection', async () => {
    await seedConnection('intc_attio_disc01');
    expect((await app()('/api/integrations/connections/intc_attio_disc01/discover-tools', { method: 'POST' })).status).toBe(400);
    await seedConnection('intc_mcp_nourl001', { provider: 'mcp_server', settings: { transportType: 'stdio' } });
    expect((await app()('/api/integrations/connections/intc_mcp_nourl001/discover-tools', { method: 'POST' })).status).toBe(400);
    expect((await app()('/api/integrations/connections/intc_missing000000/discover-tools', { method: 'POST' })).status).toBe(404);
  });

  it('tests connectivity', async () => {
    const id = await createMcp('https://mcp.example.com/rpc');
    const ok = await app()(`/api/integrations/connections/${id}/test`, { method: 'POST' });
    expect(((await ok.json()) as { data: unknown }).data).toEqual({ connected: true, status: 405 });
    const down = await createMcp('https://mcp-down.example.com/rpc');
    const bad = await app()(`/api/integrations/connections/${down}/test`, { method: 'POST' });
    expect(((await bad.json()) as { data: unknown }).data).toEqual({ connected: false, status: 503 });
    const [row] = await db.select().from(t).where(eq(t.id, down));
    expect(row.lastError).toBe('HTTP 503');

    await seedConnection('intc_mcp_nourl002', { provider: 'mcp_server', settings: {} });
    const noUrl = await app()('/api/integrations/connections/intc_mcp_nourl002/test', { method: 'POST' });
    expect(((await noUrl.json()) as { data: unknown }).data).toEqual({ connected: false, error: 'No URL configured' });
    await seedConnection('intc_attio_test01');
    const other = await app()('/api/integrations/connections/intc_attio_test01/test', { method: 'POST' });
    expect(((await other.json()) as { data: { connected: boolean } }).data.connected).toBe(true);
    expect((await app()('/api/integrations/connections/intc_missing000000/test', { method: 'POST' })).status).toBe(404);
  });

  it('updates names, settings, tokens, entity config and sync settings', async () => {
    const id = await createMcp('https://mcp.example.com/rpc');
    const res = await app({ grants: ['integrations:update'] })(`/api/integrations/connections/${id}`, json({
      name: 'Renamed MCP',
      direction: 'outbound',
      entityConfig: { company: 'inbound' },
      settings: { headerName: 'X-Api' },
      accessToken: '',
      syncSettings: { syncCompanies: false, syncIntervalHours: 12 },
    }, 'PATCH'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ id, updated: true });
    const [row] = await db.select().from(t).where(eq(t.id, id));
    expect(row.oauthTokens).toBeNull();
    expect((row.settings as Record<string, unknown>).url).toBe('https://mcp.example.com/rpc');

    expect((await app()('/api/integrations/connections/intc_missing000000', json({ name: 'x' }, 'PATCH'))).status).toBe(404);
    expect((await app()(`/api/integrations/connections/${id}`, json({ syncSettings: { syncIntervalHours: 500 } }, 'PATCH'))).status).toBe(400);
  });
});

describe('OAuth connect flows', () => {
  const redirectUri = 'https://app.weldsuite.org/settings/integrations/callback';

  async function authorize(provider: string): Promise<string> {
    const res = await app()(`/api/integrations/connections/${provider}/authorize`, json({ redirectUri }));
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { authorizeUrl: string; state: string } };
    return data.state;
  }

  it('connects Attio', async () => {
    const state = await authorize('attio');
    const res = await app()('/api/integrations/connections/attio/callback', json({ code: 'good', state, redirectUri }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; provider: string } };
    expect(data.provider).toBe('attio');
    const [row] = await db.select().from(t).where(eq(t.id, data.id));
    expect(row.webhookId).toBe('attio-wh-1');
    expect(kv.store.has(`intconn:${data.id}`)).toBe(true);
  });

  it('refuses a stale state and reports a failed exchange', async () => {
    expect((await app()('/api/integrations/connections/attio/callback', json({ code: 'good', state: 'nope', redirectUri }))).status).toBe(400);
    const state = await authorize('attio');
    const res = await app()('/api/integrations/connections/attio/callback', json({ code: 'bad', state, redirectUri }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('Attio token exchange failed (400)');
  });

  it('needs an organization and the Attio credentials', async () => {
    expect((await app({ orgId: null })('/api/integrations/connections/attio/authorize', json({ redirectUri }))).status).toBe(400);
    expect((await app({ orgId: null })('/api/integrations/connections/attio/callback', json({ code: 'c', state: 's', redirectUri }))).status).toBe(400);
    expect((await app({ env: { ATTIO_CLIENT_ID: undefined } })('/api/integrations/connections/attio/authorize', json({ redirectUri }))).status).toBe(500);
    const state = await authorize('attio');
    const noSecret = await app({ env: { ATTIO_CLIENT_SECRET: undefined } })('/api/integrations/connections/attio/callback', json({ code: 'good', state, redirectUri }));
    expect(noSecret.status).toBe(500);
    expect((await app()('/api/integrations/connections/attio/authorize', json({ redirectUri: 'not a url' }))).status).toBe(400);
  });

  it('connects HubSpot with its default field mappings and portal id', async () => {
    const state = await authorize('hubspot');
    const res = await app()('/api/integrations/connections/hubspot/callback', json({ code: 'good', state, redirectUri }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(t).where(eq(t.id, data.id));
    expect(row.externalAccountId).toBe('4242');
    expect(row.webhookSecret).toBe('hubspot-secret');

    const mappings = await app()(`/api/integrations/connections/${data.id}/field-mappings?entityType=customer`);
    expect(((await mappings.json()) as { data: unknown[] }).data).toHaveLength(8);
    const defaults = await app()(`/api/integrations/connections/${data.id}/field-mappings/defaults?entityType=opportunity`);
    expect(((await defaults.json()) as { data: unknown[] }).data).toHaveLength(7);
  });

  it('connects Google Calendar, renews its watch and disconnects it', async () => {
    const state = await authorize('google_calendar');
    const res = await app()('/api/integrations/connections/google_calendar/callback', json({ code: 'good', state, redirectUri }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const [row] = await db.select().from(t).where(eq(t.id, data.id));
    expect(row.webhookId).toBe('chan-1');
    expect((row.settings as { googleCalendarId?: string }).googleCalendarId).toMatch(/^cal_/);

    const renewed = await app({ grants: ['integrations:update'] })(`/api/integrations/connections/${data.id}/renew-watch`, { method: 'POST' });
    expect(renewed.status).toBe(200);
    expect(((await renewed.json()) as { data: unknown }).data).toEqual({ message: 'Watch channel renewed' });

    expect((await app({ grants: ['integrations:delete'] })(`/api/integrations/connections/${data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app()(`/api/integrations/connections/${data.id}`)).status).toBe(404);
    expect(kv.store.has(`intconn:${data.id}`)).toBe(false);
  });

  it('refuses unsupported and unconfigured providers, and a state for another provider', async () => {
    expect((await app()('/api/integrations/connections/salesforce/authorize', json({ redirectUri }))).status).toBe(400);
    expect((await app({ env: { HUBSPOT_CLIENT_ID: undefined } })('/api/integrations/connections/hubspot/authorize', json({ redirectUri }))).status).toBe(400);
    expect((await app()('/api/integrations/connections/salesforce/callback', json({ code: 'c', state: 's', redirectUri }))).status).toBe(400);
    const state = await authorize('hubspot');
    expect((await app()('/api/integrations/connections/google_calendar/callback', json({ code: 'c', state, redirectUri }))).status).toBe(400);
    const hubspotState = await authorize('hubspot');
    const noSecret = await app({ env: { HUBSPOT_CLIENT_SECRET: undefined } })('/api/integrations/connections/hubspot/callback', json({ code: 'c', state: hubspotState, redirectUri }));
    expect(noSecret.status).toBe(500);
    expect((await app({ orgId: null })('/api/integrations/connections/hubspot/callback', json({ code: 'c', state: 's', redirectUri }))).status).toBe(400);
    expect((await app()('/api/integrations/connections/hubspot/callback', json({ code: '', state: 's', redirectUri }))).status).toBe(400);
  });
});

describe('disconnect, sync and watch renewal', () => {
  it('disconnects an Attio connection, removing its webhook', async () => {
    await seedConnection('intc_attio_del001', { webhookId: 'attio-wh-9' });
    await kv.put('intconn:intc_attio_del001', '{}');
    expect((await app()('/api/integrations/connections/intc_attio_del001', { method: 'DELETE' })).status).toBe(204);
    const [row] = await db.select().from(t).where(eq(t.id, 'intc_attio_del001'));
    expect(row.status).toBe('inactive');
    expect((await app()('/api/integrations/connections/intc_missing000000', { method: 'DELETE' })).status).toBe(404);
  });

  it('starts a sync on the CRM_SYNC binding, refusing a running one and a connection without tokens', async () => {
    const crmSync = crmSyncBinding();
    await seedConnection('intc_attio_sync01');
    const res = await app({ env: { CRM_SYNC: crmSync } })('/api/integrations/connections/intc_attio_sync01/sync', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ message: 'Sync started' });
    expect(crmSync.create).toHaveBeenCalled();

    const busy = await app({ env: { CRM_SYNC: crmSync } })('/api/integrations/connections/intc_attio_sync01/sync', { method: 'POST' });
    expect(busy.status).toBe(409);

    await seedConnection('intc_attio_stale1', { status: 'syncing', updatedAt: new Date('2026-01-01T00:00:00.000Z') });
    expect((await app({ env: { CRM_SYNC: crmSync } })('/api/integrations/connections/intc_attio_stale1/sync', { method: 'POST' })).status).toBe(200);

    await seedConnection('intc_attio_notok1', { oauthTokens: null });
    expect((await app()('/api/integrations/connections/intc_attio_notok1/sync', { method: 'POST' })).status).toBe(400);
    expect((await app()('/api/integrations/connections/intc_missing000000/sync', { method: 'POST' })).status).toBe(404);
    expect((await app({ orgId: null })('/api/integrations/connections/intc_attio_sync01/sync', { method: 'POST' })).status).toBe(400);
  });

  it('refuses a watch renewal for a non-calendar connection or one without a token', async () => {
    await seedConnection('intc_attio_watch1');
    expect((await app()('/api/integrations/connections/intc_attio_watch1/renew-watch', { method: 'POST' })).status).toBe(404);
    await seedConnection('intc_gcal_notok01', { provider: 'google_calendar', oauthTokens: null });
    const res = await app()('/api/integrations/connections/intc_gcal_notok01/renew-watch', { method: 'POST' });
    expect(res.status).toBe(500);
    expect((await app({ orgId: null })('/api/integrations/connections/intc_gcal_notok01/renew-watch', { method: 'POST' })).status).toBe(400);
  });
});

describe('field mappings, conflicts and entity mappings', () => {
  it('replaces the mappings of an entity type', async () => {
    await seedConnection('intc_attio_map001');
    const res = await app({ grants: ['integrations:update'] })('/api/integrations/connections/intc_attio_map001/field-mappings', json({
      entityType: 'contact',
      mappings: [
        { externalFieldPath: 'email', internalFieldPath: 'email', isRequired: true },
        { externalFieldPath: 'stage', internalFieldPath: 'status', direction: 'inbound', transformType: 'lookup', transformConfig: { lookupTable: { a: 'b' } } },
      ],
    }, 'PUT'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ entityType: 'contact', count: 2 });
    const empty = await app()('/api/integrations/connections/intc_attio_map001/field-mappings', json({ entityType: 'customer', mappings: [] }, 'PUT'));
    expect(empty.status).toBe(200);
    expect((await app()('/api/integrations/connections/intc_attio_map001/field-mappings', json({ entityType: '', mappings: [] }, 'PUT'))).status).toBe(400);
    const all = await app({ grants: ['integrations:read'] })('/api/integrations/connections/intc_attio_map001/field-mappings');
    expect(((await all.json()) as { data: unknown[] }).data).toHaveLength(2);
  });

  it('answers the default mappings, or why there are none', async () => {
    await seedConnection('intc_attio_dflt01');
    const res = await app()('/api/integrations/connections/intc_attio_dflt01/field-mappings/defaults?entityType=customer');
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(9);
    expect((await app()('/api/integrations/connections/intc_attio_dflt01/field-mappings/defaults')).status).toBe(400);
    await seedConnection('intc_mcp_dflt0001', { provider: 'mcp_server' });
    expect((await app()('/api/integrations/connections/intc_mcp_dflt0001/field-mappings/defaults?entityType=customer')).status).toBe(400);
    expect((await app()('/api/integrations/connections/intc_missing000000/field-mappings/defaults?entityType=customer')).status).toBe(404);
  });

  it('lists and resolves conflicts', async () => {
    await seedConnection('intc_attio_conf01');
    const conflict = (id: string, entityType: string) => ({
      id,
      connectionId: 'intc_attio_conf01',
      entityType,
      internalEntityId: `cmp_${id}`,
      externalEntityId: `ext_${id}`,
      conflictType: 'both_modified',
      internalData: { name: 'ours' },
      externalData: { name: 'theirs' },
    });
    await db.insert(schema.integrationSyncConflicts).values([
      conflict('isc_conflict00001', 'customer'),
      conflict('isc_conflict00002', 'contact'),
      conflict('isc_conflict00003', 'contact'),
    ] as (typeof schema.integrationSyncConflicts.$inferInsert)[]);

    const pending = await app({ grants: ['integrations:read'] })('/api/integrations/connections/intc_attio_conf01/conflicts');
    expect(((await pending.json()) as { data: unknown[] }).data).toHaveLength(3);
    const contacts = await app()('/api/integrations/connections/intc_attio_conf01/conflicts?entityType=contact');
    expect(((await contacts.json()) as { data: unknown[] }).data).toHaveLength(2);

    const one = await app()('/api/integrations/connections/intc_attio_conf01/conflicts/isc_conflict00001/resolve', json({ resolution: 'keep_internal' }));
    expect(((await one.json()) as { data: unknown }).data).toEqual({ resolved: true });
    expect((await app()('/api/integrations/connections/intc_attio_conf01/conflicts/isc_conflict00001/resolve', json({ resolution: 'maybe' }))).status).toBe(400);

    const all = await app()('/api/integrations/connections/intc_attio_conf01/conflicts/resolve-all', json({ resolution: 'dismissed', entityType: 'contact' }));
    expect(all.status).toBe(200);
    expect((await app()('/api/integrations/connections/intc_attio_conf01/conflicts/resolve-all', json({ resolution: 'merged' }))).status).toBe(400);
    const resolved = await app()('/api/integrations/connections/intc_attio_conf01/conflicts?resolution=dismissed');
    expect(((await resolved.json()) as { data: unknown[] }).data).toHaveLength(2);
  });

  it('looks up an entity\'s mappings', async () => {
    await db.insert(schema.integrationEntityMappings).values({
      id: 'iem_mapping000001',
      connectionId: 'intc_attio_conf01',
      externalEntityType: 'company',
      externalEntityId: 'ext-1',
      internalEntityType: 'customer',
      internalEntityId: 'cmp_1',
    } as typeof schema.integrationEntityMappings.$inferInsert);
    const res = await app({ grants: ['integrations:read'] })('/api/integrations/entity-mappings?internalEntityType=customer&internalEntityId=cmp_1');
    expect(((await res.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await app()('/api/integrations/entity-mappings?internalEntityType=customer')).status).toBe(400);
  });
});
