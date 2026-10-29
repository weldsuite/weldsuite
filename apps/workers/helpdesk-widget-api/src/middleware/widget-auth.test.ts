/**
 * widget-auth: the per-widget allowed-domains policy.
 *
 * The widget iframe calls this API cross-origin, and a browser always sends
 * `Origin` on a cross-origin CORS fetch (GET included). So when a workspace has
 * configured an allowlist, a request without `Origin` is a non-browser client and
 * must be refused rather than waved through.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../index';
import { widgetAuthMiddleware } from './widget-auth';

const tables = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
}));

vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));

vi.mock('../db', () => {
  const selectFrom = (table: { __t: string }) => ({
    where: () => ({ limit: () => Promise.resolve(tables.rows[table.__t] ?? []) }),
  });
  return {
    getMasterDb: () => ({ select: () => ({ from: selectFrom }) }),
    getTenantDbForWorkspace: () => Promise.resolve({ select: () => ({ from: selectFrom }) }),
    masterSchema: {
      widgetRegistry: { __t: 'registry', widgetId: 'widgetId', workspaceId: 'workspaceId', isActive: 'isActive' },
      workspaces: { __t: 'workspaces', id: 'id', clerkOrgId: 'clerkOrgId', planId: 'planId' },
      plans: { __t: 'plans', id: 'id', removeBranding: 'removeBranding' },
    },
    schema: {
      deskWidgetSettings: { __t: 'settings', widgetId: 'widgetId' },
    },
  };
});

const WIDGET_ID = 'wdg_test';

function seed(settings: Record<string, unknown>) {
  tables.rows = {
    registry: [{ workspaceId: 'ws_internal', isActive: true }],
    workspaces: [{ clerkOrgId: 'org_clerk', planId: null }],
    plans: [],
    settings: [{ widgetId: WIDGET_ID, enabled: true, allowedDomains: [], ...settings }],
  };
}

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('/api/*', widgetAuthMiddleware());
  app.get('/api/ping', (c) => c.json({ ok: true, workspaceId: c.get('workspaceId'), clerkOrgId: c.get('clerkOrgId') }));
  app.post('/api/ping', (c) => c.json({ ok: true }));
  return app;
}

async function call(headers: Record<string, string>, method: 'GET' | 'POST' = 'GET') {
  const res = await buildApp().request('/api/ping', { method, headers }, {} as Env);
  const body = (await res.json()) as {
    ok?: boolean;
    workspaceId?: string;
    clerkOrgId?: string;
    error?: { code: string; message: string };
  };
  return { status: res.status, body };
}

const withWidget = (extra: Record<string, string> = {}) => ({ 'x-widget-id': WIDGET_ID, ...extra });

beforeEach(() => {
  seed({});
});

describe('widgetAuthMiddleware · identification', () => {
  it('rejects a request without x-widget-id', async () => {
    const { status, body } = await call({});
    expect(status).toBe(401);
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects an unknown widget', async () => {
    tables.rows.registry = [];
    const { status } = await call(withWidget());
    expect(status).toBe(401);
  });

  it('rejects a disabled widget', async () => {
    seed({ enabled: false });
    const { status, body } = await call(withWidget());
    expect(status).toBe(403);
    expect(body.error?.message).toBe('Widget is disabled');
  });

  it('exposes the workspace to the route on success', async () => {
    const { status, body } = await call(withWidget());
    expect(status).toBe(200);
    expect(body.workspaceId).toBe('ws_internal');
    expect(body.clerkOrgId).toBe('org_clerk');
  });
});

describe('widgetAuthMiddleware · no allowlist configured', () => {
  it('lets a request without Origin through (empty allowlist)', async () => {
    seed({ allowedDomains: [] });
    expect((await call(withWidget())).status).toBe(200);
  });

  it('lets a request without Origin through (allowlist never set)', async () => {
    seed({ allowedDomains: null });
    expect((await call(withWidget())).status).toBe(200);
  });

  it('lets any Origin through when nothing is configured', async () => {
    seed({ allowedDomains: [] });
    expect((await call(withWidget({ Origin: 'https://anything.example' }))).status).toBe(200);
  });
});

describe('widgetAuthMiddleware · allowlist configured', () => {
  beforeEach(() => {
    seed({ allowedDomains: ['example.com'] });
  });

  it('refuses a request without Origin (non-browser client)', async () => {
    const get = await call(withWidget());
    expect(get.status).toBe(403);
    expect(get.body.error?.code).toBe('FORBIDDEN');
    expect(get.body.error?.message).toBe('Origin header required');

    const post = await call(withWidget(), 'POST');
    expect(post.status).toBe(403);
  });

  it('allows the exact domain', async () => {
    expect((await call(withWidget({ Origin: 'https://example.com' }))).status).toBe(200);
  });

  it('allows a subdomain, any scheme and any port', async () => {
    expect((await call(withWidget({ Origin: 'https://help.example.com' }))).status).toBe(200);
    expect((await call(withWidget({ Origin: 'http://example.com:8080' }))).status).toBe(200);
  });

  it('refuses another site', async () => {
    const { status, body } = await call(withWidget({ Origin: 'https://evil.test' }));
    expect(status).toBe(403);
    expect(body.error?.message).toBe('Origin not allowed');
  });

  it('refuses look-alike hosts', async () => {
    for (const origin of [
      'https://example.com.evil.test',
      'https://evilexample.com',
      'https://example.com.evil.test:443',
      'https://evil.test#.example.com',
      'https://evil.test/.example.com',
    ]) {
      expect((await call(withWidget({ Origin: origin }))).status, origin).toBe(403);
    }
  });

  it('refuses an opaque origin', async () => {
    expect((await call(withWidget({ Origin: 'null' }))).status).toBe(403);
  });

  it('refuses an empty Origin header', async () => {
    expect((await call(withWidget({ Origin: '' }))).status).toBe(403);
  });
});

describe('widgetAuthMiddleware · allowlist entry formats', () => {
  it('matches case-insensitively', async () => {
    seed({ allowedDomains: ['Example.COM'] });
    expect((await call(withWidget({ Origin: 'https://EXAMPLE.com' }))).status).toBe(200);
  });

  it('accepts entries written with a scheme, a wildcard or a path', async () => {
    seed({ allowedDomains: ['https://shop.example.org/', '*.docs.example.net'] });
    expect((await call(withWidget({ Origin: 'https://shop.example.org' }))).status).toBe(200);
    expect((await call(withWidget({ Origin: 'https://a.docs.example.net' }))).status).toBe(200);
    expect((await call(withWidget({ Origin: 'https://example.net' }))).status).toBe(403);
  });

  it('never lets a blank entry match', async () => {
    seed({ allowedDomains: ['', '  '] });
    expect((await call(withWidget({ Origin: 'https://example.com' }))).status).toBe(403);
    expect((await call(withWidget())).status).toBe(403);
  });

  it('checks every entry', async () => {
    seed({ allowedDomains: ['a.test', 'b.test'] });
    expect((await call(withWidget({ Origin: 'https://b.test' }))).status).toBe(200);
  });
});
