/**
 * /api/account against a real master database (pglite) with Clerk as a
 * fetch stub: the deletion status, the confirmation, the sole-admin refusal,
 * and the deletion itself (Clerk org and user deletes, master clean-up).
 * Conformance-ready (rust/conformance/suites.json): Clerk's calls are compared
 * between the backends.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { DELETE_ACCOUNT_CONFIRMATION } from '@weldsuite/app-api-client/schemas/account';
import { conformanceMasterDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { clerkCalls, clerkError, stubClerk } from '../../test/fake-clerk';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));
// The session comes from the test context; the router's own Clerk check is skipped.
vi.mock('@weldsuite/worker-kit/middleware/clerk', () => ({
  clerkMiddleware: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
// The SDK's requests, through the stubbed fetch (the SDK binds fetch at load).
vi.mock('@clerk/backend', async () => {
  const { clerkShim } = await import('../../test/fake-clerk');
  return { createClerkClient: () => clerkShim() };
});

import { accountRoutes } from './index';

const { users, userWorkspaces, workspaces } = masterSchema;

let tenantDb: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
}, 180_000);

/**
 * user_acc owns ws_acc_solo alone, is the only admin of ws_acc_team (with a
 * member), and shares ws_acc_shared with another admin.
 */
async function seed(): Promise<void> {
  await master.delete(userWorkspaces);
  await master.delete(workspaces);
  await master.delete(users);
  await master.insert(users).values([
    { id: 'user_acc', email: 'acc@example.com', firstName: 'Ann', phone: '+31 6 1234' },
    { id: 'user_acc_member', email: 'member@example.com' },
    { id: 'user_acc_admin', email: 'admin@example.com' },
  ]);
  await master.insert(workspaces).values([
    { id: 'ws_acc_solo', clerkOrgId: 'org_acc_solo', name: 'Solo', slug: 'acc-solo' },
    { id: 'ws_acc_team', clerkOrgId: 'org_acc_team', name: 'Team', slug: 'acc-team' },
    { id: 'ws_acc_shared', clerkOrgId: 'org_acc_shared', name: 'Shared', slug: 'acc-shared' },
  ]);
  await master.insert(userWorkspaces).values([
    { id: 'uw_acc_solo', userId: 'user_acc', workspaceId: 'ws_acc_solo', role: 'org:admin' },
    { id: 'uw_acc_team', userId: 'user_acc', workspaceId: 'ws_acc_team', role: 'org:admin' },
    { id: 'uw_acc_team_m', userId: 'user_acc_member', workspaceId: 'ws_acc_team', role: 'org:member' },
    { id: 'uw_acc_shared', userId: 'user_acc', workspaceId: 'ws_acc_shared', role: 'org:admin' },
    { id: 'uw_acc_shared_a', userId: 'user_acc_admin', workspaceId: 'ws_acc_shared', role: 'org:admin' },
  ]);
}

beforeEach(async () => {
  await seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function app(userId = 'user_acc') {
  return createTestApp('/api/account', accountRoutes, {
    context: { userId, orgId: null, tenantDb, masterDb: master },
  });
}

function remove(body: unknown, userId?: string) {
  return app(userId).request('/api/account/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const workspaceRow = async (id: string) =>
  (await master.select().from(workspaces).where(eq(workspaces.id, id)))[0] as typeof workspaces.$inferSelect;

describe('GET /api/account/deletion-status', () => {
  it('lists what blocks the deletion and what goes with it', async () => {
    const res = await app().request('/api/account/deletion-status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual({
      canDelete: false,
      blockers: [{ workspaceId: 'ws_acc_team', name: 'Team', reason: 'sole_admin_with_members', otherMemberCount: 1 }],
      workspacesToDelete: [{ workspaceId: 'ws_acc_solo', name: 'Solo' }],
    });
  });

  it('is clear for a user without workspaces', async () => {
    const res = await app('user_acc_nobody').request('/api/account/deletion-status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { canDelete: true, blockers: [], workspacesToDelete: [] } });
  });
});

describe('POST /api/account/delete', () => {
  it('needs the typed confirmation', async () => {
    stubClerk(() => undefined);
    for (const body of [{ confirmation: 'delete' }, {}, { confirmation: 7 }]) {
      const res = await remove(body);
      expect(res.status).toBe(400);
    }
  });

  it('refuses while the caller is the only admin of a team', async () => {
    const stub = stubClerk(() => ({ status: 200, body: {} }));
    const res = await remove({ confirmation: DELETE_ACCOUNT_CONFIRMATION });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: { blockers: unknown[] } } };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details.blockers).toHaveLength(1);
    expect(clerkCalls(stub)).toEqual([]);
  });

  it('deletes the solo workspaces, the user and the memberships', async () => {
    // Make the team deletable: another admin joins.
    await master.update(userWorkspaces).set({ role: 'org:admin' }).where(eq(userWorkspaces.id, 'uw_acc_team_m'));
    const stub = stubClerk((method) => (method === 'DELETE' ? { status: 200, body: { deleted: true } } : undefined));

    const res = await remove({ confirmation: DELETE_ACCOUNT_CONFIRMATION });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: true } });
    expect(clerkCalls(stub)).toContain('DELETE /organizations/org_acc_solo');
    expect(clerkCalls(stub)).toContain('DELETE /users/user_acc');

    const solo = await workspaceRow('ws_acc_solo');
    expect(solo.isActive).toBe(false);
    expect(solo.deletedAt).not.toBeNull();
    expect((await workspaceRow('ws_acc_team')).isActive).toBe(true);
    const [user] = await master.select().from(users).where(eq(users.id, 'user_acc'));
    expect(user).toMatchObject({ isActive: false, email: 'user_acc@deleted.weldsuite.org', firstName: null, phone: null });
    expect(await master.select().from(userWorkspaces).where(eq(userWorkspaces.userId, 'user_acc'))).toEqual([]);
  });

  it('keeps a workspace whose org delete failed undeleted, but inactive', async () => {
    await master.update(userWorkspaces).set({ role: 'org:admin' }).where(eq(userWorkspaces.id, 'uw_acc_team_m'));
    stubClerk((method, path) => {
      if (path === '/organizations/org_acc_solo') return clerkError(500, 'internal_error');
      return method === 'DELETE' ? { status: 200, body: {} } : undefined;
    });
    const res = await remove({ confirmation: DELETE_ACCOUNT_CONFIRMATION });
    expect(res.status).toBe(200);
    const solo = await workspaceRow('ws_acc_solo');
    expect(solo.isActive).toBe(false);
    expect(solo.deletedAt).toBeNull();
  });

  it('answers 500 when Clerk cannot delete the user', async () => {
    stubClerk((_method, path) => (path.startsWith('/users/') ? clerkError(503, 'unavailable') : { status: 200, body: {} }));
    const res = await remove({ confirmation: DELETE_ACCOUNT_CONFIRMATION }, 'user_acc_member');
    expect(res.status).toBe(500);
    // Nothing was scrubbed.
    const [user] = await master.select().from(users).where(eq(users.id, 'user_acc_member'));
    expect(user?.isActive).toBe(true);
  });
});
