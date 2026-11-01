/**
 * Every /api/roles route against a real pglite tenant DB, refusals included:
 * the permission catalog with the workspace's custom objects, the installable
 * apps, copying a role, the grant ceiling on update, system-role locks, and
 * the WeldChat cleanup (memberships and realtime) when a role is deleted.
 *
 * No mocks, so the conformance suite runs it against the Rust backend too.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { rolesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

interface RoleBody {
  id: string;
  name: string;
  description: string | null;
  isSystemRole: boolean;
  permissions: string[];
  apps: string[];
  memberCount: number;
}

const ALL = ['roles:read', 'roles:create', 'roles:update', 'roles:delete', 'leads:read', 'leads:update', 'team:read'];

function api(...keys: string[]) {
  return createTestApp('/api/roles', rolesRoutes, {
    context: { tenantDb: db, permissions: permissions(...(keys.length > 0 ? keys : ALL)) },
  });
}

function send(path: string, method: string, body: unknown, ...keys: string[]) {
  return api(...keys).request(`/api/roles${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function created(res: Response): Promise<RoleBody> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: RoleBody }).data;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.customObjects).values([
    { id: 'cob_machine', slug: 'machine', entityKey: 'co_machine', labelSingular: 'Machine', labelPlural: 'Machines' },
    { id: 'cob_vehicle', slug: 'vehicle', entityKey: 'co_vehicle', labelSingular: 'Vehicle', labelPlural: 'Vehicles', sortOrder: -1 },
    {
      id: 'cob_gone',
      slug: 'gone',
      entityKey: 'co_gone',
      labelSingular: 'Gone',
      labelPlural: 'Gones',
      deletedAt: now,
    },
  ] as (typeof schema.customObjects.$inferInsert)[]);
  await db.insert(schema.workspaceInstalledApps).values([
    { id: 'wia_crm', appCode: 'weldcrm', isActive: true },
    { id: 'wia_helpdesk', appCode: 'helpdesk', isActive: true },
    { id: 'wia_zap', appCode: 'zapflow', isActive: true },
    { id: 'wia_mail', appCode: 'weldmail', isActive: false },
    { id: 'wia_desk', appCode: 'welddesk', isActive: true, deletedAt: now },
  ]);
  // The four system roles.
  expect((await api().request('/api/roles')).status).toBe(200);
}, 60_000);

describe('GET /api/roles/permission-catalog', () => {
  it("adds the workspace's live custom objects in their own group", async () => {
    const res = await api('roles:read').request('/api/roles/permission-catalog');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { customObjects: Array<{ object: string; objectName: string; permissions: Array<{ code: string; action: string }> }> };
    };
    expect(data.customObjects.map((o) => o.object)).toEqual(['weldobjects:vehicle', 'weldobjects:machine']);
    expect(data.customObjects[1]!.permissions.map((p) => p.action)).toEqual([
      'machine:read',
      'machine:create',
      'machine:update',
      'machine:delete',
      'machine:scope:all',
    ]);
  });

  it('needs roles:read', async () => {
    expect((await api('team:read').request('/api/roles/permission-catalog')).status).toBe(403);
  });
});

describe('GET /api/roles/installable-apps', () => {
  it('lists the active installed apps with their display names', async () => {
    const res = await api('roles:read').request('/api/roles/installable-apps');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ appCode: string; appName: string }> };
    expect([...data].sort((a, b) => a.appCode.localeCompare(b.appCode))).toEqual([
      { appCode: 'helpdesk', appName: 'WeldDesk' },
      { appCode: 'weldcrm', appName: 'WeldCRM' },
      { appCode: 'zapflow', appName: 'Zapflow' },
    ]);
  });

  it('needs roles:read', async () => {
    expect((await api('team:read').request('/api/roles/installable-apps')).status).toBe(403);
  });
});

describe('GET /api/roles/:roleId', () => {
  it('answers 404 for an unknown role', async () => {
    const res = await api().request('/api/roles/role_missing');
    expect(res.status).toBe(404);
  });

  it('needs roles:read', async () => {
    expect((await api('team:read').request('/api/roles/role_missing')).status).toBe(403);
  });
});

describe('POST /api/roles', () => {
  it('validates the body', async () => {
    expect((await send('', 'POST', {})).status).toBe(400);
    expect((await send('', 'POST', { name: 'Ok', permissions: 'leads:read' })).status).toBe(400);
  });

  it('copies permissions and apps from another role unless they are given', async () => {
    const source = await created(
      await send('', 'POST', { name: 'Source', description: 'Copy me', permissions: ['leads:read'], apps: ['weldcrm'] }),
    );
    const copy = await created(await send('', 'POST', { name: 'Copy', copyFromRoleId: source.id }));
    expect(copy.permissions).toEqual(['leads:read']);
    expect(copy.apps).toEqual(['weldcrm']);
    expect(copy.description).toBeNull();

    const own = await created(await send('', 'POST', { name: 'Own apps', copyFromRoleId: source.id, apps: [] }));
    expect(own.apps).toEqual([]);
    expect(own.permissions).toEqual(['leads:read']);

    const unknownSource = await created(await send('', 'POST', { name: 'No source', copyFromRoleId: 'role_nope' }));
    expect(unknownSource.permissions).toEqual([]);
  });

  it('refuses unknown keys with 400 and keys the caller lacks with 403', async () => {
    const bad = await send('', 'POST', { name: 'Bad keys', permissions: ['made:up', 'leads:read'] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { details: unknown } }).error.details).toEqual({
      field: 'permissions',
      invalid: ['made:up'],
    });
    expect((await send('', 'POST', { name: 'Not held', permissions: ['billing:manage'] })).status).toBe(403);
  });

  it('needs roles:create', async () => {
    expect((await send('', 'POST', { name: 'Nope' }, 'roles:read')).status).toBe(403);
  });
});

describe('PUT /api/roles/:roleId', () => {
  it('answers 404 for an unknown role and 403 for a system role', async () => {
    expect((await send('/role_missing', 'PUT', { name: 'X' })).status).toBe(404);
    const list = ((await (await api().request('/api/roles')).json()) as { data: RoleBody[] }).data;
    const admin = list.find((r) => r.name === 'Admin')!;
    expect((await send(`/${admin.id}`, 'PUT', { description: 'mine now' })).status).toBe(403);
  });

  it('keeps permissions the role already has, but refuses adding ones the caller lacks', async () => {
    const role = await created(await send('', 'POST', { name: 'Ceiling', permissions: ['leads:read'] }));
    // A caller without leads:read may still keep it on the role.
    const kept = await send(`/${role.id}`, 'PUT', { permissions: ['leads:read', 'team:read'] }, 'roles:update', 'team:read');
    expect(kept.status).toBe(200);
    const widened = await send(`/${role.id}`, 'PUT', { permissions: ['billing:manage'] }, 'roles:update');
    expect(widened.status).toBe(403);
    const unknown = await send(`/${role.id}`, 'PUT', { permissions: ['made:up'] });
    expect(unknown.status).toBe(400);
  });

  it('updates the description and apps', async () => {
    const role = await created(await send('', 'POST', { name: 'Editable' }));
    const res = await send(`/${role.id}`, 'PUT', { description: 'Now described', apps: ['weldcrm', 'helpdesk'] });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: RoleBody };
    expect(data.description).toBe('Now described');
    expect(data.apps).toEqual(['weldcrm', 'helpdesk']);
  });

  it('validates the body and needs roles:update', async () => {
    const role = await created(await send('', 'POST', { name: 'Guarded' }));
    expect((await send(`/${role.id}`, 'PUT', { name: '' })).status).toBe(400);
    expect((await send(`/${role.id}`, 'PUT', { name: 'Fine' }, 'roles:read')).status).toBe(403);
  });
});

describe('DELETE /api/roles/:roleId', () => {
  it('answers 404 for an unknown role and 403 for a system role', async () => {
    expect((await api().request('/api/roles/role_missing', { method: 'DELETE' })).status).toBe(404);
    const list = ((await (await api().request('/api/roles')).json()) as { data: RoleBody[] }).data;
    const viewer = list.find((r) => r.name === 'Viewer')!;
    expect((await api().request(`/api/roles/${viewer.id}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('drops the role-driven chat memberships and keeps the manual ones', async () => {
    const role = await created(await send('', 'POST', { name: 'Chatty' }));
    const now = new Date();
    await db.insert(schema.chatChannels).values({ id: 'chc_role', name: 'Role room', slug: 'role-room', memberCount: 3 } as typeof schema.chatChannels.$inferInsert);
    await db.insert(schema.chatChannelRoleLinks).values({ id: 'crl_1', channelId: 'chc_role', roleId: role.id, createdAt: now });
    await db.insert(schema.chatChannelMembers).values([
      { id: 'ccm_1', channelId: 'chc_role', userId: 'user_by_role_1', addedByRoleId: role.id },
      { id: 'ccm_2', channelId: 'chc_role', userId: 'user_by_role_2', addedByRoleId: role.id },
      { id: 'ccm_3', channelId: 'chc_role', userId: 'user_manual' },
    ] as (typeof schema.chatChannelMembers.$inferInsert)[]);

    const res = await api().request(`/api/roles/${role.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const left = await db
      .select({ userId: schema.chatChannelMembers.userId })
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.channelId, 'chc_role'));
    expect(left.map((m) => m.userId)).toEqual(['user_manual']);
    const links = await db
      .select()
      .from(schema.chatChannelRoleLinks)
      .where(and(eq(schema.chatChannelRoleLinks.channelId, 'chc_role'), eq(schema.chatChannelRoleLinks.roleId, role.id)));
    expect(links).toHaveLength(0);
    const [channel] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, 'chc_role'));
    expect(channel!.memberCount).toBe(1);
    expect((await api().request(`/api/roles/${role.id}`)).status).toBe(404);
  });

  it('needs roles:delete', async () => {
    const role = await created(await send('', 'POST', { name: 'Sticky' }));
    expect((await api('roles:read').request(`/api/roles/${role.id}`, { method: 'DELETE' })).status).toBe(403);
  });
});
