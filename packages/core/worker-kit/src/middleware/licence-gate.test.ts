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

type GateVariables = {
  licensedApps?: readonly string[] | null;
  readOnly?: boolean;
  readOnlyReason?: 'partner_suspended' | 'licence_inactive' | null;
};

function buildApp(
  licensedApps: readonly string[] | null | undefined,
  readOnly?: { reason: 'partner_suspended' | 'licence_inactive' },
) {
  const app = new Hono<{ Variables: GateVariables }>();
  app.use('*', async (c, next) => {
    if (licensedApps !== undefined) c.set('licensedApps', licensedApps);
    if (readOnly) {
      c.set('readOnly', true);
      c.set('readOnlyReason', readOnly.reason);
    }
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

describe('licenceGate · read-only workspaces', () => {
  const readOnlyApp = (reason: 'partner_suspended' | 'licence_inactive' = 'partner_suspended') =>
    buildApp(['welddesk'], { reason });

  it('refuses writes with 403 WORKSPACE_READ_ONLY and the reason', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await readOnlyApp().request('/api/tickets/t_1', { method });
      expect(res.status, method).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: 'WORKSPACE_READ_ONLY', details: { reason: 'partner_suspended' } },
      });
    }
    const res = await readOnlyApp('licence_inactive').request('/api/tickets', { method: 'POST' });
    expect(await res.json()).toMatchObject({ error: { details: { reason: 'licence_inactive' } } });
  });

  it('still serves reads', async () => {
    const app = readOnlyApp();
    for (const method of ['GET', 'HEAD']) {
      expect((await app.request('/api/tickets', { method })).status, method).toBe(200);
    }
  });

  it('lets the read-style POSTs and user-level paths through', async () => {
    const app = buildApp(null, { reason: 'partner_suspended' });
    for (const [method, path] of [
      ['POST', '/api/search'],
      ['POST', '/api/tickets/export'],
      ['PATCH', '/api/me'],
      ['PUT', '/api/user-preferences'],
      ['PUT', '/api/notification-preferences'],
      ['POST', '/api/push-tokens'],
    ]) {
      expect((await app.request(path!, { method })).status, `${method} ${path}`).toBe(200);
    }
  });

  it('checks the app licence first', async () => {
    const res = await readOnlyApp().request('/api/invoices', { method: 'POST' });
    expect(await res.json()).toMatchObject({ error: { code: 'APP_NOT_LICENSED' } });
  });

  it('does not touch writable workspaces', async () => {
    const res = await buildApp(['welddesk']).request('/api/tickets', { method: 'POST' });
    expect(res.status).toBe(200);
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
