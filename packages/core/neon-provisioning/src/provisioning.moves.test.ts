/**
 * Database-move building blocks of `DatabaseProvisioningService`
 * (prepare / release a target, rotate a password, restart a dedicated endpoint,
 * drop by coordinates), and the existing `deleteWorkspaceDatabase` /
 * `provisionSharedDatabase` / `provisionDedicatedProject` paths they were
 * refactored out of.
 *
 * The master database is a real schema on pglite, so the atomic shard / pool
 * claims and the capacity counter run as real SQL. Only the Neon REST API is
 * faked. Every test also asserts that nothing it did logged a secret or a URL.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http';
import { inspect } from 'node:util';
import * as masterSchema from '@weldsuite/db/schema/master';
import { NeonApiError } from './client';
import { DatabaseProvisioningService, type ProvisioningMasterDb } from './provisioning';
import { createMasterTestDb, type MasterTestDb } from './test/master-db';
import {
  CREATED_PROJECT,
  FAKE_SECRET_PREFIX,
  createFakeNeon,
  createServiceWith,
  fakeHost,
  type FakeNeon,
} from './test/fake-neon';

const { workspaces, neonSharedProjects, databasePool } = masterSchema;

const REGION = 'aws-eu-central-1';

let master: MasterTestDb;
let db: ProvisioningMasterDb;
let fake: FakeNeon;
let service: DatabaseProvisioningService;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeAll(async () => {
  master = await createMasterTestDb();
  db = master.db;
}, 120_000);

afterAll(async () => {
  await master.close();
});

beforeEach(async () => {
  await master.reset();
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
  // No connection string and no password, in any log line, on any path.
  expect(output).not.toContain(FAKE_SECRET_PREFIX);
  expect(output).not.toContain('postgresql://');
});

// ---------------------------------------------------------------------------
// Seeds and readers
// ---------------------------------------------------------------------------

type NewShard = typeof neonSharedProjects.$inferInsert;
type NewPoolSlot = typeof databasePool.$inferInsert;
type NewWorkspace = typeof workspaces.$inferInsert;

async function seedShard(id: string, over: Partial<NewShard> = {}): Promise<void> {
  await db.insert(neonSharedProjects).values({
    id,
    neonProjectId: `prj-${id}`,
    neonProjectName: `shard ${id}`,
    region: REGION,
    mainBranchId: `br-${id}`,
    connectionHost: fakeHost(`prj-${id}`),
    adminRole: 'neondb_owner',
    databaseCount: 0,
    maxDatabases: 100,
    status: 'active',
    ...over,
  });
}

async function seedPoolSlot(id: string, over: Partial<NewPoolSlot> = {}): Promise<void> {
  await db.insert(databasePool).values({
    id,
    kind: 'shared',
    neonProjectId: `prj-pool-${id}`,
    neonBranchId: `br-pool-${id}`,
    databaseName: `ws_pool_${id}`,
    roleName: `role_pool_${id}`,
    databaseUrl: `postgresql://role_pool_${id}:${FAKE_SECRET_PREFIX}slot-${id}@ep-pool-${id}-pooler.eu-central-1.aws.neon.tech/ws_pool_${id}?sslmode=require`,
    region: REGION,
    status: 'available',
    schemaVersion: 'v1',
    ...over,
  });
}

async function seedWorkspace(id: string, over: Partial<NewWorkspace> = {}): Promise<void> {
  await db.insert(workspaces).values({ id, clerkOrgId: `org_${id}`, name: id, slug: id, ...over });
}

async function shardRow(id: string) {
  const [row] = await db.select().from(neonSharedProjects).where(eq(neonSharedProjects.id, id));
  return row;
}

async function poolRow(id: string) {
  const [row] = await db.select().from(databasePool).where(eq(databasePool.id, id));
  return row;
}

async function workspaceRow(id: string) {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  return row;
}

const databaseCount = async (shardId: string) => (await shardRow(shardId))?.databaseCount;

const shardTarget = (workspaceId: string, extra: { shardId?: string; excludeShardId?: string } = {}) => ({
  workspaceId,
  region: REGION,
  target: { kind: 'shard' as const, ...extra },
});

// ---------------------------------------------------------------------------
// prepareMoveTarget · shard, created
// ---------------------------------------------------------------------------

describe('prepareMoveTarget: a database created in a shard', () => {
  it('creates a role and an owned database on the pinned shard and reserves its slot', async () => {
    await seedShard('nsp_a', { databaseCount: 0 });
    await seedShard('nsp_b', { databaseCount: 5 });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme', { shardId: 'nsp_b' }));

    expect(target).toMatchObject({
      kind: 'shard',
      neonProjectId: 'prj-nsp_b',
      neonBranchId: 'br-nsp_b',
      sharedProjectId: 'nsp_b',
      region: REGION,
      poolId: null,
      schemaVersion: null,
      endpointId: 'epid-prj-nsp_b',
    });
    expect(target.databaseName).toMatch(/^ws_ws_acme_[0-9a-f]{6}$/);
    expect(target.roleName).toMatch(/^role_ws_acme_[0-9a-f]{6}$/);
    expect(target.databaseName.length).toBeLessThanOrEqual(63);

    expect(fake.createRole).toHaveBeenCalledWith('prj-nsp_b', 'br-nsp_b', target.roleName);
    expect(fake.createDatabase).toHaveBeenCalledWith('prj-nsp_b', 'br-nsp_b', target.databaseName, target.roleName);
    expect(fake.waitForOperations).toHaveBeenCalledTimes(2);

    // Both URLs carry the role's password; only the pooled one goes through the pooler.
    expect(target.pooledUrl).toBe(
      `postgresql://${target.roleName}:${FAKE_SECRET_PREFIX}${target.roleName}@ep-prj-nsp_b-pooler.eu-central-1.aws.neon.tech/${target.databaseName}?sslmode=require`,
    );
    expect(target.directUrl).toBe(
      `postgresql://${target.roleName}:${FAKE_SECRET_PREFIX}${target.roleName}@ep-prj-nsp_b.eu-central-1.aws.neon.tech/${target.databaseName}?sslmode=require`,
    );

    expect(await databaseCount('nsp_b')).toBe(6);
    expect(await databaseCount('nsp_a')).toBe(0);
  });

  it('falls back to the role password API when the create response carries none', async () => {
    await seedShard('nsp_a');
    fake.createRole.mockImplementationOnce(async (_p: string, _b: string, name: string) => ({
      role: { name } as { name: string; password?: string },
      operations: [],
    }));

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme'));

    expect(fake.getRolePassword).toHaveBeenCalledWith('prj-nsp_a', 'br-nsp_a', target.roleName);
    expect(target.directUrl).toContain(`${FAKE_SECRET_PREFIX}api-${target.roleName}@`);
  });

  it('picks the emptiest shard when nothing is pinned or excluded', async () => {
    await seedShard('nsp_a', { databaseCount: 0 });
    await seedShard('nsp_b', { databaseCount: 5 });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme'));

    expect(target.sharedProjectId).toBe('nsp_a');
  });

  it('skips the excluded shard even when it has the most room', async () => {
    await seedShard('nsp_a', { databaseCount: 0 });
    await seedShard('nsp_b', { databaseCount: 5 });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme', { excludeShardId: 'nsp_a' }));

    expect(target.sharedProjectId).toBe('nsp_b');
    expect(await databaseCount('nsp_a')).toBe(0);
    expect(await databaseCount('nsp_b')).toBe(6);
  });

  it('creates a new shard when the only shard with room is the excluded one', async () => {
    await seedShard('nsp_a', { databaseCount: 0 });
    await seedShard('nsp_b', { databaseCount: 100, status: 'full' });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme', { excludeShardId: 'nsp_a' }));

    expect(fake.createProject).toHaveBeenCalledTimes(1);
    expect(target.sharedProjectId).not.toBe('nsp_a');
    expect(target.neonProjectId).toBe(CREATED_PROJECT.projectId);
    expect(await databaseCount('nsp_a')).toBe(0);
    const shards = await db.select().from(neonSharedProjects);
    expect(shards).toHaveLength(3);
    expect(shards.find((s) => s.id === target.sharedProjectId)?.databaseCount).toBe(1);
  });

  it.each([
    ['is full', { databaseCount: 100, status: 'full' as const }],
    ['is disabled', { databaseCount: 0, status: 'disabled' as const }],
    ['is in another region', { databaseCount: 0, region: 'aws-us-east-1' }],
  ])('never swaps a pinned shard that %s for a new one, and leaves every counter alone', async (_label, over) => {
    await seedShard('nsp_pinned', over);
    await seedShard('nsp_other', { databaseCount: 0 });

    await expect(
      service.prepareMoveTarget(db, shardTarget('ws_acme', { shardId: 'nsp_pinned' })),
    ).rejects.toThrow(/cannot take another database/);

    expect(fake.createProject).not.toHaveBeenCalled();
    expect(fake.createRole).not.toHaveBeenCalled();
    expect(await databaseCount('nsp_pinned')).toBe(over.databaseCount);
    expect(await databaseCount('nsp_other')).toBe(0);
  });

  it('never picks a disabled shard or one in another region', async () => {
    await seedShard('nsp_disabled', { databaseCount: 0, status: 'disabled' });
    await seedShard('nsp_elsewhere', { databaseCount: 0, region: 'aws-us-east-1' });
    await seedShard('nsp_ok', { databaseCount: 50 });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme'));

    expect(target.sharedProjectId).toBe('nsp_ok');
  });

  it('flags the shard full when the move takes its last slot', async () => {
    await seedShard('nsp_a', { databaseCount: 99, maxDatabases: 100 });

    await service.prepareMoveTarget(db, shardTarget('ws_acme', { shardId: 'nsp_a' }));

    expect(await shardRow('nsp_a')).toMatchObject({ databaseCount: 100, status: 'full' });
  });

  it('gives the slot back and drops what it created when Neon fails halfway', async () => {
    await seedShard('nsp_a', { databaseCount: 3 });
    fake.createDatabase.mockRejectedValueOnce(new NeonApiError('compute unavailable', 503));

    await expect(service.prepareMoveTarget(db, shardTarget('ws_acme'))).rejects.toThrow('compute unavailable');

    expect(await databaseCount('nsp_a')).toBe(3);
    expect(fake.deleteDatabase).toHaveBeenCalledTimes(1);
    expect(fake.deleteRole).toHaveBeenCalledTimes(1);
  });

  it('gives the slot back when the shard has no main branch recorded', async () => {
    await seedShard('nsp_a', { databaseCount: 3, mainBranchId: null });

    await expect(service.prepareMoveTarget(db, shardTarget('ws_acme'))).rejects.toThrow(/no main branch/);

    expect(await databaseCount('nsp_a')).toBe(3);
  });

  it('names databases uniquely per attempt, so a workspace can come back to a shard that still holds its old copy', async () => {
    await seedShard('nsp_a');

    const first = await service.prepareMoveTarget(db, shardTarget('ws_acme', { shardId: 'nsp_a' }));
    const second = await service.prepareMoveTarget(db, shardTarget('ws_acme', { shardId: 'nsp_a' }));

    expect(second.databaseName).not.toBe(first.databaseName);
    expect(second.roleName).not.toBe(first.roleName);
  });

  it('keeps identifiers valid for an awkward or very long workspace id', async () => {
    await seedShard('nsp_a');

    const target = await service.prepareMoveTarget(db, shardTarget(`WS-${'x'.repeat(100)}.ok`, { shardId: 'nsp_a' }));

    expect(target.databaseName).toMatch(/^ws_ws_x+_[0-9a-f]{6}$/);
    expect(target.roleName.length).toBeLessThanOrEqual(63);
  });
});

// ---------------------------------------------------------------------------
// prepareMoveTarget · warm pool slots
// ---------------------------------------------------------------------------

describe('prepareMoveTarget: a warm pool slot', () => {
  it('claims a shared slot on an eligible shard and touches neither workspaces nor the shard counter', async () => {
    await seedShard('nsp_a', { databaseCount: 3 });
    await seedShard('nsp_b', { databaseCount: 3 });
    await seedPoolSlot('dbp_a', { sharedProjectId: 'nsp_a', neonProjectId: 'prj-nsp_a', schemaVersion: 'v3' });
    await seedPoolSlot('dbp_b', { sharedProjectId: 'nsp_b', neonProjectId: 'prj-nsp_b', schemaVersion: 'v5' });
    await seedWorkspace('ws_acme', { neonProjectId: 'prj-old', neonDatabaseName: 'old_db' });
    const workspaceBefore = JSON.stringify(await workspaceRow('ws_acme'));

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme', { excludeShardId: 'nsp_b' }));

    expect(target).toMatchObject({
      kind: 'shard',
      poolId: 'dbp_a',
      schemaVersion: 'v3',
      sharedProjectId: 'nsp_a',
      neonProjectId: 'prj-nsp_a',
      neonBranchId: 'br-pool-dbp_a',
      databaseName: 'ws_pool_dbp_a',
      roleName: 'role_pool_dbp_a',
      region: REGION,
      endpointId: 'epid-prj-nsp_a',
    });
    // The slot's stored (pooled) URL is handed over as is; the direct one drops the pooler.
    const stored = (await poolRow('dbp_a'))!.databaseUrl;
    expect(target.pooledUrl).toBe(stored);
    expect(target.directUrl).toBe(stored.replace('-pooler', ''));
    expect(target.directUrl).not.toContain('-pooler');

    expect(await poolRow('dbp_a')).toMatchObject({ status: 'assigned', assignedWorkspaceId: 'ws_acme' });
    expect(await poolRow('dbp_b')).toMatchObject({ status: 'available', assignedWorkspaceId: null });
    expect(await databaseCount('nsp_a')).toBe(3);
    expect(fake.createRole).not.toHaveBeenCalled();
    expect(JSON.stringify(await workspaceRow('ws_acme'))).toBe(workspaceBefore);
  });

  it('prefers the freshest schema version among the eligible slots', async () => {
    await seedShard('nsp_a');
    await seedShard('nsp_b');
    await seedPoolSlot('dbp_a', { sharedProjectId: 'nsp_a', schemaVersion: 'v3' });
    await seedPoolSlot('dbp_b', { sharedProjectId: 'nsp_b', schemaVersion: 'v5' });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme'));

    expect(target.poolId).toBe('dbp_b');
    expect(target.schemaVersion).toBe('v5');
  });

  it('with a pinned shard only claims a slot on that shard', async () => {
    await seedShard('nsp_a');
    await seedShard('nsp_b');
    await seedPoolSlot('dbp_a', { sharedProjectId: 'nsp_a', schemaVersion: 'v9' });
    await seedPoolSlot('dbp_b', { sharedProjectId: 'nsp_b', schemaVersion: 'v1' });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme', { shardId: 'nsp_b' }));

    expect(target.poolId).toBe('dbp_b');
    expect(await poolRow('dbp_a')).toMatchObject({ status: 'available' });
  });

  it('ignores slots on a full, disabled or foreign-region shard and creates a database instead', async () => {
    await seedShard('nsp_full', { databaseCount: 100, status: 'full' });
    await seedShard('nsp_disabled', { status: 'disabled' });
    await seedShard('nsp_elsewhere', { region: 'aws-us-east-1' });
    await seedShard('nsp_ok', { databaseCount: 10 });
    await seedPoolSlot('dbp_full', { sharedProjectId: 'nsp_full' });
    await seedPoolSlot('dbp_disabled', { sharedProjectId: 'nsp_disabled' });
    await seedPoolSlot('dbp_elsewhere', { sharedProjectId: 'nsp_elsewhere' });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme'));

    expect(target.poolId).toBeNull();
    expect(target.sharedProjectId).toBe('nsp_ok');
    for (const id of ['dbp_full', 'dbp_disabled', 'dbp_elsewhere']) {
      expect(await poolRow(id)).toMatchObject({ status: 'available', assignedWorkspaceId: null });
    }
  });

  it('never claims a dedicated slot for a shard target, nor a shared one for a dedicated target', async () => {
    await seedShard('nsp_a');
    await seedPoolSlot('dbp_dedicated', { kind: 'dedicated', sharedProjectId: null, neonProjectId: 'prj-pool-d' });
    await seedPoolSlot('dbp_shared', { kind: 'shared', sharedProjectId: 'nsp_a' });

    const shard = await service.prepareMoveTarget(db, shardTarget('ws_acme', { shardId: 'nsp_a' }));
    expect(shard.poolId).toBe('dbp_shared');

    const dedicated = await service.prepareMoveTarget(db, { workspaceId: 'ws_acme', region: REGION, target: { kind: 'dedicated' } });
    expect(dedicated.poolId).toBe('dbp_dedicated');
  });

  it('hands the slot back untouched when it cannot be described', async () => {
    await seedShard('nsp_a');
    await seedPoolSlot('dbp_a', { sharedProjectId: 'nsp_a' });
    fake.getEndpoint.mockRejectedValueOnce(new NeonApiError('endpoint lookup failed', 500));

    await expect(service.prepareMoveTarget(db, shardTarget('ws_acme'))).rejects.toThrow('endpoint lookup failed');

    expect(await poolRow('dbp_a')).toMatchObject({ status: 'available', assignedWorkspaceId: null, assignedAt: null });
  });

  it('looks up the main branch when the slot has none recorded', async () => {
    await seedShard('nsp_a');
    await seedPoolSlot('dbp_a', { sharedProjectId: 'nsp_a', neonBranchId: null });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme'));

    expect(target.neonBranchId).toBe('br-main');
  });
});

// ---------------------------------------------------------------------------
// prepareMoveTarget · dedicated
// ---------------------------------------------------------------------------

describe('prepareMoveTarget: a dedicated project', () => {
  const dedicated = (workspaceId: string, region = REGION) => ({
    workspaceId,
    region,
    target: { kind: 'dedicated' as const },
  });

  it('claims a warm dedicated slot in the region', async () => {
    await seedPoolSlot('dbp_d1', { kind: 'dedicated', sharedProjectId: null, neonProjectId: 'prj-pool-d1', schemaVersion: 'v2' });
    await seedPoolSlot('dbp_far', { kind: 'dedicated', sharedProjectId: null, neonProjectId: 'prj-pool-far', region: 'aws-us-east-1' });

    const target = await service.prepareMoveTarget(db, dedicated('ws_acme'));

    expect(target).toMatchObject({
      kind: 'dedicated',
      poolId: 'dbp_d1',
      schemaVersion: 'v2',
      sharedProjectId: null,
      neonProjectId: 'prj-pool-d1',
      neonBranchId: 'br-pool-dbp_d1',
      endpointId: 'epid-prj-pool-d1',
    });
    expect(await poolRow('dbp_d1')).toMatchObject({ status: 'assigned', assignedWorkspaceId: 'ws_acme' });
    expect(await poolRow('dbp_far')).toMatchObject({ status: 'available' });
    expect(fake.createProject).not.toHaveBeenCalled();
  });

  it('creates a weldsuite-<workspace> project with the dedicated compute settings when no slot fits', async () => {
    const workspaceId = 'ws_0123456789abcdefghijklmnop';

    const target = await service.prepareMoveTarget(db, dedicated(workspaceId));

    expect(fake.createProject).toHaveBeenCalledTimes(1);
    const [name, region, options] = fake.createProject.mock.calls[0]!;
    expect(name).toBe('weldsuite-ws_0123456789abcdefg');
    expect(name.startsWith('weldsuite-pool-')).toBe(false);
    expect(region).toBe(REGION);
    expect(options).toEqual({ autoscalingLimitMinCu: 0.25, autoscalingLimitMaxCu: 0.5 });

    expect(target).toMatchObject({
      kind: 'dedicated',
      neonProjectId: CREATED_PROJECT.projectId,
      neonBranchId: CREATED_PROJECT.branchId,
      databaseName: 'neondb',
      roleName: CREATED_PROJECT.roleName,
      sharedProjectId: null,
      region: REGION,
      poolId: null,
      schemaVersion: null,
      endpointId: CREATED_PROJECT.endpointId,
    });
    expect(target.pooledUrl).toBe(
      `postgresql://neondb_owner:${FAKE_SECRET_PREFIX}neondb_owner@ep-created-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require`,
    );
    expect(target.directUrl).toBe(
      `postgresql://neondb_owner:${FAKE_SECRET_PREFIX}neondb_owner@ep-created.eu-central-1.aws.neon.tech/neondb?sslmode=require`,
    );
  });

  it('creates the project in the requested region, not the default one', async () => {
    const target = await service.prepareMoveTarget(db, dedicated('ws_acme', 'aws-us-east-1'));

    expect(fake.createProject.mock.calls[0]![1]).toBe('aws-us-east-1');
    expect(target.region).toBe('aws-us-east-1');
  });

  it('asks the API for the password when the create response has no connection URI', async () => {
    const original = await fake.createProject('x', REGION);
    fake.createProject.mockResolvedValueOnce({ ...original, connection_uris: [] });

    const target = await service.prepareMoveTarget(db, dedicated('ws_acme'));

    expect(fake.getRolePassword).toHaveBeenCalledWith(CREATED_PROJECT.projectId, CREATED_PROJECT.branchId, CREATED_PROJECT.roleName);
    expect(target.directUrl).toContain(`${FAKE_SECRET_PREFIX}api-neondb_owner@`);
  });

  it('deletes a project it created but cannot use', async () => {
    const original = await fake.createProject('x', REGION);
    fake.createProject.mockResolvedValueOnce({ ...original, endpoints: [] });

    await expect(service.prepareMoveTarget(db, dedicated('ws_acme'))).rejects.toThrow(/did not return expected resources/);

    expect(fake.deleteProject).toHaveBeenCalledWith(CREATED_PROJECT.projectId);
  });
});

// ---------------------------------------------------------------------------
// prepareMoveTarget never writes the workspaces row
// ---------------------------------------------------------------------------

describe('prepareMoveTarget does not write the workspaces row', () => {
  it('leaves the workspace exactly as it was, on every path', async () => {
    await seedShard('nsp_a', { databaseCount: 1 });
    await seedShard('nsp_b', { databaseCount: 1 });
    await seedWorkspace('ws_acme', {
      neonProjectId: 'prj-nsp_a',
      neonBranchId: 'br-nsp_a',
      neonDatabaseName: 'ws_ws_acme',
      neonRoleName: 'role_ws_acme',
      sharedProjectId: 'nsp_a',
      neonRegion: REGION,
    });
    const before = JSON.stringify(await workspaceRow('ws_acme'));
    const dedicated = { workspaceId: 'ws_acme', region: REGION, target: { kind: 'dedicated' as const } };

    await service.prepareMoveTarget(db, dedicated); // create a project
    await service.prepareMoveTarget(db, shardTarget('ws_acme', { excludeShardId: 'nsp_a' })); // create in a shard
    await seedPoolSlot('dbp_s', { sharedProjectId: 'nsp_b' });
    await seedPoolSlot('dbp_d', { kind: 'dedicated', sharedProjectId: null });
    await service.prepareMoveTarget(db, shardTarget('ws_acme', { excludeShardId: 'nsp_a' })); // claim a shared slot
    await service.prepareMoveTarget(db, dedicated); // claim a dedicated slot

    expect(JSON.stringify(await workspaceRow('ws_acme'))).toBe(before);
    expect(await poolRow('dbp_s')).toMatchObject({ status: 'assigned', assignedWorkspaceId: 'ws_acme' });
    expect(await poolRow('dbp_d')).toMatchObject({ status: 'assigned', assignedWorkspaceId: 'ws_acme' });
  });
});

// ---------------------------------------------------------------------------
// releaseMoveTarget
// ---------------------------------------------------------------------------

describe('releaseMoveTarget', () => {
  const shardCoords = {
    kind: 'shard' as const,
    neonProjectId: 'prj-nsp_a',
    neonBranchId: 'br-nsp_a',
    databaseName: 'ws_x',
    roleName: 'role_x',
    sharedProjectId: 'nsp_a',
  };

  it('drops a shard target, gives its slot back and deletes the pool row it came from', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });
    await seedPoolSlot('dbp_x', { status: 'assigned', assignedWorkspaceId: 'ws_acme', sharedProjectId: 'nsp_a' });

    await service.releaseMoveTarget(db, { ...shardCoords, poolId: 'dbp_x' });

    expect(fake.deleteDatabase).toHaveBeenCalledWith('prj-nsp_a', 'br-nsp_a', 'ws_x');
    expect(fake.deleteRole).toHaveBeenCalledWith('prj-nsp_a', 'br-nsp_a', 'role_x');
    expect(fake.deleteProject).not.toHaveBeenCalled();
    expect(await databaseCount('nsp_a')).toBe(3);
    expect(await poolRow('dbp_x')).toBeUndefined();
  });

  it('releases a freshly created target (no pool row) without touching the pool', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });
    await seedPoolSlot('dbp_other', { status: 'assigned', assignedWorkspaceId: 'ws_acme', sharedProjectId: 'nsp_a' });

    await service.releaseMoveTarget(db, { ...shardCoords, poolId: null });

    expect(await databaseCount('nsp_a')).toBe(3);
    expect(await poolRow('dbp_other')).toBeDefined();
  });

  it('deletes the whole project of a dedicated target and its pool row', async () => {
    await seedPoolSlot('dbp_d', { kind: 'dedicated', status: 'assigned', assignedWorkspaceId: 'ws_acme', sharedProjectId: null });

    await service.releaseMoveTarget(db, {
      kind: 'dedicated',
      neonProjectId: 'prj-dedicated',
      neonBranchId: 'br-d',
      databaseName: 'neondb',
      roleName: 'neondb_owner',
      sharedProjectId: null,
      poolId: 'dbp_d',
    });

    expect(fake.deleteProject).toHaveBeenCalledWith('prj-dedicated');
    expect(fake.deleteDatabase).not.toHaveBeenCalled();
    expect(fake.deleteRole).not.toHaveBeenCalled();
    expect(await poolRow('dbp_d')).toBeUndefined();
  });

  it('is safe to run again: a second run finds everything gone and counts nothing', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });
    await service.releaseMoveTarget(db, shardCoords);
    expect(await databaseCount('nsp_a')).toBe(3);

    fake.deleteDatabase.mockRejectedValueOnce(new NeonApiError('database not found', 404));
    fake.deleteRole.mockRejectedValueOnce(new NeonApiError('role not found', 404));
    await expect(service.releaseMoveTarget(db, shardCoords)).resolves.toBeUndefined();

    expect(await databaseCount('nsp_a')).toBe(3);
  });

  it('does not count back a database Neon no longer has, even though it would accept the delete', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });
    fake.getDatabase.mockRejectedValueOnce(new NeonApiError('database not found', 404));

    await service.releaseMoveTarget(db, shardCoords);

    expect(fake.deleteDatabase).not.toHaveBeenCalled();
    expect(fake.deleteRole).toHaveBeenCalledTimes(1);
    expect(await databaseCount('nsp_a')).toBe(4);
  });

  it('waits for the database delete to finish before deleting the role that owns it', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });

    await service.releaseMoveTarget(db, shardCoords);

    const deleted = fake.deleteDatabase.mock.invocationCallOrder[0]!;
    const waited = fake.waitForOperations.mock.invocationCallOrder.find((order) => order > deleted);
    expect(waited).toBeDefined();
    expect(fake.deleteRole.mock.invocationCallOrder[0]!).toBeGreaterThan(waited!);
    expect(await databaseCount('nsp_a')).toBe(3);
  });

  it('finishes a half-done release: the database is gone, the role is not', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });
    fake.deleteDatabase.mockRejectedValueOnce(new NeonApiError('database not found', 404));

    await service.releaseMoveTarget(db, shardCoords);

    expect(fake.deleteRole).toHaveBeenCalledTimes(1);
    expect(await databaseCount('nsp_a')).toBe(4);
  });

  it('surfaces a Neon failure other than "already gone"', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });
    fake.deleteDatabase.mockRejectedValueOnce(new NeonApiError('Neon is unavailable', 503));

    await expect(service.releaseMoveTarget(db, shardCoords)).rejects.toThrow('Neon is unavailable');

    expect(await databaseCount('nsp_a')).toBe(4);
    expect(fake.deleteRole).not.toHaveBeenCalled();
  });

  it('refuses a kind that disagrees with the shard id, before deleting anything', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });

    await expect(service.releaseMoveTarget(db, { ...shardCoords, sharedProjectId: null })).rejects.toThrow(/needs its shard id/);
    await expect(service.releaseMoveTarget(db, { ...shardCoords, kind: 'dedicated' })).rejects.toThrow(/must not carry a shard id/);

    expect(fake.deleteProject).not.toHaveBeenCalled();
    expect(fake.deleteDatabase).not.toHaveBeenCalled();
    expect(await databaseCount('nsp_a')).toBe(4);
  });

  it('refuses to delete a shard as if it were a dedicated project', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });

    await expect(
      service.releaseMoveTarget(db, { ...shardCoords, kind: 'dedicated', sharedProjectId: null }),
    ).rejects.toThrow(/shared shard/);

    expect(fake.deleteProject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Shard capacity counter
// ---------------------------------------------------------------------------

describe('shard capacity counter', () => {
  const release = (shardId: string) =>
    service.releaseMoveTarget(db, {
      kind: 'shard',
      neonProjectId: `prj-${shardId}`,
      neonBranchId: `br-${shardId}`,
      databaseName: 'ws_x',
      roleName: 'role_x',
      sharedProjectId: shardId,
    });

  it('never goes below zero', async () => {
    await seedShard('nsp_a', { databaseCount: 0 });

    await release('nsp_a');
    await service.releaseShardCapacity(db, 'nsp_a');

    expect(await databaseCount('nsp_a')).toBe(0);
  });

  it('does not reactivate a disabled shard', async () => {
    await seedShard('nsp_a', { databaseCount: 3, status: 'disabled' });

    await release('nsp_a');
    expect(await shardRow('nsp_a')).toMatchObject({ databaseCount: 2, status: 'disabled' });

    await service.releaseShardCapacity(db, 'nsp_a');
    expect(await shardRow('nsp_a')).toMatchObject({ databaseCount: 1, status: 'disabled' });
  });

  it('reopens a full shard that now has room', async () => {
    await seedShard('nsp_a', { databaseCount: 100, maxDatabases: 100, status: 'full' });

    await release('nsp_a');

    expect(await shardRow('nsp_a')).toMatchObject({ databaseCount: 99, status: 'active' });
  });

  it('keeps an active shard active', async () => {
    await seedShard('nsp_a', { databaseCount: 10, status: 'active' });

    await release('nsp_a');

    expect(await shardRow('nsp_a')).toMatchObject({ databaseCount: 9, status: 'active' });
  });

  it('takes a slot and gives it back without changing the shard', async () => {
    await seedShard('nsp_a', { databaseCount: 1, maxDatabases: 2 });

    const target = await service.prepareMoveTarget(db, shardTarget('ws_acme', { shardId: 'nsp_a' }));
    expect(await shardRow('nsp_a')).toMatchObject({ databaseCount: 2, status: 'full' });

    await service.releaseMoveTarget(db, target);
    expect(await shardRow('nsp_a')).toMatchObject({ databaseCount: 1, status: 'active' });
  });
});

// ---------------------------------------------------------------------------
// dropDatabaseAt
// ---------------------------------------------------------------------------

describe('dropDatabaseAt', () => {
  const shardDb = {
    neonProjectId: 'prj-nsp_a',
    neonBranchId: 'br-nsp_a',
    databaseName: 'ws_x',
    roleName: 'role_x',
    sharedProjectId: 'nsp_a',
  };

  it('deletes only the pool row it is given, not the workspace\'s other pool rows', async () => {
    await seedShard('nsp_a', { databaseCount: 2 });
    await seedPoolSlot('dbp_old', { status: 'assigned', assignedWorkspaceId: 'ws_acme', sharedProjectId: 'nsp_a' });
    await seedPoolSlot('dbp_new', { status: 'assigned', assignedWorkspaceId: 'ws_acme', sharedProjectId: 'nsp_a' });

    await service.dropDatabaseAt(db, { ...shardDb, poolId: 'dbp_old' });

    expect(await poolRow('dbp_old')).toBeUndefined();
    expect(await poolRow('dbp_new')).toBeDefined();
    expect(await databaseCount('nsp_a')).toBe(1);
  });

  it('by default a missing database is an error and nothing is counted', async () => {
    await seedShard('nsp_a', { databaseCount: 2 });
    fake.deleteDatabase.mockRejectedValueOnce(new NeonApiError('database not found', 404));

    await expect(service.dropDatabaseAt(db, shardDb)).rejects.toThrow('database not found');

    expect(await databaseCount('nsp_a')).toBe(2);
    expect(fake.deleteRole).not.toHaveBeenCalled();
  });

  it('with ignoreMissing, a database that is already gone is not counted again but its role is still dropped', async () => {
    await seedShard('nsp_a', { databaseCount: 2 });
    fake.deleteDatabase.mockRejectedValueOnce(new NeonApiError('database not found', 404));

    await service.dropDatabaseAt(db, shardDb, { ignoreMissing: true });

    expect(await databaseCount('nsp_a')).toBe(2);
    expect(fake.deleteRole).toHaveBeenCalledTimes(1);
  });

  it('with ignoreMissing, other Neon errors still surface', async () => {
    await seedShard('nsp_a', { databaseCount: 2 });
    fake.deleteDatabase.mockRejectedValueOnce(new NeonApiError('internal error', 500));

    await expect(service.dropDatabaseAt(db, shardDb, { ignoreMissing: true })).rejects.toThrow('internal error');

    expect(await databaseCount('nsp_a')).toBe(2);
  });

  it('counts the slot back before dropping the role, so a role failure does not lose the count', async () => {
    await seedShard('nsp_a', { databaseCount: 2 });
    fake.deleteRole.mockRejectedValueOnce(new NeonApiError('role busy', 503));

    await expect(service.dropDatabaseAt(db, shardDb)).rejects.toThrow('role busy');

    expect(await databaseCount('nsp_a')).toBe(1);
  });

  it('deletes a dedicated project, and tolerates it being gone with ignoreMissing', async () => {
    await service.dropDatabaseAt(db, { neonProjectId: 'prj-dedicated' });
    expect(fake.deleteProject).toHaveBeenCalledWith('prj-dedicated');

    fake.deleteProject.mockRejectedValueOnce(new NeonApiError('project not found', 404));
    await expect(service.dropDatabaseAt(db, { neonProjectId: 'prj-dedicated' }, { ignoreMissing: true })).resolves.toBeUndefined();

    fake.deleteProject.mockRejectedValueOnce(new NeonApiError('project not found', 404));
    await expect(service.dropDatabaseAt(db, { neonProjectId: 'prj-dedicated' })).rejects.toThrow('project not found');
  });

  it('never deletes a shard\'s project as a dedicated one', async () => {
    await seedShard('nsp_a', { databaseCount: 2 });

    await expect(service.dropDatabaseAt(db, { neonProjectId: 'prj-nsp_a' })).rejects.toThrow(/shared shard/);

    expect(fake.deleteProject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// restartDedicatedEndpoint
// ---------------------------------------------------------------------------

describe('restartDedicatedEndpoint', () => {
  it('refuses a shard project without calling Neon at all', async () => {
    await seedShard('nsp_a');

    await expect(service.restartDedicatedEndpoint(db, 'prj-nsp_a')).rejects.toThrow(/shared shard/);

    expect(fake.listEndpoints).not.toHaveBeenCalled();
    expect(fake.restartEndpoint).not.toHaveBeenCalled();
  });

  it('restarts the read-write endpoint of a dedicated project and waits for the operations', async () => {
    const operations = [{ id: 'op-restart', action: 'suspend_compute', status: 'running' }];
    fake.listEndpoints.mockResolvedValueOnce({
      endpoints: [
        { id: 'ep-ro', host: 'ro', type: 'read_only' as const },
        { id: 'ep-rw', host: 'rw', type: 'read_write' as const },
      ],
    });
    fake.restartEndpoint.mockResolvedValueOnce(operations);

    await service.restartDedicatedEndpoint(db, 'prj-dedicated');

    expect(fake.restartEndpoint).toHaveBeenCalledTimes(1);
    expect(fake.restartEndpoint).toHaveBeenCalledWith('prj-dedicated', 'ep-rw');
    expect(fake.waitForOperations).toHaveBeenCalledWith('prj-dedicated', operations);
  });

  it('fails when the project has no read-write endpoint', async () => {
    fake.listEndpoints.mockResolvedValueOnce({ endpoints: [{ id: 'ep-ro', host: 'ro', type: 'read_only' as const }] });

    await expect(service.restartDedicatedEndpoint(db, 'prj-dedicated')).rejects.toMatchObject({
      name: 'NeonApiError',
      status: 404,
    });
    expect(fake.restartEndpoint).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// rotateRolePassword
// ---------------------------------------------------------------------------

describe('rotateRolePassword', () => {
  const coords = {
    neonProjectId: 'prj-nsp_a',
    neonBranchId: 'br-nsp_a',
    roleName: 'role_x',
    databaseName: 'ws_x',
    sharedProjectId: 'nsp_a',
  };

  it('resets the password, waits for it to apply, and returns URLs with the new password', async () => {
    const urls = await service.rotateRolePassword(coords);

    expect(fake.resetRolePassword).toHaveBeenCalledWith('prj-nsp_a', 'br-nsp_a', 'role_x');
    expect(fake.waitForOperations).toHaveBeenCalledTimes(1);
    expect(urls.pooledUrl).toBe(
      `postgresql://role_x:${FAKE_SECRET_PREFIX}rotated-role_x@ep-prj-nsp_a-pooler.eu-central-1.aws.neon.tech/ws_x?sslmode=require`,
    );
    expect(urls.directUrl).toBe(
      `postgresql://role_x:${FAKE_SECRET_PREFIX}rotated-role_x@ep-prj-nsp_a.eu-central-1.aws.neon.tech/ws_x?sslmode=require`,
    );
    // Resolved before the reset (so a lookup failure cannot burn the password), waited on after.
    const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0]!;
    expect(order(fake.getEndpoint)).toBeLessThan(order(fake.resetRolePassword));
    expect(order(fake.resetRolePassword)).toBeLessThan(order(fake.waitForOperations));
  });

  it('does not reset anything when the endpoint cannot be resolved', async () => {
    fake.getEndpoint.mockRejectedValueOnce(new NeonApiError('endpoint not found', 404));

    await expect(service.rotateRolePassword(coords)).rejects.toThrow('endpoint not found');

    expect(fake.resetRolePassword).not.toHaveBeenCalled();
  });

  it('does not return URLs when Neon fails to apply the new password', async () => {
    fake.waitForOperations.mockRejectedValueOnce(new NeonApiError('Timed out waiting for Neon operation', 504));

    await expect(service.rotateRolePassword(coords)).rejects.toThrow(/Timed out/);
  });
});

// ---------------------------------------------------------------------------
// deleteWorkspaceDatabase keeps behaving as before
// ---------------------------------------------------------------------------

describe('deleteWorkspaceDatabase', () => {
  const sharedWorkspace = {
    neonProjectId: 'prj-nsp_a',
    neonBranchId: 'br-nsp_a',
    neonDatabaseName: 'ws_ws_acme',
    neonRoleName: 'role_ws_acme',
    sharedProjectId: 'nsp_a',
    neonRegion: REGION,
    databaseProvisionedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('drops a shared workspace\'s database and role, counts the slot back, clears the row and its pool rows', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });
    await seedWorkspace('ws_acme', sharedWorkspace);
    await seedPoolSlot('dbp_1', { status: 'assigned', assignedWorkspaceId: 'ws_acme', sharedProjectId: 'nsp_a' });
    await seedPoolSlot('dbp_2', { status: 'assigned', assignedWorkspaceId: 'ws_acme', sharedProjectId: 'nsp_a' });
    await seedPoolSlot('dbp_other', { status: 'assigned', assignedWorkspaceId: 'ws_other', sharedProjectId: 'nsp_a' });

    const result = await service.deleteWorkspaceDatabase(db, 'ws_acme');

    expect(result).toEqual({ success: true });
    expect(fake.deleteDatabase).toHaveBeenCalledWith('prj-nsp_a', 'br-nsp_a', 'ws_ws_acme');
    expect(fake.deleteRole).toHaveBeenCalledWith('prj-nsp_a', 'br-nsp_a', 'role_ws_acme');
    expect(fake.deleteProject).not.toHaveBeenCalled();
    expect(await databaseCount('nsp_a')).toBe(3);
    expect(await workspaceRow('ws_acme')).toMatchObject({
      neonProjectId: null,
      neonDatabaseName: null,
      neonBranchId: null,
      neonRoleName: null,
      sharedProjectId: null,
      databaseProvisionedAt: null,
    });
    expect(await poolRow('dbp_1')).toBeUndefined();
    expect(await poolRow('dbp_2')).toBeUndefined();
    expect(await poolRow('dbp_other')).toBeDefined();
  });

  it('deletes a dedicated workspace\'s whole project', async () => {
    await seedWorkspace('ws_acme', {
      neonProjectId: 'prj-dedicated',
      neonBranchId: 'br-d',
      neonDatabaseName: 'neondb',
      neonRoleName: 'neondb_owner',
      databaseProvisionedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = await service.deleteWorkspaceDatabase(db, 'ws_acme');

    expect(result).toEqual({ success: true });
    expect(fake.deleteProject).toHaveBeenCalledWith('prj-dedicated');
    expect(fake.deleteDatabase).not.toHaveBeenCalled();
    expect(await workspaceRow('ws_acme')).toMatchObject({ neonProjectId: null, databaseProvisionedAt: null });
  });

  it('succeeds without calling Neon when the workspace has no database', async () => {
    await seedWorkspace('ws_acme');

    expect(await service.deleteWorkspaceDatabase(db, 'ws_acme')).toEqual({ success: true });
    expect(await service.deleteWorkspaceDatabase(db, 'ws_missing')).toEqual({ success: true });

    expect(fake.deleteProject).not.toHaveBeenCalled();
    expect(fake.deleteDatabase).not.toHaveBeenCalled();
  });

  it('reports a Neon failure and leaves the workspace row and the counter alone', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });
    await seedWorkspace('ws_acme', sharedWorkspace);
    fake.deleteDatabase.mockRejectedValueOnce(new NeonApiError('Neon is unavailable', 503));

    const result = await service.deleteWorkspaceDatabase(db, 'ws_acme');

    expect(result).toEqual({ success: false, error: 'Neon is unavailable' });
    expect(await databaseCount('nsp_a')).toBe(4);
    expect(await workspaceRow('ws_acme')).toMatchObject({ neonProjectId: 'prj-nsp_a', sharedProjectId: 'nsp_a' });
  });

  it('does not reactivate a disabled shard', async () => {
    await seedShard('nsp_a', { databaseCount: 4, status: 'disabled' });
    await seedWorkspace('ws_acme', sharedWorkspace);

    await service.deleteWorkspaceDatabase(db, 'ws_acme');

    expect(await shardRow('nsp_a')).toMatchObject({ databaseCount: 3, status: 'disabled' });
  });

  it('reopens a full shard', async () => {
    await seedShard('nsp_a', { databaseCount: 100, maxDatabases: 100, status: 'full' });
    await seedWorkspace('ws_acme', sharedWorkspace);

    await service.deleteWorkspaceDatabase(db, 'ws_acme');

    expect(await shardRow('nsp_a')).toMatchObject({ databaseCount: 99, status: 'active' });
  });

  it('refuses to delete a project that is a shard even when the workspace row lost its shard id', async () => {
    await seedShard('nsp_a', { databaseCount: 4 });
    await seedWorkspace('ws_acme', { ...sharedWorkspace, sharedProjectId: null });

    const result = await service.deleteWorkspaceDatabase(db, 'ws_acme');

    expect(result.success).toBe(false);
    expect(fake.deleteProject).not.toHaveBeenCalled();
    expect(await workspaceRow('ws_acme')).toMatchObject({ neonProjectId: 'prj-nsp_a' });
  });
});

// ---------------------------------------------------------------------------
// The paths the move helpers were refactored out of still behave
// ---------------------------------------------------------------------------

describe('existing provisioning paths', () => {
  it('provisionSharedDatabase still claims the emptiest shard and records the database on the workspace', async () => {
    await seedShard('nsp_a', { databaseCount: 0 });
    await seedShard('nsp_b', { databaseCount: 5 });
    await seedWorkspace('ws_new');

    const result = await service.provisionSharedDatabase(db, 'ws_new', 'New workspace');

    expect(result).toMatchObject({ success: true, isDedicated: false, neonProjectId: 'prj-nsp_a', neonDatabaseName: 'ws_ws_new' });
    expect(fake.createRole).toHaveBeenCalledWith('prj-nsp_a', 'br-nsp_a', 'role_ws_new');
    expect(fake.createDatabase).toHaveBeenCalledWith('prj-nsp_a', 'br-nsp_a', 'ws_ws_new', 'role_ws_new');
    expect(await databaseCount('nsp_a')).toBe(1);
    expect(await workspaceRow('ws_new')).toMatchObject({
      neonProjectId: 'prj-nsp_a',
      neonDatabaseName: 'ws_ws_new',
      neonRoleName: 'role_ws_new',
      sharedProjectId: 'nsp_a',
    });
  });

  it('provisionSharedDatabase still releases its slot when Neon fails', async () => {
    await seedShard('nsp_a', { databaseCount: 2 });
    await seedWorkspace('ws_new');
    fake.createDatabase.mockRejectedValueOnce(new NeonApiError('compute unavailable', 503));

    const result = await service.provisionSharedDatabase(db, 'ws_new', 'New workspace');

    expect(result).toMatchObject({ success: false, error: 'compute unavailable' });
    expect(await databaseCount('nsp_a')).toBe(2);
    expect(await workspaceRow('ws_new')).toMatchObject({ neonProjectId: null });
  });

  it('provisionDedicatedProject still names the project weldsuite-<workspace prefix>', async () => {
    await seedWorkspace('ws_0123456789abcdefghijklmnop');

    const result = await service.provisionDedicatedProject(db, 'ws_0123456789abcdefghijklmnop', 'New workspace');

    expect(result).toMatchObject({ success: true, isDedicated: true, neonProjectId: CREATED_PROJECT.projectId });
    expect(fake.createProject.mock.calls[0]![0]).toBe('weldsuite-ws_0123456789abcdefg');
    expect(await workspaceRow('ws_0123456789abcdefghijklmnop')).toMatchObject({ neonProjectId: CREATED_PROJECT.projectId, sharedProjectId: null });
  });
});

// ---------------------------------------------------------------------------
// Type contract
// ---------------------------------------------------------------------------

describe('type contract', () => {
  it('accepts a neon-http master database, which is what the workspace worker passes', () => {
    // Compile-time only: never called.
    const accepts = (neonHttpDb: NeonHttpDatabase<typeof masterSchema>) =>
      service.prepareMoveTarget(neonHttpDb, { workspaceId: 'ws_x', region: REGION, target: { kind: 'dedicated' } });
    expect(typeof accepts).toBe('function');
  });
});
