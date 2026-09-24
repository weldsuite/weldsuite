/**
 * GET /roles/permission-catalog — the per-app shape the role editor uses.
 *
 * Besides the flat `objects` list, the response carries `apps` (each app with
 * the objects it exposes, keyed `<app>:<object>:<action>`) and `workspace`
 * (app-less objects with plain keys).
 */

import { describe, it, expect, vi } from 'vitest';
import { rolesRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';

vi.mock('../../services/custom-objects', () => ({
  listCustomObjects: vi.fn(async () => [{ slug: 'machine', labelPlural: 'Machines' }]),
}));

interface CatalogPermission {
  code: string;
  action: string;
}
interface CatalogObject {
  object: string;
  permissions: CatalogPermission[];
}
interface CatalogResponse {
  data: {
    objects: CatalogObject[];
    customObjects: CatalogObject[];
    apps: { app: string; appName: string; objects: CatalogObject[] }[];
    workspace: CatalogObject[];
  };
}

async function fetchCatalog(perms = permissions('roles:read')) {
  const t = createTestApp('/api/roles', rolesRoutes, { context: { permissions: perms } });
  return t.request('/api/roles/permission-catalog');
}

describe('GET /roles/permission-catalog', () => {
  it('returns each app with app-qualified keys and plain actions', async () => {
    const res = await fetchCatalog();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as CatalogResponse;

    const crm = data.apps.find((a) => a.app === 'weldcrm');
    expect(crm?.appName).toBe('WeldCRM');
    const companies = crm?.objects.find((o) => o.object === 'companies');
    const read = companies?.permissions.find((p) => p.code === 'weldcrm:companies:read');
    expect(read?.action).toBe('read');
    const scopeAll = companies?.permissions.find((p) => p.code === 'weldcrm:companies:scope:all');
    expect(scopeAll?.action).toBe('scope:all');
  });

  it('returns workspace objects with plain keys, and no app-scoped object there', async () => {
    const { data } = (await (await fetchCatalog()).json()) as CatalogResponse;
    expect(data.workspace.find((o) => o.object === 'team')?.permissions[0]?.code).toBe('team:read');
    expect(data.workspace.some((o) => o.object === 'companies')).toBe(false);
  });

  it('keeps the flat catalog and custom objects for existing consumers', async () => {
    const { data } = (await (await fetchCatalog()).json()) as CatalogResponse;
    expect(data.objects.some((o) => o.object === 'companies')).toBe(true);
    expect(data.customObjects.length).toBeGreaterThan(0);
  });

  it('requires roles:read', async () => {
    const res = await fetchCatalog(permissions('team:read'));
    expect(res.status).toBe(403);
  });
});
