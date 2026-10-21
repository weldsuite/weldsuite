/**
 * The teardown retry sweep on a real master schema (PGlite), with the real
 * `deleteWorkspaceDatabase` over a fake Neon API: which deleted workspaces it
 * retries (old enough, inactive, still holding a database), the move that holds
 * one back, a failure that is counted without stopping the rest or throwing,
 * the bounded batch and the requeue that keeps a stuck row from starving the
 * others.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { eq } from 'drizzle-orm';
import {
  databasePool,
  neonSharedProjects,
  workspaceDatabaseMoves,
  workspaces,
  type DatabaseMoveStatus,
} from '@weldsuite/db/schema/master';
import { NeonApiError, type DatabaseProvisioningService } from '@weldsuite/neon-provisioning';
import {
  FAKE_SECRET_PREFIX,
  createFakeNeon,
  createServiceWith,
  type FakeNeon,
} from '@weldsuite/neon-provisioning/test/fake-neon';
import {
  SECRET_PREFIX,
  SOURCE,
  WORKSPACE_ID,
  createLightWorld,
  createMoveMaster,
  type LightWorld,
  type MoveMaster,
} from '../test/move-harness';
import type { Env } from '../index';
import type { MasterDatabase } from '../db';
import { TEARDOWN_BATCH_LIMIT, sweepUnfinishedTeardowns } from './teardown-sweep';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const NOW = new Date('2026-10-21T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let master: MoveMaster;
let world: LightWorld;
let fake: FakeNeon;
let service: DatabaseProvisioningService;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeAll(async () => {
  master = await createMoveMaster();
});

afterAll(async () => {
  await master.close();
});

beforeEach(async () => {
  world = await createLightWorld(master);
  await world.masterDb.update(neonSharedProjects).set({ databaseCount: 3 }).where(eq(neonSharedProjects.id, SOURCE.shard));
  fake = createFakeNeon();
  service = createServiceWith(fake);
  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  const output = consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 6 })).join('\n');
  vi.restoreAllMocks();
  expect(output).not.toContain(SECRET_PREFIX);
  expect(output).not.toContain(FAKE_SECRET_PREFIX);
  expect(output).not.toContain('postgresql://');
});

const env = () => ({ NEON_API_KEY: 'test-api-key' }) as Env;
const options = (over: { batchLimit?: number } = {}) => ({
  masterDb: world.masterDb,
  provisioning: service,
  now: () => NOW,
  ...over,
});

/** Mark a workspace deleted the way the deletion paths leave it: `deleted_at` stamped and inactive. */
async function markDeleted(workspaceId: string, deletedAt: Date, over: Partial<typeof workspaces.$inferInsert> = {}) {
  await world.masterDb
    .update(workspaces)
    .set({ deletedAt, isActive: false, ...over })
    .where(eq(workspaces.id, workspaceId));
}

/** Another workspace with its own dedicated Neon project (the seeded one lives on the shard). */
async function seedDedicatedWorkspace(id: string, over: Partial<typeof workspaces.$inferInsert> = {}): Promise<void> {
  await world.masterDb.insert(workspaces).values({
    id,
    clerkOrgId: `org_${id}`,
    name: id,
    slug: id,
    neonProjectId: `prj-${id}`,
    neonBranchId: `br-${id}`,
    neonDatabaseName: 'neondb',
    neonRoleName: 'neondb_owner',
    databaseProvisionedAt: new Date('2026-01-01T00:00:00Z'),
    provisioningStatus: 'ready',
    ...over,
  });
}

async function workspace(id: string = WORKSPACE_ID) {
  const [row] = await world.masterDb.select().from(workspaces).where(eq(workspaces.id, id));
  if (!row) throw new Error(`no workspace ${id}`);
  return row;
}

async function shardCount(): Promise<number> {
  const [row] = await world.masterDb
    .select({ count: neonSharedProjects.databaseCount })
    .from(neonSharedProjects)
    .where(eq(neonSharedProjects.id, SOURCE.shard));
  return row?.count ?? -1;
}

async function seedAssignedPoolSlot(): Promise<void> {
  await world.masterDb.insert(databasePool).values({
    id: 'dbp_1',
    kind: 'shared',
    neonProjectId: SOURCE.project,
    neonBranchId: SOURCE.branch,
    databaseName: SOURCE.db,
    roleName: SOURCE.role,
    databaseUrl: 'encrypted',
    sharedProjectId: SOURCE.shard,
    status: 'assigned',
    assignedWorkspaceId: WORKSPACE_ID,
  });
}

async function poolRows() {
  return world.masterDb.select({ id: databasePool.id }).from(databasePool);
}

async function insertMove(status: DatabaseMoveStatus): Promise<string> {
  const id = `dbm_${Math.random().toString(36).slice(2, 12)}`;
  await world.masterDb.insert(workspaceDatabaseMoves).values({
    id,
    workspaceId: WORKSPACE_ID,
    kind: 'shard_to_dedicated',
    status,
    requestedTarget: 'dedicated',
    sourceNeonProjectId: SOURCE.project,
    sourceNeonBranchId: SOURCE.branch,
    sourceDatabaseName: SOURCE.db,
    sourceRoleName: SOURCE.role,
    sourceSharedProjectId: SOURCE.shard,
    startedBy: 'ops@weldsuite.org',
  });
  return id;
}

function neonCalls(): number {
  return fake.getDatabase.mock.calls.length + fake.deleteDatabase.mock.calls.length
    + fake.deleteRole.mock.calls.length + fake.deleteProject.mock.calls.length;
}

describe('sweepUnfinishedTeardowns', () => {
  it('finishes the teardown of a workspace deleted more than 48h ago: database, slot, role, pool row and placement', async () => {
    await seedAssignedPoolSlot();
    await markDeleted(WORKSPACE_ID, new Date(NOW.getTime() - 3 * DAY));

    const result = await sweepUnfinishedTeardowns(env(), options());

    expect(result).toEqual({ due: 1, succeeded: 1, failed: 0, deferred: 0 });
    expect(fake.deleteDatabase).toHaveBeenCalledWith(SOURCE.project, SOURCE.branch, SOURCE.db);
    expect(fake.deleteRole).toHaveBeenCalledWith(SOURCE.project, SOURCE.branch, SOURCE.role);
    expect(fake.deleteProject).not.toHaveBeenCalled();
    expect(await shardCount()).toBe(2);
    expect(await poolRows()).toEqual([]);
    expect(await workspace()).toMatchObject({
      neonProjectId: null,
      neonBranchId: null,
      neonDatabaseName: null,
      neonRoleName: null,
      sharedProjectId: null,
      databaseProvisionedAt: null,
    });
  });

  it('finishes a teardown an earlier attempt left half done: the database is gone, the rest is not', async () => {
    // The earlier attempt dropped the database and counted its slot back, then failed on the role.
    await seedAssignedPoolSlot();
    await markDeleted(WORKSPACE_ID, new Date(NOW.getTime() - 3 * DAY));
    fake.getDatabase.mockRejectedValueOnce(new NeonApiError('database not found', 404));

    const result = await sweepUnfinishedTeardowns(env(), options());

    expect(result).toEqual({ due: 1, succeeded: 1, failed: 0, deferred: 0 });
    expect(fake.deleteDatabase).not.toHaveBeenCalled();
    expect(fake.deleteRole).toHaveBeenCalledWith(SOURCE.project, SOURCE.branch, SOURCE.role);
    expect(await shardCount()).toBe(3);
    expect(await poolRows()).toEqual([]);
    expect((await workspace()).neonProjectId).toBeNull();
  });

  it('leaves a workspace deleted less than 48h ago to the webhook and its Svix redeliveries', async () => {
    await markDeleted(WORKSPACE_ID, new Date(NOW.getTime() - 47 * HOUR));

    const result = await sweepUnfinishedTeardowns(env(), options());

    expect(result).toEqual({ due: 0, succeeded: 0, failed: 0, deferred: 0 });
    expect(neonCalls()).toBe(0);
    expect((await workspace()).neonProjectId).toBe(SOURCE.project);
  });

  it.each([
    ['not deleted, only suspended (admin-scheduled deletion)', { deletedAt: null, isActive: false }],
    ['deleted but active again (restored by hand)', { deletedAt: new Date(NOW.getTime() - 3 * DAY), isActive: true }],
    ['deleted and already torn down', { deletedAt: new Date(NOW.getTime() - 3 * DAY), isActive: false, neonProjectId: null }],
  ])('never touches a workspace that is %s', async (_label, state) => {
    await world.masterDb.update(workspaces).set(state).where(eq(workspaces.id, WORKSPACE_ID));

    const result = await sweepUnfinishedTeardowns(env(), options());

    expect(result.due).toBe(0);
    expect(neonCalls()).toBe(0);
  });

  it.each(['queued', 'preparing', 'soft_locked', 'locked', 'copying', 'verifying', 'switching', 'cancelling'] as const)(
    'defers a workspace whose move is %s, and finishes it once the move is over',
    async (status) => {
      await markDeleted(WORKSPACE_ID, new Date(NOW.getTime() - 3 * DAY));
      const moveId = await insertMove(status);

      expect(await sweepUnfinishedTeardowns(env(), options())).toEqual({ due: 1, succeeded: 0, failed: 0, deferred: 1 });
      expect(neonCalls()).toBe(0);
      expect((await workspace()).neonProjectId).toBe(SOURCE.project);

      await world.masterDb.update(workspaceDatabaseMoves).set({ status: 'failed' }).where(eq(workspaceDatabaseMoves.id, moveId));
      expect(await sweepUnfinishedTeardowns(env(), options())).toEqual({ due: 1, succeeded: 1, failed: 0, deferred: 0 });
      expect((await workspace()).neonProjectId).toBeNull();
    },
  );

  it('counts a failed teardown without throwing, keeps its placement, and goes on with the rest', async () => {
    await markDeleted(WORKSPACE_ID, new Date(NOW.getTime() - 3 * DAY), { updatedAt: new Date(NOW.getTime() - 3 * DAY) });
    await seedDedicatedWorkspace('ws_2');
    await markDeleted('ws_2', new Date(NOW.getTime() - 3 * DAY), { updatedAt: new Date(NOW.getTime() - 2 * DAY) });
    fake.deleteDatabase.mockRejectedValueOnce(new NeonApiError('internal error', 500));

    const result = await sweepUnfinishedTeardowns(env(), options());

    expect(result).toEqual({ due: 2, succeeded: 1, failed: 1, deferred: 0 });
    expect(await workspace()).toMatchObject({ neonProjectId: SOURCE.project, sharedProjectId: SOURCE.shard });
    expect(await shardCount()).toBe(3);
    expect(fake.deleteProject).toHaveBeenCalledWith('prj-ws_2');
    expect((await workspace('ws_2')).neonProjectId).toBeNull();
    expect(consoleSpies[2]?.mock.calls.flat().join(' ')).toContain(`deleted workspace ${WORKSPACE_ID} failed again`);
  });

  it('puts a workspace whose retry failed at the back of the queue, so it cannot starve the others', async () => {
    await markDeleted(WORKSPACE_ID, new Date(NOW.getTime() - 3 * DAY), { updatedAt: new Date(NOW.getTime() - 3 * DAY) });
    await seedDedicatedWorkspace('ws_2');
    await markDeleted('ws_2', new Date(NOW.getTime() - 3 * DAY), { updatedAt: new Date(NOW.getTime() - 2 * DAY) });
    fake.deleteDatabase.mockRejectedValue(new NeonApiError('internal error', 500));

    expect(await sweepUnfinishedTeardowns(env(), options({ batchLimit: 1 }))).toMatchObject({ due: 1, failed: 1 });
    expect((await workspace()).updatedAt).toEqual(NOW);

    expect(await sweepUnfinishedTeardowns(env(), options({ batchLimit: 1 }))).toMatchObject({ due: 1, succeeded: 1 });
    expect((await workspace('ws_2')).neonProjectId).toBeNull();
    expect((await workspace()).neonProjectId).toBe(SOURCE.project);
  });

  it(`retries at most ${TEARDOWN_BATCH_LIMIT} teardowns a run and leaves the rest for the next one`, async () => {
    for (let i = 0; i <= TEARDOWN_BATCH_LIMIT; i++) {
      await seedDedicatedWorkspace(`ws_d${i}`, { deletedAt: new Date(NOW.getTime() - 3 * DAY), isActive: false });
    }

    expect(await sweepUnfinishedTeardowns(env(), options())).toMatchObject({ due: TEARDOWN_BATCH_LIMIT, succeeded: TEARDOWN_BATCH_LIMIT });
    expect(await sweepUnfinishedTeardowns(env(), options())).toMatchObject({ due: 1, succeeded: 1 });
    expect(await sweepUnfinishedTeardowns(env(), options())).toMatchObject({ due: 0 });
  });

  it('never throws, not even when the master database fails', async () => {
    const broken = {
      select: () => {
        throw new Error('master is down');
      },
    } as unknown as MasterDatabase;

    const result = await sweepUnfinishedTeardowns(env(), { masterDb: broken, provisioning: service, now: () => NOW });

    expect(result).toEqual({ due: 0, succeeded: 0, failed: 0, deferred: 0 });
    expect(consoleSpies[2]?.mock.calls.flat().join(' ')).toContain('master is down');
  });

  it('does nothing without a Neon API key', async () => {
    await markDeleted(WORKSPACE_ID, new Date(NOW.getTime() - 3 * DAY));

    const result = await sweepUnfinishedTeardowns({} as Env, { masterDb: world.masterDb, now: () => NOW });

    expect(result).toEqual({ due: 0, succeeded: 0, failed: 0, deferred: 0 });
    expect((await workspace()).neonProjectId).toBe(SOURCE.project);
  });
});
