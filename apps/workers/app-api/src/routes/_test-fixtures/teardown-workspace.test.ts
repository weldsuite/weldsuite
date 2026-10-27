/**
 * `POST /test-fixtures/teardown-workspace` HARD-deletes a workspace row, so it
 * must first tear down everything that points at it: the tenant database
 * (through the same `deleteWorkspaceDatabase` a real deletion uses) and any
 * warm pool slot still assigned to the workspace. When that fails the row
 * stays, so a retry can finish instead of leaving a pool row 'assigned' to a
 * workspace id that no longer exists. Real master schema (PGlite); the
 * provisioning service and Clerk are spies.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';

const holder = vi.hoisted(() => ({
  masterDb: null as unknown,
  deleteWorkspaceDatabase: vi.fn(),
  dropDatabaseAt: vi.fn(),
}));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => holder.masterDb,
  // The guard resolves X-Test-Workspace-Id (either id) into the request context.
  getWorkspaceContextForOrg: async () => ({ id: 'ws_shared', clerkOrgId: 'org_shared', db: {} }),
}));
vi.mock('@weldsuite/neon-provisioning', () => ({
  createProvisioningService: () => ({
    deleteWorkspaceDatabase: holder.deleteWorkspaceDatabase,
    dropDatabaseAt: holder.dropDatabaseAt,
  }),
}));

import { testFixturesRoutes } from './index';

const { workspaces, databasePool } = masterSchema;
const TOKEN = 'fixtures-token';
const env = {
  ENVIRONMENT: 'test',
  TEST_FIXTURES_TOKEN: TOKEN,
  TEST_WORKSPACE_ID: 'org_shared',
  NEON_API_KEY: 'neon_key',
  CLERK_SECRET_KEY: 'sk_test',
};

let master: Awaited<ReturnType<typeof createMasterPgliteDb>>;
let clerkFetch: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  master = await createMasterPgliteDb();
  holder.masterDb = master.db;
}, 180_000);

beforeEach(async () => {
  await master.db.delete(databasePool);
  await master.db.delete(workspaces);
  holder.deleteWorkspaceDatabase.mockReset().mockResolvedValue({ success: true });
  // The real drop deletes the pool row it is given.
  holder.dropDatabaseAt.mockReset().mockImplementation(async (db: typeof master.db, target: { poolId?: string }) => {
    if (target.poolId) await db.delete(databasePool).where(eq(databasePool.id, target.poolId));
  });
  clerkFetch = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal('fetch', clerkFetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function seedWorkspace(over: Partial<typeof workspaces.$inferInsert> = {}) {
  await master.db.insert(workspaces).values({ id: 'ws_e2e', clerkOrgId: 'org_e2e', name: 'E2E', slug: 'e2e', ...over });
}

async function seedPoolSlot(id: string, over: Partial<typeof databasePool.$inferInsert> = {}) {
  await master.db.insert(databasePool).values({
    id,
    kind: 'shared',
    neonProjectId: 'prj-shard',
    neonBranchId: 'br-shard',
    databaseName: `ws_pool_${id}`,
    roleName: `role_pool_${id}`,
    databaseUrl: 'postgresql://unused',
    sharedProjectId: 'nsp_a',
    status: 'assigned',
    assignedWorkspaceId: 'ws_e2e',
    ...over,
  });
}

const workspaceRow = async () => (await master.db.select().from(workspaces).where(eq(workspaces.id, 'ws_e2e')))[0];
const poolRow = async (id: string) => (await master.db.select().from(databasePool).where(eq(databasePool.id, id)))[0];

const teardown = () =>
  testFixturesRoutes.request(
    '/teardown-workspace',
    {
      method: 'POST',
      headers: { 'X-Test-Token': TOKEN, 'X-Test-Workspace-Id': 'org_shared', 'Content-Type': 'application/json' },
      body: JSON.stringify({ clerkOrgId: 'org_e2e' }),
    },
    env as never,
  );

describe('POST /test-fixtures/teardown-workspace', () => {
  it('refuses to tear down the workspace the request is made as (its Clerk org id), even without TEST_WORKSPACE_ID', async () => {
    await seedWorkspace({ id: 'ws_shared', clerkOrgId: 'org_shared', slug: 'shared' });

    const { TEST_WORKSPACE_ID: _unset, ...withoutSharedId } = env;
    const res = await testFixturesRoutes.request(
      '/teardown-workspace',
      {
        method: 'POST',
        headers: { 'X-Test-Token': TOKEN, 'X-Test-Workspace-Id': 'org_shared', 'Content-Type': 'application/json' },
        body: JSON.stringify({ clerkOrgId: 'org_shared' }),
      },
      withoutSharedId as never,
    );

    expect(res.status).toBe(400);
    expect(holder.deleteWorkspaceDatabase).not.toHaveBeenCalled();
    expect(clerkFetch).not.toHaveBeenCalled();
    expect((await master.db.select().from(workspaces).where(eq(workspaces.id, 'ws_shared')))[0]).toBeDefined();
  });

  it('tears the database down through the shared teardown, then deletes the Clerk org and the row', async () => {
    await seedWorkspace({ neonProjectId: 'prj-shard', sharedProjectId: null, neonDatabaseName: 'ws_pool_dbp_1' });

    const res = await teardown();

    expect(res.status).toBe(200);
    expect(holder.deleteWorkspaceDatabase).toHaveBeenCalledWith(holder.masterDb, 'ws_e2e');
    expect(clerkFetch).toHaveBeenCalledWith(expect.stringContaining('/organizations/org_e2e'), expect.objectContaining({ method: 'DELETE' }));
    expect(await workspaceRow()).toBeUndefined();
  });

  it('keeps the workspace row (and the Clerk org) when the database teardown fails, so a retry can finish', async () => {
    await seedWorkspace({ neonProjectId: 'prj-shard' });
    await seedPoolSlot('dbp_1');
    holder.deleteWorkspaceDatabase.mockResolvedValueOnce({ success: false, error: 'Neon is unavailable' });

    const res = await teardown();

    expect(res.status).toBe(500);
    expect(await workspaceRow()).toBeDefined();
    expect(await poolRow('dbp_1')).toBeDefined();
    expect(clerkFetch).not.toHaveBeenCalled();
  });

  it('drops a warm slot the workspace claimed but never recorded as its database, with its pool row', async () => {
    await seedWorkspace();
    await seedPoolSlot('dbp_1');
    await seedPoolSlot('dbp_other', { assignedWorkspaceId: 'ws_other' });

    const res = await teardown();

    expect(res.status).toBe(200);
    expect(holder.dropDatabaseAt).toHaveBeenCalledTimes(1);
    expect(holder.dropDatabaseAt).toHaveBeenCalledWith(
      holder.masterDb,
      {
        neonProjectId: 'prj-shard',
        neonBranchId: 'br-shard',
        databaseName: 'ws_pool_dbp_1',
        roleName: 'role_pool_dbp_1',
        sharedProjectId: 'nsp_a',
        poolId: 'dbp_1',
      },
      { ignoreMissing: true },
    );
    expect(await poolRow('dbp_1')).toBeUndefined();
    expect(await poolRow('dbp_other')).toBeDefined();
    expect(await workspaceRow()).toBeUndefined();
  });

  it('keeps the workspace row when a pool slot assigned to it could not be removed', async () => {
    await seedWorkspace();
    await seedPoolSlot('dbp_1');
    holder.dropDatabaseAt.mockResolvedValueOnce(undefined);

    const res = await teardown();

    expect(res.status).toBe(500);
    expect(await poolRow('dbp_1')).toBeDefined();
    expect(await workspaceRow()).toBeDefined();
  });

  it('only deletes the Clerk org when the workspace row is already gone', async () => {
    const res = await teardown();

    expect(res.status).toBe(200);
    expect(holder.deleteWorkspaceDatabase).not.toHaveBeenCalled();
    expect(holder.dropDatabaseAt).not.toHaveBeenCalled();
    expect(clerkFetch).toHaveBeenCalledTimes(1);
  });
});
