/**
 * Two `provisionSharedDatabase` calls for ONE workspace, as the Clerk webhook
 * and the onboard endpoint both make. Only one can claim the workspace row;
 * the other must give back what it reserved without touching the winner's
 * database or role.
 *
 * The master database is a real schema on pglite. The Neon fake keeps state
 * per branch and refuses what Neon refuses: a role or database that already
 * exists, a database whose owner role does not, and a role that still owns a
 * database.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { inspect } from 'node:util';
import * as masterSchema from '@weldsuite/db/schema/master';
import { NeonApiError } from './client';
import { DatabaseProvisioningService, type ProvisioningMasterDb } from './provisioning';
import { createMasterTestDb, type MasterTestDb } from './test/master-db';
import { FAKE_SECRET_PREFIX, createFakeNeon, createServiceWith, fakeHost, type FakeNeon } from './test/fake-neon';

const { workspaces, neonSharedProjects } = masterSchema;

const REGION = 'aws-eu-central-1';
const SHARD = 'nsp_a';
const SHARD_PROJECT = `prj-${SHARD}`;
const SHARD_BRANCH = `br-${SHARD}`;

let master: MasterTestDb;
let db: ProvisioningMasterDb;
let fake: FakeNeon;
let neonState: ReturnType<typeof statefulNeon>;
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
  neonState = statefulNeon(fake);
  service = createServiceWith(fake);
  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
  await seedShard();
  await db.insert(workspaces).values({ id: 'ws_new', clerkOrgId: 'org_ws_new', name: 'ws_new', slug: 'ws_new' });
});

afterEach(() => {
  const output = consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 6 })).join('\n');
  vi.restoreAllMocks();
  expect(output).not.toContain(FAKE_SECRET_PREFIX);
  expect(output).not.toContain('postgresql://');
});

/**
 * Make the fake's role and database calls stateful, keyed by project + branch,
 * with Neon's refusals. `beforeCreateRole` lets a test hold a call there.
 */
function statefulNeon(neon: FakeNeon) {
  const roles = new Set<string>();
  const databases = new Map<string, string>(); // database key → owner role name
  const key = (projectId: string, branchId: string, name: string) => `${projectId}/${branchId}/${name}`;
  const hooks = { beforeCreateRole: async () => {} };

  neon.createRole.mockImplementation(async (projectId, branchId, name) => {
    await hooks.beforeCreateRole();
    if (roles.has(key(projectId, branchId, name))) throw new NeonApiError(`role "${name}" already exists`, 409);
    roles.add(key(projectId, branchId, name));
    return { role: { name, password: `${FAKE_SECRET_PREFIX}${name}` }, operations: [] };
  });
  neon.createDatabase.mockImplementation(async (projectId, branchId, name, owner) => {
    if (databases.has(key(projectId, branchId, name))) throw new NeonApiError(`database "${name}" already exists`, 409);
    if (!roles.has(key(projectId, branchId, owner))) throw new NeonApiError(`role "${owner}" not found`, 404);
    databases.set(key(projectId, branchId, name), owner);
    return { database: { name }, operations: [] };
  });
  neon.getDatabase.mockImplementation(async (projectId, branchId, name) => {
    if (!databases.has(key(projectId, branchId, name))) throw new NeonApiError(`database "${name}" not found`, 404);
    return { database: { name } };
  });
  neon.deleteDatabase.mockImplementation(async (projectId, branchId, name) => {
    if (!databases.delete(key(projectId, branchId, name))) throw new NeonApiError(`database "${name}" not found`, 404);
    return [];
  });
  neon.deleteRole.mockImplementation(async (projectId, branchId, name) => {
    if (!roles.has(key(projectId, branchId, name))) throw new NeonApiError(`role "${name}" not found`, 404);
    if ([...databases.values()].includes(name)) throw new NeonApiError(`role "${name}" owns objects`, 409);
    roles.delete(key(projectId, branchId, name));
  });

  return {
    hooks,
    hasRole: (name: string) => roles.has(key(SHARD_PROJECT, SHARD_BRANCH, name)),
    /** The databases in the shard, with their owner role. */
    shardDatabases: () =>
      [...databases.entries()]
        .filter(([k]) => k.startsWith(`${SHARD_PROJECT}/${SHARD_BRANCH}/`))
        .map(([k, owner]) => ({ name: k.slice(`${SHARD_PROJECT}/${SHARD_BRANCH}/`.length), owner })),
  };
}

async function seedShard(): Promise<void> {
  await db.insert(neonSharedProjects).values({
    id: SHARD,
    neonProjectId: SHARD_PROJECT,
    neonProjectName: `shard ${SHARD}`,
    region: REGION,
    mainBranchId: SHARD_BRANCH,
    connectionHost: fakeHost(SHARD_PROJECT),
    adminRole: 'neondb_owner',
    databaseCount: 0,
    maxDatabases: 100,
    status: 'active',
  });
}

async function workspaceRow() {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, 'ws_new'));
  return row!;
}

async function databaseCount() {
  const [row] = await db.select().from(neonSharedProjects).where(eq(neonSharedProjects.id, SHARD));
  return row!.databaseCount;
}

/** The workspace row points at a database and role that exist, and the shard counts exactly that one database. */
async function expectOneLiveDatabase() {
  const row = await workspaceRow();
  expect(row).toMatchObject({ neonProjectId: SHARD_PROJECT, neonBranchId: SHARD_BRANCH, sharedProjectId: SHARD });
  expect(neonState.shardDatabases()).toEqual([{ name: row.neonDatabaseName, owner: row.neonRoleName }]);
  expect(neonState.hasRole(row.neonRoleName!)).toBe(true);
  expect(await databaseCount()).toBe(1);
  return row;
}

describe('provisionSharedDatabase: two calls for one workspace', () => {
  it('a call that starts after the workspace is provisioned leaves the database alone and gives its slot back', async () => {
    // Both calls passed the "no database yet" check; the first one finishes before the second gets going.
    const first = await service.provisionSharedDatabase(db, 'ws_new', 'New workspace');
    const second = await service.provisionSharedDatabase(db, 'ws_new', 'New workspace');

    const row = await expectOneLiveDatabase();
    expect(first).toMatchObject({ success: true, neonDatabaseName: row.neonDatabaseName });
    // The late call reports the winner's database instead of failing the signup.
    expect(second).toMatchObject({
      success: true,
      neonProjectId: SHARD_PROJECT,
      neonDatabaseName: row.neonDatabaseName,
      neonRoleName: row.neonRoleName,
      isDedicated: false,
    });
  });

  it('overlapping calls on the same shard leave exactly the winner\'s database', async () => {
    // Hold both calls at role creation until both have reserved a slot, so
    // neither has claimed the workspace row when the other creates its role.
    let arrived = 0;
    let releaseBoth!: () => void;
    const bothArrived = new Promise<void>((resolve) => { releaseBoth = resolve; });
    neonState.hooks.beforeCreateRole = async () => {
      if (++arrived === 2) releaseBoth();
      await bothArrived;
    };

    const results = await Promise.all([
      service.provisionSharedDatabase(db, 'ws_new', 'New workspace'),
      service.provisionSharedDatabase(db, 'ws_new', 'New workspace'),
    ]);

    const row = await expectOneLiveDatabase();
    for (const result of results) {
      expect(result).toMatchObject({ success: true, neonDatabaseName: row.neonDatabaseName, neonRoleName: row.neonRoleName });
    }
  });

  it('names each attempt\'s role and database uniquely, so the two never collide', async () => {
    await service.provisionSharedDatabase(db, 'ws_new', 'New workspace');
    await service.provisionSharedDatabase(db, 'ws_new', 'New workspace');

    const roles = fake.createRole.mock.calls.map((call) => call[2]);
    const databases = fake.createDatabase.mock.calls.map((call) => call[2]);
    expect(roles).toHaveLength(2);
    expect(new Set(roles).size).toBe(2);
    expect(new Set(databases).size).toBe(2);
    for (const [index, role] of roles.entries()) {
      expect(role).toMatch(/^role_ws_new_[0-9a-f]{6}$/);
      expect(databases[index]).toBe(role.replace(/^role_/, 'ws_'));
    }
    // The loser dropped its own pair: only the winner's is left.
    expect(fake.deleteDatabase.mock.calls.map((call) => call[2])).toEqual([databases[1]]);
    expect(fake.deleteRole.mock.calls.map((call) => call[2])).toEqual([roles[1]]);
  });
});
