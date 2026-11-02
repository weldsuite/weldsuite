/**
 * /api/appstore: the caller's assigned apps, the workspace's installed apps,
 * whether the caller may manage them, and granting an installed app to every
 * member (the "give access to all members" box of the install flow), with
 * the role check, legacy app codes and the permission gates. Real pglite
 * tenant DB; runs in the Rust conformance suite too
 * (`rust/conformance/suites.json`).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { appstoreRoutes } from './index';

let db: Database;

const OWNER = 'user_as_owner';
const ADMIN = 'user_as_admin';
const MEMBER = 'user_as_member';
const VIEWER = 'user_as_viewer';
const at = new Date('2026-03-01T09:00:00.000Z');

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_as_owner', userId: OWNER, role: 'OWNER' },
    { id: 'wm_as_admin', userId: ADMIN, role: 'ADMIN' },
    { id: 'wm_as_member', userId: MEMBER, role: 'MEMBER' },
    { id: 'wm_as_viewer', userId: VIEWER, role: 'VIEWER' },
    { id: 'wm_as_pending', userId: 'user_as_pending', role: 'MEMBER', status: 'PENDING' },
    { id: 'wm_as_gone', userId: 'user_as_gone', role: 'MEMBER', deletedAt: at },
  ]);
  await db.insert(schema.workspaceInstalledApps).values([
    { id: 'wia_as_desk', appCode: 'welddesk', installedBy: OWNER, installedAt: at, createdAt: at, updatedAt: at },
    {
      id: 'wia_as_crm',
      appCode: 'weldcrm',
      displayOrder: 2,
      settings: { pipeline: 'sales' },
      createdAt: at,
      updatedAt: at,
    },
    { id: 'wia_as_books', appCode: 'weldbooks', isActive: false, createdAt: at, updatedAt: at },
    { id: 'wia_as_flow', appCode: 'weldflow', deletedAt: at, createdAt: at, updatedAt: at },
  ]);
  await db.insert(schema.userAppAssignments).values([
    { id: 'uaa_as_1', userId: MEMBER, appCode: 'weldcrm', createdAt: at, updatedAt: at },
    { id: 'uaa_as_2', userId: MEMBER, appCode: 'weldbooks', isActive: false, createdAt: at, updatedAt: at },
    { id: 'uaa_as_3', userId: VIEWER, appCode: 'weldcrm', createdAt: at, updatedAt: at },
  ]);
}, 60_000);

function app(userId: string, ...keys: string[]) {
  return createTestApp('/api/appstore', appstoreRoutes, {
    context: { tenantDb: db, userId, permissions: permissions(...keys) },
  });
}

async function assignments(userId: string) {
  return db
    .select()
    .from(schema.userAppAssignments)
    .where(eq(schema.userAppAssignments.userId, userId));
}

describe('GET /api/appstore/my-apps', () => {
  it('lists the codes actively assigned to the caller', async () => {
    const res = await app(MEMBER, 'general:read').request('/api/appstore/my-apps');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: ['weldcrm'] });

    const none = await app(OWNER, 'general:read').request('/api/appstore/my-apps');
    expect(await none.json()).toEqual({ data: [] });
  });

  it('needs general:read', async () => {
    expect((await app(MEMBER).request('/api/appstore/my-apps')).status).toBe(403);
  });
});

describe('GET /api/appstore/installed-apps', () => {
  it('returns the active, undeleted rows whole', async () => {
    const res = await app(MEMBER, 'general:read').request('/api/appstore/installed-apps');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data.map((r) => r.appCode).sort()).toEqual(['weldcrm', 'welddesk']);
    expect(data.find((r) => r.appCode === 'weldcrm')).toEqual({
      id: 'wia_as_crm',
      appCode: 'weldcrm',
      isActive: true,
      displayOrder: 2,
      appType: 'system',
      userAppId: null,
      grantedScopes: null,
      settings: { pipeline: 'sales' },
      installedAt: expect.any(String),
      installedBy: null,
      createdAt: '2026-03-01T09:00:00.000Z',
      updatedAt: '2026-03-01T09:00:00.000Z',
      deletedAt: null,
    });
  });

  it('needs general:read', async () => {
    expect((await app(MEMBER).request('/api/appstore/installed-apps')).status).toBe(403);
  });
});

describe('GET /api/appstore/can-manage-apps', () => {
  it('is true for owners and admins only', async () => {
    for (const [userId, canManage] of [
      [OWNER, true],
      [ADMIN, true],
      [MEMBER, false],
      ['user_as_gone', false],
      ['user_as_stranger', false],
    ] as const) {
      const res = await app(userId, 'general:read').request('/api/appstore/can-manage-apps');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { canManage } });
    }
  });

  it('needs general:read', async () => {
    expect((await app(OWNER).request('/api/appstore/can-manage-apps')).status).toBe(403);
  });
});

describe('POST /api/appstore/apps/:appCode/assign-all-members', () => {
  it('grants an installed app to the active members and viewers, by its legacy code too', async () => {
    const res = await app(OWNER, 'general:update').request('/api/appstore/apps/helpdesk/assign-all-members', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { appCode: 'welddesk', assignedCount: 2 } });

    const [granted] = (await assignments(MEMBER)).filter((a) => a.appCode === 'welddesk');
    expect(granted).toMatchObject({ isActive: true, grantedBy: OWNER, deletedAt: null });
    expect(granted?.grantedAt).toBeInstanceOf(Date);
    expect((await assignments(VIEWER)).map((a) => a.appCode).sort()).toEqual(['weldcrm', 'welddesk']);
    expect(await assignments(OWNER)).toEqual([]);
    expect(await assignments('user_as_pending')).toEqual([]);
    expect(await assignments('user_as_gone')).toEqual([]);
  });

  it('leaves existing assignments as they are', async () => {
    const res = await app(ADMIN, 'general:update').request('/api/appstore/apps/weldcrm/assign-all-members', {
      method: 'POST',
    });
    expect(await res.json()).toEqual({ data: { appCode: 'weldcrm', assignedCount: 2 } });
    const crm = await db
      .select()
      .from(schema.userAppAssignments)
      .where(and(eq(schema.userAppAssignments.appCode, 'weldcrm'), eq(schema.userAppAssignments.userId, MEMBER)));
    expect(crm.map((a) => a.id)).toEqual(['uaa_as_1']);
    expect(crm[0]?.grantedBy).toBeNull();
  });

  it('answers 403 for a member who is not an owner or admin', async () => {
    const res = await app(MEMBER, 'general:update').request('/api/appstore/apps/welddesk/assign-all-members', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'Only workspace admins can assign apps' },
    });
  });

  it('answers 404 for an app that is not actively installed', async () => {
    for (const code of ['weldbooks', 'weldflow', 'weldnothing']) {
      const res = await app(ADMIN, 'general:update').request(`/api/appstore/apps/${code}/assign-all-members`, {
        method: 'POST',
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: 'NOT_FOUND', message: `Installed app with ID '${code}' not found` },
      });
    }
  });

  it('needs general:update', async () => {
    const res = await app(OWNER, 'general:read').request('/api/appstore/apps/welddesk/assign-all-members', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });
});
