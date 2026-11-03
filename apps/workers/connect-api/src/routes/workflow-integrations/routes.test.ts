/**
 * /api/workflow-integrations on pglite: the catalog, the generic rows (list,
 * read, create, update, connect, delete), an API-key connection and the
 * refusals (integration.test.ts and github.test.ts cover the OAuth flows,
 * the tests and the pickers).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const { workflowIntegrationsRoutes } = await import('./index');

let db: Database;

const ALL = ['integrations:read', 'integrations:create', 'integrations:update', 'integrations:delete'];

/** Minimal in-memory KV stand-in. */
function fakeKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  } as unknown as KVNamespace;
}

function app(granted: string[] = ALL) {
  return createTestApp<Env, Variables>('/api/workflow-integrations', workflowIntegrationsRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db },
    env: { WORKSPACE_CACHE: fakeKv() },
  }).request;
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 8, minute));
  await db.insert(schema.workflowIntegrations).values([
    {
      id: 'int_g_slack',
      name: 'Slack',
      type: 'slack',
      category: 'communication',
      status: 'connected',
      oauthTokens: { accessToken: 'xoxb-1' },
      updatedAt: at(1),
    },
    { id: 'int_g_custom', name: 'Custom hook', type: 'custom', status: 'disconnected', updatedAt: at(2) },
  ]);
}, 60_000);

describe('reading integrations', () => {
  it('serves the provider catalog', async () => {
    const res = await app()('/api/workflow-integrations/catalog');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.map((d) => d.id)).toContain('slack');
  });

  it('lists rows without their secrets, filtered', async () => {
    const request = app();
    const all = (await (await request('/api/workflow-integrations')).json()) as {
      data: Array<{ id: string; hasOauthTokens: boolean; oauthTokens?: unknown }>;
    };
    expect(all.data.map((i) => i.id)).toEqual(['int_g_custom', 'int_g_slack']);
    expect(all.data[1]).toMatchObject({ hasOauthTokens: true });
    expect(all.data[1]).not.toHaveProperty('oauthTokens');
    const slack = (await (await request('/api/workflow-integrations?type=slack&status=connected')).json()) as {
      data: Array<{ id: string }>;
    };
    expect(slack.data.map((i) => i.id)).toEqual(['int_g_slack']);
  });

  it('counts the categories and reads one row', async () => {
    const request = app();
    const categories = (await (await request('/api/workflow-integrations/categories')).json()) as { data: unknown };
    expect(categories.data).toEqual(
      expect.arrayContaining([
        { id: 'communication', name: 'Communication', count: 1 },
        { id: 'custom', name: 'Custom', count: 1 },
      ]),
    );
    const one = await request('/api/workflow-integrations/int_g_slack');
    expect(one.status).toBe(200);
    expect((await request('/api/workflow-integrations/int_nope')).status).toBe(404);
  });
});

describe('changing integrations', () => {
  it('creates, renames, connects and deletes a row', async () => {
    const request = app();
    const created = await request(
      '/api/workflow-integrations',
      send('POST', { name: 'Webhook relay', category: 'developer', settings: { region: 'eu' } }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string; type: string; status: string; hasCredentials: boolean } };
    expect(data).toMatchObject({ type: 'custom', status: 'disconnected', hasCredentials: false });

    const renamed = await request(`/api/workflow-integrations/${data.id}`, send('PATCH', { name: 'Relay' }));
    expect(((await renamed.json()) as { data: { name: string } }).data.name).toBe('Relay');
    const put = await request(`/api/workflow-integrations/${data.id}`, send('PUT', { icon: 'webhook' }));
    expect(put.status).toBe(200);

    const connected = await request(`/api/workflow-integrations/${data.id}/connect`, send('PATCH', { credentials: { key: 'k' } }));
    expect(((await connected.json()) as { data: unknown }).data).toEqual({ id: data.id, status: 'connected' });

    expect((await request(`/api/workflow-integrations/${data.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await request(`/api/workflow-integrations/${data.id}`)).status).toBe(404);
  });

  it('connects an API-key provider', async () => {
    const res = await app()('/api/workflow-integrations/notion/apikey', send('POST', { credentials: { apiKey: 'secret_1' } }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; status: string; provider: string } };
    expect(data).toMatchObject({ status: 'connected', provider: 'notion' });
    const row = (await (await app()(`/api/workflow-integrations/${data.id}`)).json()) as { data: { hasCredentials: boolean } };
    expect(row.data.hasCredentials).toBe(true);
  });

  it('refuses unknown rows and providers, bad bodies and missing permissions', async () => {
    const request = app();
    expect((await request('/api/workflow-integrations/int_nope', send('PATCH', { name: 'x' }))).status).toBe(404);
    expect((await request('/api/workflow-integrations/int_nope/connect', send('PATCH', {}))).status).toBe(404);
    expect((await request('/api/workflow-integrations/int_nope', { method: 'DELETE' })).status).toBe(404);
    expect((await request('/api/workflow-integrations/slack/apikey', send('POST', { credentials: { a: 'b' } }))).status).toBe(404);
    expect((await request('/api/workflow-integrations/notion/apikey', send('POST', { credentials: { a: 1 } }))).status).toBe(400);
    expect((await request('/api/workflow-integrations', send('POST', { name: '' }))).status).toBe(400);
    expect((await app(['integrations:read'])('/api/workflow-integrations', send('POST', { name: 'x' }))).status).toBe(403);
  });
});
