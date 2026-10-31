/**
 * The whole worker (`src/index.ts`) on pglite: the routes outside `/api`
 * (`/health`, `/robots.txt`, the 404), the CORS answers every response and
 * preflight carries, and the widget-auth middleware every `/api/*` request
 * passes: widget id header, registry, workspace, widget settings, the enabled
 * switch and the allowed-domains policy.
 *
 * The master database holds the registry (`widget_registry`, `workspaces`), the
 * tenant database the widget's settings. Both are mocked into the worker's own
 * `db` module and shared with the Rust backend by the conformance harness.
 * `GET /api/config` is the probe route behind the middleware.
 *
 * The Rust server serves this worker under `/public/helpdesk-widget`
 * (`rustBasePath`); the Hono app and these tests keep the worker's own paths.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  WIDGET,
  addDanglingWidget,
  addWidget,
  bearer,
  get,
  json,
  seedWorkspaces,
  startSession,
  widgetEnv } from './test/widget-fixtures';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('./db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  getWorkspaceForOrg: async () => ({ id: 'ws_acme' }),
}));

import worker from './index';

const RUST_BASE = '/public/helpdesk-widget';

let tenantDb: Database;
let masterDb: Database;

function app(env: Record<string, unknown> = {}) {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv(env),
    rustBasePath: RUST_BASE,
  });
}

/**
 * The whole worker behind one catch-all. `createTestApp` mounts a router into
 * its own app, which keeps the router's routes and middleware but not its
 * `notFound` handler; handing the request to the worker itself answers it as
 * the deployed worker would.
 */
function deployed() {
  const passthrough = new Hono();
  passthrough.all('*', (c) => worker.fetch(c.req.raw, c.env as never, c.executionCtx));
  return createTestApp('/', passthrough as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv(),
    rustBasePath: RUST_BASE,
  });
}

const call = (path: string, init?: RequestInit, env?: Record<string, unknown>) => app(env).request(path, init);

const CONFIG = '/api/config';

/** A comma-separated header as a sorted, lowercased list: browsers read these without regard to case or order. */
const headerList = (res: Response, name: string) =>
  (res.headers.get(name) ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .sort();

const unauthorized = (message: string) => ({ success: false, error: { code: 'UNAUTHORIZED', message } });
const forbidden = (message: string) => ({ success: false, error: { code: 'FORBIDDEN', message } });

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;

  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET);
  await addWidget(masterDb, tenantDb, 'wdg_inactive', { active: false });
  await addWidget(masterDb, tenantDb, 'wdg_noorg', { workspaceId: 'ws_noorg' });
  await addDanglingWidget(masterDb, 'wdg_gone');
  // In the registry, but its settings row was never written.
  await addWidget(masterDb, tenantDb, 'wdg_nosettings', { settings: null });
  await addWidget(masterDb, tenantDb, 'wdg_disabled', { settings: { enabled: false } });

  await addWidget(masterDb, tenantDb, 'wdg_domain', { settings: { allowedDomains: ['example.com'] } });
  await addWidget(masterDb, tenantDb, 'wdg_open', { settings: { allowedDomains: [] } });
  await addWidget(masterDb, tenantDb, 'wdg_blank', { settings: { allowedDomains: [''] } });
  // Entries written by hand: a scheme, a port, a path, a wildcard, capitals, spaces, a leading dot.
  await addWidget(masterDb, tenantDb, 'wdg_hand', {
    settings: {
      allowedDomains: [
        'HTTPS://Acme.COM:8443/some/path?x=1#frag',
        '*.wild.test',
        '  spaced.test  ',
        '.dotted.test',
        'https://*.stars.test:9000',
        '',
        'localhost:3000',
      ],
    },
  });
}, 120_000);

describe('GET /health', () => {
  it('answers the environment and the time, without a widget id', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; environment: string; timestamp: string };
    expect(body).toEqual({ status: 'ok', environment: 'test', timestamp: expect.any(String) });
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    expect(Math.abs(Date.now() - new Date(body.timestamp).getTime())).toBeLessThan(60_000);
  });

  it('reports the ENVIRONMENT binding', async () => {
    const res = await call('/health', undefined, { ENVIRONMENT: 'production' });
    expect(((await res.json()) as { environment: string }).environment).toBe('production');
  });
});

describe('GET /robots.txt', () => {
  it('disallows every crawler', async () => {
    const res = await call('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('User-agent: *\nDisallow: /\n');
  });
});

describe('unknown paths', () => {
  it('answers 404 with the path, outside /api', async () => {
    const res = await deployed().request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found', path: '/nope' });
  });

  it('answers 404 for a method a route does not have, and for an unknown /api path, once the widget is known', async () => {
    const post = await deployed().request(CONFIG, json({}));
    expect(post.status).toBe(404);
    expect(await post.json()).toEqual({ error: 'Not Found', path: CONFIG });

    const unknown = await deployed().request('/api/unknown', get());
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not Found', path: '/api/unknown' });
  });

  it('refuses an unknown /api path without a widget id before it is a 404', async () => {
    const res = await deployed().request('/api/unknown');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(unauthorized('Missing x-widget-id header'));
  });
});

describe('CORS', () => {
  it('lets any origin read a response, errors included', async () => {
    const ok = await call(CONFIG, get(WIDGET, { Origin: 'https://shop.example' }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');

    const refused = await call(CONFIG, { headers: { Origin: 'https://shop.example' } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('access-control-allow-origin')).toBe('*');

    const health = await call('/health', { headers: { Origin: 'https://shop.example' } });
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers a preflight without a widget id', async () => {
    for (const path of ['/api/conversations', '/api/attachments/upload', '/api/visitor', CONFIG, '/health']) {
      const res = await call(path, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://shop.example',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type,x-widget-id',
        },
      });
      expect(res.status, path).toBe(204);
      expect(res.headers.get('access-control-allow-origin'), path).toBe('*');
      expect(headerList(res, 'access-control-allow-methods'), path).toEqual(['delete', 'get', 'options', 'patch', 'post', 'put']);
      // The visitor token travels in `Authorization`.
      expect(headerList(res, 'access-control-allow-headers'), path).toEqual(['authorization', 'content-type', 'x-widget-id']);
      expect(res.headers.get('access-control-allow-credentials'), path).toBeNull();
    }
  });
});

describe('widget auth', () => {
  it('needs the x-widget-id header', async () => {
    const res = await call(CONFIG);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(unauthorized('Missing x-widget-id header'));

    const empty = await call(CONFIG, get(''));
    expect(empty.status).toBe(401);
    expect(await empty.json()).toEqual(unauthorized('Missing x-widget-id header'));
  });

  it('guards every /api route, mutations included', async () => {
    // A visitor token is no widget id: the widget is checked first.
    const token = 'not.a.token';
    for (const [path, init] of [
      ['/api/visitor', json({}, { widgetId: null })],
      ['/api/conversations', { headers: bearer(token) }],
      ['/api/conversations/identify', json({}, { widgetId: null, token })],
      ['/api/conversations', json({ body: 'hi' }, { widgetId: null, token })],
      ['/api/conversations/dconv_x', undefined],
      ['/api/conversations/dconv_x/messages', json({ body: 'hi' }, { widgetId: null, token })],
      ['/api/conversations/dconv_x/rating', json({ rating: 5 }, { widgetId: null, token })],
      ['/api/realtime/token', json({ conversationId: 'dconv_x' }, { widgetId: null, token })],
      ['/api/attachments/upload', { method: 'POST', headers: bearer(token) }],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await call(path, init);
      expect(res.status, path).toBe(401);
      expect(await res.json(), path).toEqual(unauthorized('Missing x-widget-id header'));
    }
  });

  it.each([
    ['a widget id the registry does not know', 'wdg_unknown', 401, unauthorized('Invalid widget ID')],
    ['an inactive registry row', 'wdg_inactive', 401, unauthorized('Widget is inactive')],
    ['a widget whose workspace row is gone', 'wdg_gone', 401, unauthorized('Workspace configuration not found')],
    ['a widget whose workspace has no Clerk org', 'wdg_noorg', 401, unauthorized('Workspace configuration not found')],
    ['a widget without a settings row', 'wdg_nosettings', 401, unauthorized('Widget configuration not found')],
    ['a widget switched off, with 403', 'wdg_disabled', 403, forbidden('Widget is disabled')],
  ])('refuses %s', async (_what, widgetId, status, body) => {
    const res = await call(CONFIG, get(widgetId));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });

  it('serves an enabled widget with no allowlist from any origin, or none', async () => {
    for (const widgetId of [WIDGET, 'wdg_open']) {
      for (const headers of [{}, { Origin: 'https://anywhere.example' }] as Array<Record<string, string>>) {
        const res = await call(CONFIG, get(widgetId, headers));
        expect(res.status, `${widgetId} ${JSON.stringify(headers)}`).toBe(200);
        expect(((await res.json()) as { data: { widgetId: string } }).data.widgetId).toBe(widgetId);
      }
    }
  });
});

describe('widget auth: allowed domains', () => {
  const status = async (widgetId: string, origin?: string) =>
    (await call(CONFIG, get(widgetId, origin === undefined ? {} : { Origin: origin }))).status;

  it('refuses a request without an Origin once an allowlist is set, an empty one included', async () => {
    for (const headers of [{}, { Origin: '' }] as Array<Record<string, string>>) {
      const res = await call(CONFIG, get('wdg_domain', headers));
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(await res.json(), JSON.stringify(headers)).toEqual(forbidden('Origin header required'));
    }
  });

  it('refuses an origin outside the allowlist', async () => {
    const res = await call(CONFIG, get('wdg_domain', { Origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(forbidden('Origin not allowed'));
  });

  it('allows the domain itself, its subdomains, any port and any scheme', async () => {
    for (const origin of [
      'https://example.com',
      'http://example.com',
      'https://example.com:3000',
      'https://app.example.com',
      'https://a.b.example.com',
      'HTTPS://EXAMPLE.COM',
    ]) {
      expect(await status('wdg_domain', origin), origin).toBe(200);
    }
  });

  it('does not match a domain that only ends in, or starts with, an allowed one', async () => {
    for (const origin of [
      'https://notexample.com',
      'https://example.com.evil.example',
      'https://example.org',
      'https://evil.example/example.com',
      'null',
      'not a url',
    ]) {
      expect(await status('wdg_domain', origin), origin).toBe(403);
    }
  });

  it('reads entries written with a scheme, port, path, wildcard, capitals, spaces or a leading dot', async () => {
    for (const origin of [
      'https://acme.com',
      'https://acme.com:1234',
      'https://www.acme.com',
      'https://wild.test',
      'https://a.b.wild.test',
      'https://spaced.test',
      'https://dotted.test',
      'https://stars.test',
      'http://localhost:5173',
    ]) {
      expect(await status('wdg_hand', origin), origin).toBe(200);
    }
    for (const origin of [
      'https://acme.com.evil.example',
      'https://notacme.com',
      'https://wild.test.evil.example',
      'https://other.test',
    ]) {
      expect(await status('wdg_hand', origin), origin).toBe(403);
    }
  });

  it('never matches an empty entry: the list is set, so every origin is refused', async () => {
    expect(await status('wdg_blank', 'https://anything.example')).toBe(403);
    const res = await call(CONFIG, get('wdg_blank'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(forbidden('Origin header required'));
  });

  it('applies to every /api route, not just the config', async () => {
    const evil = { Origin: 'https://evil.example' };
    const refused = await call('/api/visitor', json({}, { widgetId: 'wdg_domain', headers: evil }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(forbidden('Origin not allowed'));

    const { visitorToken } = await startSession(
      (path, init) => call(path, { ...init, headers: { ...(init?.headers as Record<string, string>), Origin: 'https://example.com' } }),
      {},
      'wdg_domain',
    );
    const res = await call('/api/conversations', get('wdg_domain', { ...evil, ...bearer(visitorToken) }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(forbidden('Origin not allowed'));

    const ok = await call('/api/conversations', get('wdg_domain', { Origin: 'https://example.com', ...bearer(visitorToken) }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ success: true, data: [] });
  });
});
