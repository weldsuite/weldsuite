/**
 * DB-backed tests for per-member permission overrides (per-app permissions).
 *
 *   - PATCH /:id with `permissions` + `permissionDenies` stores both lists.
 *   - GET /:id/permissions returns them, plus `inheritedPermissions`: the
 *     custom role's grants, or the system tier's defaults for a bare tier.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { SYSTEM_ROLES } from '@weldsuite/permissions';
import { teamMembersRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  const now = new Date();
  await db.insert(schema.roles).values({
    id: 'role_sales',
    name: 'Sales',
    permissions: ['weldcrm:companies:read'],
    createdAt: now,
    updatedAt: now,
  } as typeof schema.roles.$inferInsert);
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_custom', userId: 'user_custom', email: 'c@example.com', role: 'MEMBER', roleId: 'role_sales', createdAt: now, updatedAt: now },
    { id: 'wm_tier', userId: 'user_tier', email: 't@example.com', role: 'VIEWER', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

function app() {
  return createTestApp('/api/team-members', teamMembersRoutes, {
    context: { tenantDb: db, permissions: permissions('team:read', 'team:update') },
  });
}

describe('per-member permission overrides', () => {
  it('stores grants and denies, and reads them back with the role baseline', async () => {
    const t = app();
    const patch = await t.request('/api/team-members/wm_custom', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        permissions: ['welddesk:tickets:read'],
        permissionDenies: ['weldcrm:companies:read'],
      }),
    });
    expect(patch.status).toBe(200);

    const res = await t.request('/api/team-members/wm_custom/permissions');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, string[]> };
    expect(data.memberOverrides).toEqual(['welddesk:tickets:read']);
    expect(data.memberDenies).toEqual(['weldcrm:companies:read']);
    expect(data.inheritedPermissions).toEqual(['weldcrm:companies:read']);
    expect(data.rolePermissions).toEqual(['weldcrm:companies:read']);
  });

  it('reports the system tier defaults as the baseline for a bare tier', async () => {
    const res = await app().request('/api/team-members/wm_tier/permissions');
    const { data } = (await res.json()) as { data: Record<string, string[]> };
    expect(data.rolePermissions).toEqual([]);
    expect(data.inheritedPermissions).toEqual(SYSTEM_ROLES.VIEWER!.permissions);
    expect(data.memberDenies).toEqual([]);
  });

  it('rejects a non-array permissionDenies', async () => {
    const res = await app().request('/api/team-members/wm_tier', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permissionDenies: 'weldcrm:*' }),
    });
    expect(res.status).toBe(400);
  });
});
