/**
 * The master query behind tenant resolution, run on a real master schema
 * (pglite): does a workspace have a database move in a write-blocking status?
 * The mocked `db.test.ts` checks what the kit does with the answer; this checks
 * that the EXISTS subquery gives the right one.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import * as masterSchema from '@weldsuite/db/schema/master';
import type { DatabaseMoveStatus } from '@weldsuite/db/schema/master';
import { selectWorkspaceForRef, type AnyMasterDatabase } from './db';
import { createMasterPgliteDb } from './testing/pglite';

const { workspaces, workspaceDatabaseMoves } = masterSchema;

let db: AnyMasterDatabase;
let seq = 0;

beforeAll(async () => {
  db = (await createMasterPgliteDb()).db as AnyMasterDatabase;
}, 60_000);

async function seedWorkspace(): Promise<{ id: string; orgId: string }> {
  seq += 1;
  const id = `ws_mv_${seq}`;
  const orgId = `org_mv_${seq}`;
  await db.insert(workspaces).values({
    id,
    clerkOrgId: orgId,
    name: `Workspace ${seq}`,
    slug: `ws-mv-${seq}`,
    neonProjectId: 'proj_1',
    neonBranchId: 'br_1',
    neonRoleName: 'tenant_role',
    neonDatabaseName: 'tenant_db',
  });
  return { id, orgId };
}

async function seedMove(workspaceId: string, status: DatabaseMoveStatus): Promise<void> {
  seq += 1;
  await db.insert(workspaceDatabaseMoves).values({
    id: `dbm_mv_${seq}`,
    workspaceId,
    kind: 'shard_to_dedicated',
    status,
    requestedTarget: 'dedicated',
    sourceNeonProjectId: 'proj_1',
    sourceNeonBranchId: 'br_1',
    sourceDatabaseName: 'tenant_db',
    sourceRoleName: 'tenant_role',
    startedBy: 'admin@weldsuite.org',
  });
}

async function isMoving(orgId: string): Promise<boolean | undefined> {
  const row = await selectWorkspaceForRef(db, orgId);
  return row?.databaseMoveInProgress;
}

describe('selectWorkspaceForRef · databaseMoveInProgress', () => {
  it.each(['soft_locked', 'locked', 'copying', 'verifying', 'switching', 'cancelling'] as const)(
    'is true while a move is %s',
    async (status) => {
      const { id, orgId } = await seedWorkspace();
      await seedMove(id, status);
      expect(await isMoving(orgId)).toBe(true);
    },
  );

  it.each(['queued', 'preparing', 'completed', 'failed', 'cancelled'] as const)(
    'is false while a move is %s: writes are not blocked yet, or any more',
    async (status) => {
      const { id, orgId } = await seedWorkspace();
      await seedMove(id, status);
      expect(await isMoving(orgId)).toBe(false);
    },
  );

  it('is false for a workspace that never moved', async () => {
    const { orgId } = await seedWorkspace();
    expect(await isMoving(orgId)).toBe(false);
  });

  it('is not set by another workspace\'s move', async () => {
    const mover = await seedWorkspace();
    const bystander = await seedWorkspace();
    await seedMove(mover.id, 'copying');
    expect(await isMoving(mover.orgId)).toBe(true);
    expect(await isMoving(bystander.orgId)).toBe(false);
  });

  it('reads the workspace id, never the Clerk org id, off the move row', async () => {
    const { orgId } = await seedWorkspace();
    // A move filed under the org id is nobody's: the column holds ws_… ids.
    await seedMove(orgId, 'locked');
    expect(await isMoving(orgId)).toBe(false);
  });

  it('sees the active move through the history of earlier ones', async () => {
    const { id, orgId } = await seedWorkspace();
    await seedMove(id, 'failed');
    await seedMove(id, 'completed');
    expect(await isMoving(orgId)).toBe(false);
    await seedMove(id, 'soft_locked');
    expect(await isMoving(orgId)).toBe(true);
  });

  it('still returns the workspace columns resolution needs, and nothing for an unknown org', async () => {
    const { id, orgId } = await seedWorkspace();
    expect(await selectWorkspaceForRef(db, orgId)).toMatchObject({
      id,
      neonProjectId: 'proj_1',
      neonBranchId: 'br_1',
      neonRoleName: 'tenant_role',
      neonDatabaseName: 'tenant_db',
      isActive: true,
      databaseMoveInProgress: false,
    });
    expect(await selectWorkspaceForRef(db, 'org_nobody')).toBeUndefined();
  });
});

describe('selectWorkspaceForRef · either identifier', () => {
  it('finds the same workspace by its id and by its Clerk org id, and returns both', async () => {
    const { id, orgId } = await seedWorkspace();
    const byOrg = await selectWorkspaceForRef(db, orgId);
    const byId = await selectWorkspaceForRef(db, id);
    expect(byOrg).toMatchObject({ id, clerkOrgId: orgId });
    expect(byId).toEqual(byOrg);
  });

  it('finds an early workspace whose id is its Clerk org id', async () => {
    seq += 1;
    const orgId = `org_legacy_${seq}`;
    await db.insert(workspaces).values({ id: orgId, clerkOrgId: orgId, name: 'Legacy', slug: `legacy-${seq}` });
    expect(await selectWorkspaceForRef(db, orgId)).toMatchObject({ id: orgId, clerkOrgId: orgId });
  });

  it('does not let one workspace\'s id reach another workspace', async () => {
    const a = await seedWorkspace();
    const b = await seedWorkspace();
    expect((await selectWorkspaceForRef(db, a.id))?.id).toBe(a.id);
    expect((await selectWorkspaceForRef(db, b.orgId))?.id).toBe(b.id);
    expect(await selectWorkspaceForRef(db, 'ws_nobody')).toBeUndefined();
  });
});
