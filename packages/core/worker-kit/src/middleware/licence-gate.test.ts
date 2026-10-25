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
  readOnlyReason?: 'partner_suspended' | 'licence_inactive' | 'database_move' | null;
};

function buildApp(
  licensedApps: readonly string[] | null | undefined,
  readOnly?: { reason: 'partner_suspended' | 'licence_inactive' | 'database_move' },
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

  it("opens a record's chat to the record's app, and only that record type's", async () => {
    // A CRM-only workspace: company and person chats (crm-api forwards them
    // to chat-api) pass; another type's chat and the WeldChat lists do not.
    const crmOnly = buildApp(['weldcrm']);
    for (const path of ['/api/chat-entity-channels/company/cmp_1/messages', '/api/chat-entity-channels/person/per_1/channel']) {
      expect((await crmOnly.request(path, { method: 'POST' })).status, path).toBe(200);
    }
    for (const path of ['/api/chat-entity-channels/domain/dom_1/channel', '/api/chat-entity-channels/summary', '/api/chat-entity-channels?type=company', '/api/channels']) {
      expect((await crmOnly.request(path)).status, path).toBe(403);
    }
    const hostOnly = buildApp(['weldhost']);
    expect((await hostOnly.request('/api/chat-entity-channels/domain/dom_1/channel')).status).toBe(200);
    expect((await hostOnly.request('/api/chat-entity-channels/company/cmp_1/channel')).status).toBe(403);
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

  it('refuses a POST on a path containing "export"', async () => {
    const res = await readOnlyApp().request('/api/tickets/export', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'WORKSPACE_READ_ONLY' } });
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

describe('licenceGate · workspace database being moved', () => {
  const movingApp = (licensedApps: readonly string[] | null = null) =>
    buildApp(licensedApps, { reason: 'database_move' });

  it('refuses every write with 503 WORKSPACE_MOVING and Retry-After', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await movingApp().request('/api/tickets/t_1', { method });
      expect(res.status, method).toBe(503);
      expect(res.headers.get('Retry-After'), method).toBe('30');
      expect(await res.json()).toEqual({
        error: {
          code: 'WORKSPACE_MOVING',
          message: 'This workspace is being moved to a new database. Try again in a minute.',
        },
      });
    }
  });

  it('still serves reads', async () => {
    const app = movingApp();
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await app.request('/api/tickets', { method });
      expect(res.status, method).toBe(200);
      expect(res.headers.get('Retry-After'), method).toBeNull();
    }
  });

  it('lets the same exceptions through as the licence read-only mode: search and the user-level paths', async () => {
    const app = movingApp();
    for (const [method, path] of [
      ['POST', '/api/search'],
      ['POST', '/api/search/global'],
      ['PATCH', '/api/me'],
      ['PUT', '/api/user-preferences'],
      ['PUT', '/api/notification-preferences'],
      ['POST', '/api/push-tokens'],
    ]) {
      const res = await app.request(path!, { method });
      expect(res.status, `${method} ${path}`).toBe(200);
    }
  });

  it('refuses a write on a path that only looks like an exception (segment boundary, "export")', async () => {
    const app = movingApp();
    for (const [method, path] of [
      ['POST', '/api/members'],
      ['POST', '/api/search-index'],
      ['POST', '/api/tickets/export'],
    ]) {
      const res = await app.request(path!, { method });
      expect(res.status, `${method} ${path}`).toBe(503);
    }
  });

  it('answers a move and a licence read-only the same way on the exceptions, and differently elsewhere', async () => {
    const licenceReadOnly = buildApp(null, { reason: 'partner_suspended' });
    const moving = movingApp();
    expect((await licenceReadOnly.request('/api/search', { method: 'POST' })).status).toBe(200);
    expect((await moving.request('/api/search', { method: 'POST' })).status).toBe(200);
    expect((await licenceReadOnly.request('/api/tickets', { method: 'POST' })).status).toBe(403);
    expect((await moving.request('/api/tickets', { method: 'POST' })).status).toBe(503);
  });

  it('applies to an unlicensed (null) and a licensed workspace alike', async () => {
    for (const licensedApps of [null, ['welddesk']]) {
      const res = await movingApp(licensedApps).request('/api/tickets', { method: 'POST' });
      expect(res.status).toBe(503);
    }
  });

  it('checks the app licence first, which a retry would not change', async () => {
    const res = await movingApp(['welddesk']).request('/api/invoices', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'APP_NOT_LICENSED' } });
  });

  it('leaves the licence read-only answer (403 WORKSPACE_READ_ONLY, no Retry-After) alone', async () => {
    const res = await buildApp(['welddesk'], { reason: 'partner_suspended' }).request('/api/tickets', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(res.headers.get('Retry-After')).toBeNull();
    expect(await res.json()).toMatchObject({ error: { code: 'WORKSPACE_READ_ONLY' } });
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
