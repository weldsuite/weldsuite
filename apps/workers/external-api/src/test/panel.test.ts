/**
 * `/v1/panel`: the routes turn the public API into calls to panel-api's
 * PanelApiInternal read API (faked here: panel-api's own tests cover what it
 * does with them: visibility, permissions, the read-only allow-list). Not a
 * conformance suite: the Rust backend does not serve WeldPanel's API.
 */

import { describe, expect, it } from 'vitest';
import { createExternalTestApp } from './harness';
import type { ApiKeySession, Env } from '../types';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakePanel(status = 200) {
  const calls: Call[] = [];
  const fetcher = {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined });
      return new Response(JSON.stringify(status === 200 ? { data: [{ id: 'pnp_a' }], pagination: { totalCount: 1, hasMore: false, cursor: null } } : { error: { code: 'NOT_FOUND', message: 'Report not found' } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
  return { calls, fetcher };
}

const workspaceKey = (scopes: string[]): ApiKeySession => ({
  keyId: 'key_ws',
  keyType: 'workspace',
  workspaceId: 'ws_test',
  userId: null,
  scopes,
  tier: 'enterprise',
  databaseUrl: null,
  licensedApps: null,
});

function app(panel: ReturnType<typeof fakePanel> | null, options: { session?: ApiKeySession; scopes?: string[] } = {}) {
  return createExternalTestApp({
    ...(options.session ? { session: options.session } : {}),
    ...(options.scopes ? { scopes: options.scopes } : {}),
    env: (panel ? { PANEL_INTERNAL: panel.fetcher } : {}) as unknown as Partial<Env>,
  });
}

describe('/v1/panel', () => {
  it('forwards every read route to the internal API, with the query string, for the key’s person', async () => {
    const panel = fakePanel();
    const { request } = app(panel);
    const routes: [string, string][] = [
      ['/v1/panel/projects', '/projects'],
      ['/v1/panel/reports?projectId=pnp_a&kind=trends', '/reports?projectId=pnp_a&kind=trends'],
      ['/v1/panel/reports/pnr_1', '/reports/pnr_1'],
      ['/v1/panel/reports/pnr_1/results?preset=7d', '/reports/pnr_1/results?preset=7d'],
      ['/v1/panel/dashboards?projectId=pnp_a', '/dashboards?projectId=pnp_a'],
      ['/v1/panel/dashboards/pnd_1', '/dashboards/pnd_1'],
      ['/v1/panel/cohorts?projectId=pnp_a', '/cohorts?projectId=pnp_a'],
      ['/v1/panel/events?projectId=pnp_a', '/lexicon?projectId=pnp_a'],
      ['/v1/panel/people?projectId=pnp_a&search=ann', '/people?projectId=pnp_a&search=ann'],
      ['/v1/panel/people/user%2F1?projectId=pnp_a', '/people/user%2F1?projectId=pnp_a'],
      ['/v1/panel/groups?projectId=pnp_a&type=company', '/groups?projectId=pnp_a&type=company'],
      ['/v1/panel/groups/company/acme%20inc?projectId=pnp_a', '/groups/company/acme%20inc?projectId=pnp_a'],
    ];
    for (const [path] of routes) expect((await request(path)).status, path).toBe(200);
    expect(panel.calls.map((c) => c.url.replace('https://panel-api.internal/internal/panel/v1/ws_test', ''))).toEqual(routes.map(([, internal]) => internal));
    expect(panel.calls.every((c) => c.method === 'GET' && c.headers['x-weld-user'] === 'user_test')).toBe(true);
  });

  it('posts a query spec as it came', async () => {
    const panel = fakePanel();
    const spec = { kind: 'trends', projectId: 'pnp_a', series: [{ event: 'Signed up' }] };
    const res = await app(panel).request('/v1/panel/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) });
    expect(res.status).toBe(200);
    expect(panel.calls[0]).toMatchObject({ method: 'POST', body: JSON.stringify(spec) });
    expect(panel.calls[0]!.url).toBe('https://panel-api.internal/internal/panel/v1/ws_test/query');

    // The `{ spec }` envelope a tool call sends is unwrapped; a body that is not JSON is refused here.
    await app(panel).request('/v1/panel/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec }) });
    expect(panel.calls[1]!.body).toBe(JSON.stringify(spec));
    expect((await app(panel).request('/v1/panel/query', { method: 'POST', body: '{nope' })).status).toBe(400);
  });

  it('acts as the workspace key when no person is behind it', async () => {
    const panel = fakePanel();
    await app(panel, { session: workspaceKey(['panel:read']) }).request('/v1/panel/reports');
    expect(panel.calls[0]!.headers).toMatchObject({ 'x-weld-workspace-key': 'key_ws' });
    expect(panel.calls[0]!.headers['x-weld-user']).toBeUndefined();
  });

  it('needs panel:read, and passes panel-api’s refusals through', async () => {
    const panel = fakePanel();
    expect((await app(panel, { scopes: ['people:read'] }).request('/v1/panel/projects')).status).toBe(403);
    expect((await app(panel, { scopes: ['panel:*'] }).request('/v1/panel/projects')).status).toBe(200);
    const missing = fakePanel(404);
    const res = await app(missing).request('/v1/panel/reports/pnr_none');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Report not found' } });
  });

  it('answers 503 without the binding, and leaves /v1/panel out of the index', async () => {
    const res = await app(null).request('/v1/panel/projects');
    expect(res.status).toBe(503);
    const index = (await (await app(null).request('/v1')).json()) as { data: { endpoints: string[] } };
    expect(index.data.endpoints).not.toContain('/v1/panel');
    const bound = (await (await app(fakePanel()).request('/v1')).json()) as { data: { endpoints: string[] } };
    expect(bound.data.endpoints).toContain('/v1/panel');
  });

  it('refuses an oversized query body', async () => {
    const panel = fakePanel();
    const res = await app(panel).request('/v1/panel/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
    expect(res.status).toBe(400);
    expect(panel.calls).toHaveLength(0);
  });
});
