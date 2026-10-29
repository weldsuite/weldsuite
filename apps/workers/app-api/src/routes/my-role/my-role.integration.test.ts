/**
 * GET /api/my-role against pglite: the caller's role and what it lets them
 * manage, resolved from the member row (not from cached permissions).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { myRoleRoutes } from './index';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const now = new Date();
  await db.insert(schema.roles).values([
    { id: 'role_mr_lead', name: 'Team lead', permissions: ['team:read', 'team:update'], createdAt: now, updatedAt: now },
  ]);
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_mr_admin', userId: 'user_mr_admin', email: 'admin@mr.test', role: 'ADMIN', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_mr_member', userId: 'user_mr_member', email: 'member@mr.test', role: 'member', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_mr_lead', userId: 'user_mr_lead', email: 'lead@mr.test', role: 'MEMBER', roleId: 'role_mr_lead', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_mr_pending', userId: 'user_mr_pending', email: 'pending@mr.test', role: 'ADMIN', status: 'PENDING', createdAt: now, updatedAt: now },
    { id: 'wm_mr_gone', userId: 'user_mr_gone', email: 'gone@mr.test', role: 'ADMIN', status: 'ACTIVE', deletedAt: now, createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
}, 60_000);

async function myRole(userId: string, orgId: string | null = 'org_test_default') {
  const t = createTestApp('/api/my-role', myRoleRoutes, { context: { tenantDb: db, userId, orgId } });
  const res = await t.request('/api/my-role');
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/my-role', () => {
  it('needs an organization', async () => {
    const { status, body } = await myRole('user_mr_admin', null);
    expect(status).toBe(400);
    expect(body).toEqual({ error: { code: 'ORG_REQUIRED', message: 'Organization context required' } });
  });

  it('an admin manages members and roles', async () => {
    expect(await myRole('user_mr_admin')).toEqual({
      status: 200,
      body: { data: { role: 'ADMIN', canManageMembers: true, canManageRoles: true } },
    });
  });

  it('a member manages neither, and the role is upper-cased', async () => {
    expect((await myRole('user_mr_member')).body).toEqual({
      data: { role: 'MEMBER', canManageMembers: false, canManageRoles: false },
    });
  });

  it("a custom role's permissions count", async () => {
    expect((await myRole('user_mr_lead')).body).toEqual({
      data: { role: 'MEMBER', canManageMembers: true, canManageRoles: false },
    });
  });

  it('a pending invitation shows its role but grants nothing yet', async () => {
    expect((await myRole('user_mr_pending')).body).toEqual({
      data: { role: 'ADMIN', canManageMembers: false, canManageRoles: false },
    });
  });

  it('no role for someone who is not (or no longer) a member', async () => {
    for (const userId of ['user_mr_gone', 'user_mr_stranger']) {
      expect((await myRole(userId)).body).toEqual({
        data: { role: null, canManageMembers: false, canManageRoles: false },
      });
    }
  });
});
