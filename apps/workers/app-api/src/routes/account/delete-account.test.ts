/**
 * `POST /account/delete` deletes the Clerk org of every workspace the caller is
 * the only member of, and marks such a workspace deleted (`deleted_at`) only
 * when Clerk confirmed that delete. A workspace whose org delete failed is
 * still deactivated, but not marked deleted: workspace-worker's teardown retry
 * sweep tears down the database of a deleted workspace, and that org still
 * exists. Real master schema (PGlite); Clerk is a spy.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { DELETE_ACCOUNT_CONFIRMATION } from '@weldsuite/app-api-client/schemas/account';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

const holder = vi.hoisted(() => ({
  masterDb: null as unknown,
  deleteOrganization: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => holder.masterDb,
}));
vi.mock('@weldsuite/worker-kit/middleware/clerk', () => ({
  clerkMiddleware: () => async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user_1');
    await next();
  },
}));
vi.mock('@clerk/backend', () => ({
  createClerkClient: () => ({
    organizations: { deleteOrganization: holder.deleteOrganization },
    users: { deleteUser: holder.deleteUser },
  }),
}));

import { accountRoutes } from './index';

const { users, userWorkspaces, workspaces } = masterSchema;

let master: Awaited<ReturnType<typeof createMasterPgliteDb>>;

beforeAll(async () => {
  master = await createMasterPgliteDb();
  holder.masterDb = master.db;
}, 180_000);

beforeEach(async () => {
  await master.db.delete(userWorkspaces);
  await master.db.delete(workspaces);
  await master.db.delete(users);
  await master.db.insert(users).values({ id: 'user_1', email: 'owner@example.com' });
  for (const id of ['ws_1', 'ws_2']) {
    await master.db.insert(workspaces).values({ id, clerkOrgId: `org_${id}`, name: id, slug: id, neonProjectId: `prj-${id}` });
    await master.db.insert(userWorkspaces).values({ id: `uw_${id}`, userId: 'user_1', workspaceId: id, role: 'org:admin' });
  }
  holder.deleteOrganization.mockReset().mockResolvedValue({});
  holder.deleteUser.mockReset().mockResolvedValue({});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const deleteAccount = () =>
  accountRoutes.request(
    '/delete',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: DELETE_ACCOUNT_CONFIRMATION }),
    },
    { CLERK_SECRET_KEY: 'sk_test' } as never,
  );

const workspaceRow = async (id: string) => (await master.db.select().from(workspaces).where(eq(workspaces.id, id)))[0];

describe('POST /account/delete', () => {
  it('marks a sole-member workspace deleted once Clerk confirmed its org delete, and not one whose delete failed', async () => {
    holder.deleteOrganization.mockImplementation(async (orgId: string) => {
      if (orgId === 'org_ws_2') throw new Error('Clerk is down');
      return {};
    });

    const res = await deleteAccount();

    expect(res.status).toBe(200);
    expect(holder.deleteOrganization).toHaveBeenCalledTimes(2);
    expect(await workspaceRow('ws_1')).toMatchObject({ isActive: false, deletedAt: expect.any(Date) });
    expect(await workspaceRow('ws_2')).toMatchObject({ isActive: false, deletedAt: null });
  });

  it('keeps a deleted_at the organization.deleted webhook already wrote', async () => {
    const stampedAt = new Date('2026-10-20T12:00:00.000Z');
    await master.db.update(workspaces).set({ deletedAt: stampedAt }).where(eq(workspaces.id, 'ws_1'));

    expect((await deleteAccount()).status).toBe(200);
    expect((await workspaceRow('ws_1'))?.deletedAt).toEqual(stampedAt);
  });
});
