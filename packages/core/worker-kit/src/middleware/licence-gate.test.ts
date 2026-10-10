/**
 * licenceGate: a licensed workspace reaches only the modules its apps read;
 * core paths and unlicensed (null) workspaces always pass. Also checks that
 * every app code `@weldsuite/api-modules` declares is a real permission app,
 * so a typo cannot silently lock a module away from its own app.
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { API_MODULES } from '@weldsuite/api-modules';
import { PERMISSION_APPS } from '@weldsuite/permissions';
import { licenceGate } from './licence-gate';

function buildApp(licensedApps: readonly string[] | null | undefined) {
  const app = new Hono<{ Variables: { licensedApps?: readonly string[] | null } }>();
  app.use('*', async (c, next) => {
    if (licensedApps !== undefined) c.set('licensedApps', licensedApps);
    await next();
  });
  app.use('*', licenceGate());
  app.all('*', (c) => c.json({ ok: true }));
  return app;
}

describe('licenceGate', () => {
  it('passes every path when the workspace has no licence', async () => {
    for (const licence of [null, undefined]) {
      const res = await buildApp(licence).request('/api/invoices');
      expect(res.status).toBe(200);
    }
  });

  it('passes licensed modules, shared objects and core paths', async () => {
    const app = buildApp(['welddesk']);
    for (const path of ['/api/tickets/t_1', '/api/companies', '/api/team-members', '/api/ai/chat']) {
      expect((await app.request(path)).status, path).toBe(200);
    }
  });

  it('rejects an unlicensed module with APP_NOT_LICENSED naming its app', async () => {
    const res = await buildApp(['welddesk']).request('/api/invoices/inv_1', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'APP_NOT_LICENSED',
        message: 'This workspace is not licensed for weldbooks.',
        details: { app: 'weldbooks' },
      },
    });
  });

  it('treats an empty licence as core-only', async () => {
    const app = buildApp([]);
    expect((await app.request('/api/settings/profile')).status).toBe(200);
    expect((await app.request('/api/tickets')).status).toBe(403);
  });
});

describe('api-modules app codes', () => {
  const permissionApps = new Set(PERMISSION_APPS.map((a) => a.code));

  it('only names apps that exist in PERMISSION_APPS', () => {
    for (const m of API_MODULES) {
      for (const code of m.apps ?? []) expect(permissionApps.has(code), `${m.id}: ${code}`).toBe(true);
    }
  });

  it('opens at least one module for every app except WeldDrive (core files)', () => {
    const opened = new Set(API_MODULES.flatMap((m) => m.apps ?? []));
    const unopened = [...permissionApps].filter((code) => !opened.has(code));
    expect(unopened).toEqual(['welddrive']);
  });
});
