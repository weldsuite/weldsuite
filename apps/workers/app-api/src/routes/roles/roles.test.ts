/**
 * /api/roles against a real pglite tenant DB: the name rules (system names
 * reserved, no duplicates, on create and rename), member counts by role id,
 * and the level order of the system roles.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { rolesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

interface RoleBody {
  id: string;
  name: string;
  isSystemRole: boolean;
  memberCount: number;
}

const ALL = permissions('roles:read', 'roles:create', 'roles:update', 'roles:delete');

function api() {
  return createTestApp('/api/roles', rolesRoutes, { context: { tenantDb: db, permissions: ALL } });
}

async function listRoles(): Promise<RoleBody[]> {
  const res = await api().request('/api/roles');
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: RoleBody[] }).data;
}

async function createRole(name: string) {
  return api().request('/api/roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

async function renameRole(id: string, name: string) {
  return api().request(`/api/roles/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

let seq = 0;
async function addMember(role: string, roleId: string | null = null) {
  const now = new Date();
  seq += 1;
  await db.insert(schema.workspaceMembers).values({
    id: `wm_roles_${seq}`,
    userId: `user_roles_${seq}`,
    email: `member${seq}@example.com`,
    role,
    roleId,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  } as typeof schema.workspaceMembers.$inferInsert);
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await listRoles(); // seeds the four system roles
  await addMember('OWNER');
  await addMember('MEMBER');
  await addMember('MEMBER');
}, 60_000);

describe('GET /api/roles', () => {
  it('orders system roles by level, then custom roles alphabetically', async () => {
    const created = await createRole('Zeta team');
    expect(created.status).toBe(201);
    expect((await createRole('Alpha team')).status).toBe(201);

    const names = (await listRoles()).map((r) => r.name);
    expect(names.slice(0, 4)).toEqual(['Owner', 'Admin', 'Member', 'Viewer']);
    expect(names.indexOf('Alpha team')).toBeLessThan(names.indexOf('Zeta team'));
    expect(names.indexOf('Alpha team')).toBeGreaterThan(3);
  });

  it('counts members by role id, never by a matching name', async () => {
    const res = await createRole('Support');
    const support = ((await res.json()) as { data: RoleBody }).data;
    expect(support.memberCount).toBe(0);

    // A custom-role member keeps a MEMBER tier; it counts for the custom role only.
    await addMember('MEMBER', support.id);

    const roles = await listRoles();
    const byName = (n: string) => roles.find((r) => r.name === n);
    expect(byName('Owner')?.memberCount).toBe(1);
    expect(byName('Member')?.memberCount).toBe(2);
    expect(byName('Support')?.memberCount).toBe(1);
    expect(byName('Viewer')?.memberCount).toBe(0);

    // The detail endpoint agrees with the list.
    const detail = await api().request(`/api/roles/${support.id}`);
    expect(((await detail.json()) as { data: RoleBody }).data.memberCount).toBe(1);
    const memberRole = byName('Member')!;
    const memberDetail = await api().request(`/api/roles/${memberRole.id}`);
    expect(((await memberDetail.json()) as { data: RoleBody }).data.memberCount).toBe(2);
  });
});

describe('role names', () => {
  it.each(['Owner', 'admin', '  MEMBER ', 'Viewer'])('rejects the system name %j on create', async (name) => {
    const res = await createRole(name);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe('reserved');
  });

  it('rejects a duplicate name on create, trimmed and case-insensitive', async () => {
    expect((await createRole('Sales')).status).toBe(201);
    const res = await createRole('  sales ');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details: { reason: string } } };
    expect(body.error.details.reason).toBe('duplicate');
  });

  it('stores the trimmed name', async () => {
    const res = await createRole('  Finance  ');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: RoleBody }).data.name).toBe('Finance');
  });

  it('rejects a whitespace-only name', async () => {
    expect((await createRole('   ')).status).toBe(400);
  });

  it('rejects reserved and duplicate names on rename, but allows keeping its own name', async () => {
    const res = await createRole('Marketing');
    const marketing = ((await res.json()) as { data: RoleBody }).data;

    expect((await renameRole(marketing.id, 'Owner')).status).toBe(400);
    expect((await renameRole(marketing.id, 'SALES')).status).toBe(409);
    expect((await renameRole(marketing.id, 'marketing')).status).toBe(200);
    expect((await renameRole(marketing.id, 'Growth')).status).toBe(200);
  });

  it('frees a deleted role name for reuse', async () => {
    const res = await createRole('Temp');
    const temp = ((await res.json()) as { data: RoleBody }).data;
    const del = await api().request(`/api/roles/${temp.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect((await createRole('Temp')).status).toBe(201);
  });

  it('never lists two Owner rows', async () => {
    const owners = (await listRoles()).filter((r) => r.name.toLowerCase() === 'owner');
    expect(owners).toHaveLength(1);
  });
});
