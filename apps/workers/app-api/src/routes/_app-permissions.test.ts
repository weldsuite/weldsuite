/**
 * Per-app permissions — the `app:object:action` model.
 *
 * Covers the pure check (`checkAppPermission`), the registry's integrity, and
 * the end-to-end path a request takes: `X-Weld-App` header →
 * appContextMiddleware → requirePermission / hasContextPermission, in both
 * log-only and enforced mode.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  PERMISSION_APPS,
  PERMISSION_CATALOG_OBJECTS,
  SYSTEM_ROLES,
  buildAppPermissionCatalog,
  checkAppPermission,
  getAllPermissionKeys,
  hasPermission,
  toAppScopedKeys,
  getAppsForObject,
  isAppCode,
  isAppScopedObject,
  normalizeAppCode,
  parsePermissionKey,
  qualifyPermission,
} from '@weldsuite/permissions';
import {
  appContextMiddleware,
  hasContextPermission,
  requirePermission,
} from '@weldsuite/permissions/server';
import type { ResolvedPermissions } from '@weldsuite/permissions/types';
import { createTestApp } from '../test/harness';
import type { Env, Variables } from '../types';

function subject(permissions: string[], denies: string[] = []): ResolvedPermissions {
  return { permissions, denies, role: 'MEMBER', roleId: null, isOwner: false };
}

describe('app registry', () => {
  it('only registers objects that exist in the catalog', () => {
    const catalogKeys = new Set(PERMISSION_CATALOG_OBJECTS.map((o) => o.key));
    for (const app of PERMISSION_APPS) {
      for (const object of app.objects) {
        expect(catalogKeys.has(object), `${app.code} → ${object}`).toBe(true);
      }
    }
  });

  it('never uses an app code as an app-scoped object key', () => {
    for (const app of PERMISSION_APPS) {
      expect(isAppScopedObject(app.code), app.code).toBe(false);
    }
  });

  it('registers companies in more than one app', () => {
    expect(getAppsForObject('companies').length).toBeGreaterThan(1);
  });

  it('normalizes aliases and rejects unknown codes', () => {
    expect(normalizeAppCode('WeldCRM')).toBe('weldcrm');
    expect(normalizeAppCode('crm')).toBe('weldcrm');
    expect(normalizeAppCode('accounting')).toBe('weldbooks');
    expect(normalizeAppCode('nope')).toBeNull();
    expect(isAppCode('crm')).toBe(false);
  });

  it('builds a per-app catalog with qualified keys and plain workspace keys', () => {
    const catalog = buildAppPermissionCatalog();
    const crm = catalog.apps.find((a) => a.app === 'weldcrm');
    const companies = crm?.objects.find((o) => o.key === 'companies');
    expect(companies?.permissions.map((p) => p.key)).toContain('weldcrm:companies:read');
    expect(catalog.workspace.find((o) => o.key === 'team')?.permissions[0]?.key).toBe('team:read');
    expect(catalog.workspace.some((o) => o.key === 'companies')).toBe(false);
  });
});

describe('parsePermissionKey / qualifyPermission', () => {
  it('recognises app-qualified keys', () => {
    expect(parsePermissionKey('weldcrm:companies:read')).toEqual({
      app: 'weldcrm',
      object: 'companies',
      unqualified: 'companies:read',
    });
    expect(parsePermissionKey('weldcrm:companies:scope:all').unqualified).toBe('companies:scope:all');
  });

  it('treats plain and app-named workspace keys as unqualified', () => {
    expect(parsePermissionKey('companies:read').app).toBeNull();
    expect(parsePermissionKey('weldagent:use').app).toBeNull();
    expect(parsePermissionKey('team:read').app).toBeNull();
  });

  it('qualifies app-scoped keys only', () => {
    expect(qualifyPermission('companies:read', 'welddesk')).toBe('welddesk:companies:read');
    expect(qualifyPermission('weldcrm:companies:read', 'welddesk')).toBe('weldcrm:companies:read');
    expect(qualifyPermission('team:read', 'weldcrm')).toBe('team:read');
  });
});

describe('checkAppPermission', () => {
  it('lets a legacy unqualified grant through in every app (pre-migration)', () => {
    const s = subject(['companies:read']);
    expect(checkAppPermission(s, 'companies:read', 'weldcrm').allowed).toBe(true);
    expect(checkAppPermission(s, 'companies:read', 'welddesk').allowed).toBe(true);
    expect(checkAppPermission(s, 'companies:read', null).allowed).toBe(true);
  });

  it('scopes a qualified grant to its app', () => {
    const s = subject(['weldcrm:companies:read']);
    expect(checkAppPermission(s, 'companies:read', 'weldcrm')).toMatchObject({ allowed: true, mode: 'app', app: 'weldcrm' });
    expect(checkAppPermission(s, 'companies:read', 'welddesk')).toMatchObject({ allowed: false, mode: 'app', app: 'welddesk' });
    // No app context: allowed because some app grants it.
    expect(checkAppPermission(s, 'companies:read', null)).toMatchObject({ allowed: true, mode: 'any-app' });
  });

  it('accepts app wildcards and aliases', () => {
    const s = subject(['weldcrm:*']);
    expect(checkAppPermission(s, 'companies:scope:all', 'crm').allowed).toBe(true);
    expect(checkAppPermission(s, 'companies:scope:all', 'welddesk').allowed).toBe(false);
  });

  it('lets a qualified deny win over an unqualified grant in that app only', () => {
    const s = subject(['companies:read'], ['welddesk:companies:read']);
    expect(checkAppPermission(s, 'companies:read', 'weldcrm').allowed).toBe(true);
    expect(checkAppPermission(s, 'companies:read', 'welddesk').allowed).toBe(false);
    expect(checkAppPermission(s, 'companies:read', null).allowed).toBe(true);
  });

  it('lets an unqualified deny win in every app', () => {
    const s = subject(['weldcrm:companies:*', 'companies:read'], ['companies:read']);
    expect(checkAppPermission(s, 'companies:read', 'weldcrm').allowed).toBe(false);
    expect(checkAppPermission(s, 'companies:read', null).allowed).toBe(false);
    expect(checkAppPermission(s, 'companies:update', 'weldcrm').allowed).toBe(true);
  });

  it('checks workspace-level keys as written, honouring denies', () => {
    expect(checkAppPermission(subject(['team:read']), 'team:read', 'weldcrm')).toMatchObject({ allowed: true, mode: 'workspace' });
    expect(checkAppPermission(subject(['team:*'], ['team:delete']), 'team:delete', null).allowed).toBe(false);
  });

  it('falls back to any-app when the object is not part of the app', () => {
    const check = checkAppPermission(subject(['weldcrm:companies:read']), 'companies:read', 'weldhost');
    expect(check).toMatchObject({ allowed: true, mode: 'any-app', objectNotInApp: true });
  });

  it('grants the owner wildcard everywhere', () => {
    expect(checkAppPermission(subject(['*']), 'companies:delete', 'welddesk').allowed).toBe(true);
  });
});

describe('request app context', () => {
  function build(perms: ResolvedPermissions, env: Partial<Env> = {}) {
    const router = new Hono<{ Bindings: Env; Variables: Variables }>();
    router.use('*', appContextMiddleware());
    router.get('/companies', requirePermission('companies:read'), (c) => c.json({ app: c.get('app') ?? null }));
    router.get('/scope', async (c) => c.json({ all: await hasContextPermission(c, 'companies:scope:all') }));
    return createTestApp('/api', router, { context: { permissions: perms }, env });
  }

  const crmOnly = subject(['weldcrm:companies:read', 'weldcrm:companies:scope:all']);

  it('sets the canonical app from X-Weld-App', async () => {
    const res = await build(crmOnly).request('/api/companies', { headers: { 'X-Weld-App': 'crm' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ app: 'weldcrm' });
  });

  it('ignores an unknown app header (no app context)', async () => {
    const res = await build(crmOnly).request('/api/companies', { headers: { 'X-Weld-App': 'bogus' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ app: null });
  });

  it('only logs a per-app refusal in log mode', async () => {
    const res = await build(crmOnly).request('/api/companies', { headers: { 'X-Weld-App': 'welddesk' } });
    expect(res.status).toBe(200);
  });

  it('refuses in the other app when enforced', async () => {
    const t = build(crmOnly, { PERMISSIONS_APP_ENFORCE: 'true' });
    expect((await t.request('/api/companies', { headers: { 'X-Weld-App': 'welddesk' } })).status).toBe(403);
    expect((await t.request('/api/companies', { headers: { 'X-Weld-App': 'weldcrm' } })).status).toBe(200);
    expect((await t.request('/api/companies')).status).toBe(200);
  });

  it('refuses when no app grants the key, whatever the mode', async () => {
    const res = await build(subject(['weldcrm:people:read'])).request('/api/companies', { headers: { 'X-Weld-App': 'weldcrm' } });
    expect(res.status).toBe(403);
  });

  it('applies app context to in-handler checks (scope:all)', async () => {
    const t = build(crmOnly, { PERMISSIONS_APP_ENFORCE: 'true' });
    const inCrm = await t.request('/api/scope', { headers: { 'X-Weld-App': 'weldcrm' } });
    const inBooks = await t.request('/api/scope', { headers: { 'X-Weld-App': 'welddesk' } });
    expect(await inCrm.json()).toEqual({ all: true });
    expect(await inBooks.json()).toEqual({ all: false });
  });

  it('applies member denies in route checks', async () => {
    const t = build(subject(['companies:read'], ['welddesk:companies:read']), { PERMISSIONS_APP_ENFORCE: 'true' });
    expect((await t.request('/api/companies', { headers: { 'X-Weld-App': 'welddesk' } })).status).toBe(403);
    expect((await t.request('/api/companies', { headers: { 'X-Weld-App': 'weldcrm' } })).status).toBe(200);
  });
});

describe('toAppScopedKeys (data migration)', () => {
  it('expands app-scoped grants into one grant per app', () => {
    const out = toAppScopedKeys(['companies:read', 'team:read', '*']);
    for (const app of getAppsForObject('companies')) expect(out).toContain(`${app}:companies:read`);
    expect(out).not.toContain('companies:read');
    expect(out).toContain('team:read');
    expect(out).toContain('*');
  });

  it('keeps qualified keys, normalizes aliases, collapses old settings keys', () => {
    expect(toAppScopedKeys(['weldcrm:companies:*'])).toEqual(['weldcrm:companies:*']);
    expect(toAppScopedKeys(['weldparcel:orders:read'])).toEqual(['weldstash:orders:read']);
    expect(toAppScopedKeys(['settings:team:read'])).toEqual(['team:read']);
  });

  it('gives every app its own copy of a cross-object wildcard', () => {
    const out = toAppScopedKeys(['*:read']);
    expect(out).toContain('*:read');
    expect(out).toContain('weldbooks:*:read');
  });

  it('is idempotent', () => {
    const once = toAppScopedKeys(SYSTEM_ROLES.MEMBER!.permissions);
    expect(toAppScopedKeys(once)).toEqual(once);
  });

  it('grants exactly what the unqualified set granted, per app, for every system role', () => {
    for (const roleName of ['ADMIN', 'MEMBER', 'VIEWER'] as const) {
      const before = SYSTEM_ROLES[roleName]!.permissions;
      const after = toAppScopedKeys(before);
      for (const key of getAllPermissionKeys()) {
        const { object } = parsePermissionKey(key);
        const apps = getAppsForObject(object);
        if (apps.length === 0) {
          expect(hasPermission(after, key), `${roleName} ${key}`).toBe(hasPermission(before, key));
          continue;
        }
        for (const app of apps) {
          expect(hasPermission(after, `${app}:${key}`), `${roleName} ${app}:${key}`).toBe(hasPermission(before, key));
        }
      }
    }
  });
});
