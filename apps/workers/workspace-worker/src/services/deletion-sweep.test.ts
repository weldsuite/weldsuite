/**
 * The scheduled-deletion sweep and database moves: a workspace whose database
 * is being moved is skipped (and stays due), everything else is deleted as
 * before. Real master schema (PGlite); the Clerk API is a stubbed fetch.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { workspaceDatabaseMoves, workspaces, type DatabaseMoveStatus } from '@weldsuite/db/schema/master';
import {
  SOURCE,
  WORKSPACE_ID,
  createLightWorld,
  createMoveMaster,
  type LightWorld,
  type MoveMaster,
} from '../test/move-harness';
import type { Env } from '../index';
import { sweepScheduledDeletions } from './deletion-sweep';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let master: MoveMaster;
let world: LightWorld;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  master = await createMoveMaster();
});

afterAll(async () => {
  await master.close();
});

beforeEach(async () => {
  world = await createLightWorld(master);
  await world.masterDb
    .update(workspaces)
    .set({ scheduledDeletionAt: new Date(Date.now() - 60_000) })
    .where(eq(workspaces.id, WORKSPACE_ID));
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const env = () => ({ CLERK_SECRET_KEY: 'sk_test_x' }) as Env;

async function workspace() {
  const [row] = await world.masterDb.select().from(workspaces).where(eq(workspaces.id, WORKSPACE_ID));
  if (!row) throw new Error('no workspace');
  return row;
}

async function setStatus(moveId: string, status: DatabaseMoveStatus): Promise<void> {
  await world.masterDb.update(workspaceDatabaseMoves).set({ status }).where(eq(workspaceDatabaseMoves.id, moveId));
}

/** A move row for the workspace, inserted directly (starting one is refused for a workspace scheduled for deletion). */
async function startMove(status: DatabaseMoveStatus = 'queued'): Promise<string> {
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

describe('sweepScheduledDeletions and database moves', () => {
  it('deletes a due workspace that has no move, as before', async () => {
    const result = await sweepScheduledDeletions(env(), { masterDb: world.masterDb });

    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0, deferred: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.clerk.com/v1/organizations/org_1');
    expect((await workspace()).deletedAt).toBeInstanceOf(Date);
  });

  it.each(['queued', 'preparing', 'soft_locked', 'locked', 'copying', 'verifying', 'switching', 'cancelling'] as const)(
    'defers a workspace whose move is %s: the Clerk org is not deleted and the workspace stays due',
    async (status) => {
      await startMove(status);

      const result = await sweepScheduledDeletions(env(), { masterDb: world.masterDb });

      expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0, deferred: 1 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect((await workspace()).deletedAt).toBeNull();
    },
  );

  it('picks the workspace up on a later run, once the move is over', async () => {
    const moveId = await startMove();
    expect((await sweepScheduledDeletions(env(), { masterDb: world.masterDb })).deferred).toBe(1);

    await setStatus(moveId, 'failed');
    const later = await sweepScheduledDeletions(env(), { masterDb: world.masterDb });

    expect(later).toEqual({ processed: 1, succeeded: 1, failed: 0, deferred: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await workspace()).deletedAt).toBeInstanceOf(Date);
  });

  it('does not let a finished move hold a deletion back', async () => {
    const moveId = await startMove();
    await setStatus(moveId, 'completed');

    expect((await sweepScheduledDeletions(env(), { masterDb: world.masterDb })).succeeded).toBe(1);
  });
});
