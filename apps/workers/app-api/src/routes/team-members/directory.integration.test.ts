/**
 * The team directory against a real pglite tenant DB: GET /me, the list with
 * its filters, visibility projection and keyset cursor, one member, and the
 * per-member permission breakdown and app assignments (+ the toggle).
 *
 * These run in the Rust conformance suite too ("core: team-members
 * (directory)"), so nothing here is mocked that the Rust server can't see.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { teamMembersRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

// Conformance mode runs each write twice, on a copy of the database for one.
vi.setConfig({ testTimeout: 60_000 });

let db: Database;

const at = (minute: number) => new Date(Date.UTC(2026, 0, 10, 9, minute, 0, 123));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.roles).values({
    id: 'role_sales',
    name: 'Sales',
    permissions: ['weldcrm:companies:read', 'weldcrm:companies:update'],
    createdAt: at(0),
    updatedAt: at(0),
  } as typeof schema.roles.$inferInsert);
  await db.insert(schema.workspaceMembers).values([
    {
      id: 'wm_owner',
      userId: 'user_owner',
      email: 'olivia@acme.test',
      name: 'Olivia Owner',
      role: 'OWNER',
      status: 'ACTIVE',
      createdAt: at(1),
      updatedAt: at(1),
    },
    {
      id: 'wm_admin',
      userId: 'user_admin',
      email: 'adam@acme.test',
      name: 'Adam Admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      invitedBy: 'user_owner',
      invitedAt: at(2),
      acceptedAt: at(3),
      createdAt: at(2),
      updatedAt: at(2),
    },
    {
      id: 'wm_sales',
      userId: 'user_sales',
      email: 'sam@acme.test',
      name: 'Sam Sales',
      role: 'MEMBER',
      roleId: 'role_sales',
      permissions: ['welddesk:tickets:read', 'weldcrm:companies:read'],
      permissionDenies: ['weldcrm:companies:delete'],
      status: 'ACTIVE',
      createdAt: at(4),
      updatedAt: at(4),
    },
    {
      id: 'wm_viewer',
      userId: 'user_viewer',
      email: 'vera@acme.test',
      name: 'Vera Viewer',
      role: 'VIEWER',
      status: 'ACTIVE',
      createdAt: at(5),
      updatedAt: at(5),
    },
    {
      id: 'wm_pending',
      userId: 'invited_pete@acme.test',
      email: 'pete@acme.test',
      name: 'Pete Pending',
      role: 'MEMBER',
      status: 'PENDING',
      invitedBy: 'user_admin',
      invitedAt: at(6),
      createdAt: at(6),
      updatedAt: at(6),
    },
    {
      id: 'wm_guest',
      userId: 'user_guest',
      email: 'gus@partner.test',
      name: 'Gus Guest',
      role: 'VIEWER',
      memberType: 'EXTERNAL_GUEST',
      permissions: ['channels:read'],
      status: 'ACTIVE',
      createdAt: at(7),
      updatedAt: at(7),
    },
    {
      id: 'wm_employee',
      userId: 'user_employee',
      email: 'emma@acme.test',
      name: 'Emma Employee',
      role: 'VIEWER',
      memberType: 'EMPLOYEE',
      status: 'ACTIVE',
      createdAt: at(8),
      updatedAt: at(8),
    },
    {
      id: 'wm_gone',
      userId: 'user_gone',
      email: 'gone@acme.test',
      name: 'Gone Member',
      role: 'MEMBER',
      status: 'ACTIVE',
      createdAt: at(9),
      updatedAt: at(9),
      deletedAt: at(10),
    },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await db.insert(schema.workspaceInstalledApps).values([
    { id: 'wia_crm', appCode: 'weldcrm', isActive: true, createdAt: at(0), updatedAt: at(0) },
    { id: 'wia_desk', appCode: 'welddesk', isActive: true, createdAt: at(0), updatedAt: at(0) },
    { id: 'wia_custom', appCode: 'zebra', isActive: true, createdAt: at(0), updatedAt: at(0) },
    { id: 'wia_off', appCode: 'weldmail', isActive: false, createdAt: at(0), updatedAt: at(0) },
  ] as (typeof schema.workspaceInstalledApps.$inferInsert)[]);
  await db.insert(schema.userAppAssignments).values([
    {
      id: 'uaa_crm',
      userId: 'user_sales',
      appCode: 'weldcrm',
      isActive: true,
      grantedAt: at(11),
      grantedBy: 'user_owner',
      createdAt: at(11),
      updatedAt: at(11),
    },
    {
      id: 'uaa_desk',
      userId: 'user_sales',
      appCode: 'welddesk',
      isActive: false,
      grantedAt: at(12),
      grantedBy: 'user_admin',
      createdAt: at(12),
      updatedAt: at(12),
    },
  ] as (typeof schema.userAppAssignments.$inferInsert)[]);
}, 60_000);

function app(userId: string, ...keys: string[]) {
  return createTestApp('/api/team-members', teamMembersRoutes, {
    context: { tenantDb: db, userId, permissions: permissions(...keys) },
  });
}

type ListBody = {
  data: Array<Record<string, unknown>>;
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
};

describe('GET /api/team-members/me', () => {
  it("answers the caller's own row", async () => {
    const res = await app('user_sales', 'channels:read').request('/api/team-members/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      id: 'wm_sales',
      userId: 'user_sales',
      email: 'sam@acme.test',
      name: 'Sam Sales',
      picture: null,
      role: 'MEMBER',
      roleId: 'role_sales',
      permissions: ['welddesk:tickets:read', 'weldcrm:companies:read'],
      status: 'ACTIVE',
      memberType: 'INTERNAL',
    });
  });

  it('is a 404 for a caller without a live row', async () => {
    for (const userId of ['user_nobody', 'user_gone']) {
      const res = await app(userId, 'channels:read').request('/api/team-members/me');
      expect(res.status).toBe(404);
    }
  });
});

describe('GET /api/team-members', () => {
  it('lists internal members, newest first, with the admin fields for team:read', async () => {
    const res = await app('user_admin', 'team:read').request('/api/team-members');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.data.map((m) => m.id)).toEqual(['wm_pending', 'wm_viewer', 'wm_sales', 'wm_admin', 'wm_owner']);
    expect(body.pagination).toEqual({ totalCount: 5, hasMore: false, cursor: null });
    const admin = body.data.find((m) => m.id === 'wm_admin');
    expect(admin).toMatchObject({ email: 'adam@acme.test', invitedBy: 'user_owner', createdAt: at(2).toISOString() });
  });

  it('shows others only their public fields, and the viewer their own email', async () => {
    const res = await app('user_viewer', 'channels:read').request('/api/team-members');
    const body = (await res.json()) as ListBody;
    const owner = body.data.find((m) => m.id === 'wm_owner');
    expect(Object.keys(owner!).sort()).toEqual(['id', 'memberType', 'name', 'picture', 'role', 'status', 'userId']);
    const self = body.data.find((m) => m.id === 'wm_viewer');
    expect(self).toMatchObject({ email: 'vera@acme.test', roleId: null, permissions: [] });
    expect(self).not.toHaveProperty('createdAt');
  });

  it('filters by member type, status and search', async () => {
    const t = app('user_admin', 'team:read');
    const guests = (await (await t.request('/api/team-members?memberType=EXTERNAL_GUEST')).json()) as ListBody;
    expect(guests.data.map((m) => m.id)).toEqual(['wm_guest']);
    const employees = (await (await t.request('/api/team-members?memberType=EMPLOYEE')).json()) as ListBody;
    expect(employees.data.map((m) => m.id)).toEqual(['wm_employee']);
    const all = (await (await t.request('/api/team-members?memberType=all')).json()) as ListBody;
    expect(all.pagination.totalCount).toBe(7);
    const legacy = (await (await t.request('/api/team-members?include=guests')).json()) as ListBody;
    expect(legacy.pagination.totalCount).toBe(7);
    const unknownType = (await (await t.request('/api/team-members?memberType=ROBOT')).json()) as ListBody;
    expect(unknownType.pagination.totalCount).toBe(5);
    const pending = (await (await t.request('/api/team-members?status=PENDING')).json()) as ListBody;
    expect(pending.data.map((m) => m.id)).toEqual(['wm_pending']);
    const byName = (await (await t.request('/api/team-members?search=Sales')).json()) as ListBody;
    expect(byName.data.map((m) => m.id)).toEqual(['wm_sales']);
    const byEmail = (await (await t.request('/api/team-members?search=acme.test&memberType=all')).json()) as ListBody;
    expect(byEmail.pagination.totalCount).toBe(6);
    // `like` is case-sensitive.
    const lower = (await (await t.request('/api/team-members?search=sales')).json()) as ListBody;
    expect(lower.data).toEqual([]);
    const upper = (await (await t.request('/api/team-members?search=SAM')).json()) as ListBody;
    expect(upper.data).toEqual([]);
  });

  it('pages with a keyset cursor', async () => {
    const t = app('user_admin', 'team:read');
    const first = (await (await t.request('/api/team-members?limit=2')).json()) as ListBody;
    expect(first.data.map((m) => m.id)).toEqual(['wm_pending', 'wm_viewer']);
    expect(first.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: 'wm_viewer' });
    const second = (await (await t.request('/api/team-members?limit=2&cursor=wm_viewer')).json()) as ListBody;
    expect(second.data.map((m) => m.id)).toEqual(['wm_sales', 'wm_admin']);
    expect(second.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: 'wm_admin' });
    const last = (await (await t.request('/api/team-members?limit=2&cursor=wm_admin')).json()) as ListBody;
    expect(last.data.map((m) => m.id)).toEqual(['wm_owner']);
    expect(last.pagination.hasMore).toBe(false);
  });

  it('keeps the quirks of a missing cursor, a zero limit and a large limit', async () => {
    const t = app('user_admin', 'team:read');
    // An unknown cursor adds no keyset condition, and the count drops the
    // last filter it was given (here the search).
    const unknown = (await (await t.request('/api/team-members?search=Sales&cursor=wm_nope')).json()) as ListBody;
    expect(unknown.data.map((m) => m.id)).toEqual(['wm_sales']);
    expect(unknown.pagination.totalCount).toBe(5);
    const zero = (await (await t.request('/api/team-members?limit=0')).json()) as ListBody;
    expect(zero.data).toEqual([]);
    expect(zero.pagination).toEqual({ totalCount: 5, hasMore: true, cursor: null });
    const capped = (await (await t.request('/api/team-members?limit=500&memberType=all')).json()) as ListBody;
    expect(capped.data).toHaveLength(7);
    const parsed = (await (await t.request('/api/team-members?limit=1abc')).json()) as ListBody;
    expect(parsed.data).toHaveLength(1);
  });
});

describe('GET /api/team-members/:id', () => {
  it('answers one member, projected by visibility', async () => {
    const asAdmin = await app('user_admin', 'team:read').request('/api/team-members/wm_pending');
    expect(asAdmin.status).toBe(200);
    expect(((await asAdmin.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      id: 'wm_pending',
      email: 'pete@acme.test',
      invitedAt: at(6).toISOString(),
      acceptedAt: null,
    });
    const asMember = await app('user_viewer', 'channels:read').request('/api/team-members/wm_pending');
    const data = ((await asMember.json()) as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('email');
  });

  it('is a 404 for an unknown or removed member', async () => {
    for (const id of ['wm_nope', 'wm_gone']) {
      const res = await app('user_admin', 'team:read').request(`/api/team-members/${id}`);
      expect(res.status).toBe(404);
    }
  });
});

describe('GET /api/team-members/:id/permissions', () => {
  it("splits a custom role's grants from the member's own", async () => {
    const res = await app('user_admin', 'team:read').request('/api/team-members/wm_sales/permissions');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toEqual({
      effective: ['weldcrm:companies:read', 'weldcrm:companies:update', 'welddesk:tickets:read'],
      rolePermissions: ['weldcrm:companies:read', 'weldcrm:companies:update'],
      memberOverrides: ['welddesk:tickets:read', 'weldcrm:companies:read'],
      memberDenies: ['weldcrm:companies:delete'],
      inheritedPermissions: ['weldcrm:companies:read', 'weldcrm:companies:update'],
      role: 'MEMBER',
      roleId: 'role_sales',
    });
  });

  it('inherits the system tier on a bare tier and the fixed set for an employee', async () => {
    const t = app('user_admin', 'team:read');
    const owner = ((await (await t.request('/api/team-members/wm_owner/permissions')).json()) as { data: Record<string, unknown> }).data;
    expect(owner).toMatchObject({ effective: [], rolePermissions: [], inheritedPermissions: ['*'], roleId: null });
    const viewer = ((await (await t.request('/api/team-members/wm_viewer/permissions')).json()) as { data: { inheritedPermissions: string[] } }).data;
    expect(viewer.inheritedPermissions.length).toBeGreaterThan(0);
    const employee = ((await (await t.request('/api/team-members/wm_employee/permissions')).json()) as { data: { effective: string[]; inheritedPermissions: string[] } }).data;
    expect(employee.effective).toEqual(employee.inheritedPermissions);
    expect(employee.effective.length).toBeGreaterThan(0);
  });

  it('needs team:read, and is a 404 for an unknown member', async () => {
    const refused = await app('user_viewer', 'channels:read').request('/api/team-members/wm_sales/permissions');
    expect(refused.status).toBe(403);
    const missing = await app('user_admin', 'team:read').request('/api/team-members/wm_gone/permissions');
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/team-members/:id/apps', () => {
  it('lists the active installed apps with the member’s assignments', async () => {
    const res = await app('user_admin', 'team:read').request('/api/team-members/wm_viewer/apps');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data.map((a) => a.appCode).sort()).toEqual(['weldcrm', 'welddesk', 'zebra']);
    expect(data.find((a) => a.appCode === 'zebra')).toEqual({
      appCode: 'zebra',
      appName: 'Zebra',
      isAssigned: false,
      assignedAt: null,
      assignedBy: null,
    });
  });

  it('needs team:read, and is a 404 for an unknown member', async () => {
    expect((await app('user_viewer', 'channels:read').request('/api/team-members/wm_sales/apps')).status).toBe(403);
    expect((await app('user_admin', 'team:read').request('/api/team-members/wm_nope/apps')).status).toBe(404);
  });
});

describe('POST /api/team-members/:id/apps/toggle', () => {
  function toggle(t: ReturnType<typeof app>, id: string, body: unknown) {
    return t.request(`/api/team-members/${id}/apps/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function assignment(userId: string, appCode: string) {
    const [row] = await db
      .select()
      .from(schema.userAppAssignments)
      .where(and(eq(schema.userAppAssignments.userId, userId), eq(schema.userAppAssignments.appCode, appCode)));
    return row;
  }

  it('grants a new app with the actor recorded, and reads it back', async () => {
    const t = app('user_admin', 'team:read', 'team:update');
    const res = await toggle(t, 'wm_viewer', { appCode: 'zebra', enabled: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ appCode: 'zebra', enabled: true });
    expect(await assignment('user_viewer', 'zebra')).toMatchObject({ isActive: true, grantedBy: 'user_admin' });
    const apps = ((await (await t.request('/api/team-members/wm_viewer/apps')).json()) as { data: Array<Record<string, unknown>> }).data;
    expect(apps.find((a) => a.appCode === 'zebra')).toMatchObject({ isAssigned: true, assignedBy: 'user_admin' });
  });

  it('reactivates and deactivates an existing assignment', async () => {
    const t = app('user_admin', 'team:update');
    expect((await toggle(t, 'wm_sales', { appCode: 'welddesk', enabled: true })).status).toBe(200);
    expect(await assignment('user_sales', 'welddesk')).toMatchObject({ isActive: true, grantedBy: 'user_admin' });
    expect((await toggle(t, 'wm_sales', { appCode: 'weldcrm', enabled: false })).status).toBe(200);
    expect(await assignment('user_sales', 'weldcrm')).toMatchObject({ isActive: false });
  });

  it('treats revoking a never-granted app as done', async () => {
    const res = await toggle(app('user_admin', 'team:update'), 'wm_owner', { appCode: 'weldcrm', enabled: false });
    expect(res.status).toBe(200);
    expect(await assignment('user_owner', 'weldcrm')).toBeUndefined();
  });

  it('refuses without team:update, on a bad body, and for an unknown member', async () => {
    expect((await toggle(app('user_viewer', 'team:read'), 'wm_sales', { appCode: 'zebra', enabled: true })).status).toBe(403);
    const bad = await toggle(app('user_admin', 'team:update'), 'wm_sales', { appCode: '', enabled: 'yes' });
    expect(bad.status).toBe(400);
    const missingFields = await toggle(app('user_admin', 'team:update'), 'wm_sales', {});
    expect(missingFields.status).toBe(400);
    const notJson = await app('user_admin', 'team:update').request('/api/team-members/wm_sales/apps/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope',
    });
    expect(notJson.status).toBe(400);
    expect((await toggle(app('user_admin', 'team:update'), 'wm_gone', { appCode: 'zebra', enabled: true })).status).toBe(404);
  });
});
