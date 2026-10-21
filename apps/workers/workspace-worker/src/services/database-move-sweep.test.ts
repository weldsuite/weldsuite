/**
 * The daily database-move sweep on a real master schema (PGlite): dropping the
 * old database of a completed move once its retention is over, the safety that
 * stops a drop when a workspace still points at it, one failure not stopping
 * the rest, the bounded batch, and the watchdog for moves that went quiet.
 * The Neon side (the drop) is a fake.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { eq, inArray } from 'drizzle-orm';
import { databasePool, workspaceDatabaseMoves, workspaces } from '@weldsuite/db/schema/master';
import { NeonApiError } from '@weldsuite/neon-provisioning';
import {
  REGION,
  SECRET_PREFIX,
  SOURCE,
  TARGET,
  WORKSPACE_ID,
  createLightWorld,
  createMoveMaster,
  type LightWorld,
  type MoveMaster,
} from '../test/move-harness';
import { startDatabaseMove } from './database-move';
import {
  RETENTION_BATCH_LIMIT,
  flagStalledMoves,
  runDatabaseMoveSweep,
  sweepRetainedDatabases,
} from './database-move-sweep';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const NOW = new Date('2026-10-19T03:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let master: MoveMaster;
let world: LightWorld;
let consoleSpies: ReturnType<typeof vi.spyOn>[];
let dropDatabaseAt: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  master = await createMoveMaster();
});

afterAll(async () => {
  await master.close();
});

beforeEach(async () => {
  world = await createLightWorld(master, { now: () => NOW });
  dropDatabaseAt = vi.fn(async () => {});
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
  expect(output).not.toContain('postgresql://');
});

const options = () => ({ masterDb: world.masterDb, provisioning: { dropDatabaseAt } as never, now: () => NOW });

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return inspect(spy.mock.calls, { depth: 6 });
}

async function moveRow(moveId: string) {
  const [row] = await world.masterDb.select().from(workspaceDatabaseMoves).where(eq(workspaceDatabaseMoves.id, moveId));
  if (!row) throw new Error('no move row');
  return row;
}

async function setMove(moveId: string, values: Partial<typeof workspaceDatabaseMoves.$inferInsert>) {
  await world.masterDb.update(workspaceDatabaseMoves).set(values).where(eq(workspaceDatabaseMoves.id, moveId));
}

/** The workspace now lives on the move's target, as after a switch. */
async function switchWorkspaceToTarget(): Promise<void> {
  await world.masterDb
    .update(workspaces)
    .set({
      neonProjectId: TARGET.project,
      neonBranchId: TARGET.branch,
      neonRoleName: TARGET.role,
      neonDatabaseName: TARGET.db,
      sharedProjectId: null,
    })
    .where(eq(workspaces.id, WORKSPACE_ID));
}

/** A completed move whose retention ended `daysAgo` days ago. Returns its id. */
async function completedMove(over: Partial<typeof workspaceDatabaseMoves.$inferInsert> = {}, daysAgo = 1): Promise<string> {
  const id = over.id ?? `dbm_${Math.random().toString(36).slice(2, 12)}`;
  await world.masterDb.insert(workspaceDatabaseMoves).values({
    id,
    workspaceId: WORKSPACE_ID,
    kind: 'shard_to_dedicated',
    status: 'completed',
    requestedTarget: 'dedicated',
    sourceNeonProjectId: SOURCE.project,
    sourceNeonBranchId: SOURCE.branch,
    sourceDatabaseName: SOURCE.db,
    sourceRoleName: SOURCE.role,
    sourceSharedProjectId: SOURCE.shard,
    startedBy: 'ops@weldsuite.org',
    completedAt: new Date(NOW.getTime() - (daysAgo + 7) * DAY),
    oldDatabaseRetainedUntil: new Date(NOW.getTime() - daysAgo * DAY),
    ...over,
  });
  return id;
}

async function startedMove(): Promise<string> {
  const started = await startDatabaseMove(
    world.env,
    { workspaceId: WORKSPACE_ID, target: 'dedicated', startedBy: 'ops@weldsuite.org' },
    { masterDb: world.masterDb },
  );
  return started.moveId;
}

// ── Retention ────────────────────────────────────────────────────────────

describe('sweepRetainedDatabases', () => {
  it('drops the old database of a completed move whose retention is over, and records it', async () => {
    await switchWorkspaceToTarget();
    const moveId = await completedMove();

    const result = await sweepRetainedDatabases(world.env, options());

    expect(result).toEqual({ due: 1, dropped: 1, skipped: 0, failed: 0 });
    expect(dropDatabaseAt).toHaveBeenCalledTimes(1);
    expect(dropDatabaseAt).toHaveBeenCalledWith(
      world.masterDb,
      {
        neonProjectId: SOURCE.project,
        neonBranchId: SOURCE.branch,
        databaseName: SOURCE.db,
        roleName: SOURCE.role,
        sharedProjectId: SOURCE.shard,
        poolId: undefined,
      },
      { ignoreMissing: true },
    );
    expect(await moveRow(moveId)).toMatchObject({ oldDatabaseDroppedAt: NOW, oldDatabaseDropError: null });
  });

  it("passes the source's database_pool row so it is cleaned up too", async () => {
    await switchWorkspaceToTarget();
    await world.masterDb.insert(databasePool).values({
      id: 'pool_src',
      kind: 'shared',
      neonProjectId: SOURCE.project,
      neonBranchId: SOURCE.branch,
      databaseName: SOURCE.db,
      roleName: SOURCE.role,
      databaseUrl: 'v2:aa:bb',
      sharedProjectId: SOURCE.shard,
      region: REGION,
      status: 'assigned',
      assignedWorkspaceId: WORKSPACE_ID,
    });
    await databasePoolDecoy();
    await completedMove();

    await sweepRetainedDatabases(world.env, options());

    expect(dropDatabaseAt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ poolId: 'pool_src' }),
      { ignoreMissing: true },
    );
  });

  /** Another pool slot in the same shard with a different database: it must not be picked. */
  async function databasePoolDecoy(): Promise<void> {
    await world.masterDb.insert(databasePool).values({
      id: 'pool_other',
      kind: 'shared',
      neonProjectId: SOURCE.project,
      neonBranchId: SOURCE.branch,
      databaseName: 'some_other_db',
      roleName: 'other_role',
      databaseUrl: 'v2:cc:dd',
      sharedProjectId: SOURCE.shard,
      region: REGION,
    });
  }

  it('leaves alone a move that is not due, already dropped, not completed, or has no retention', async () => {
    await switchWorkspaceToTarget();
    const future = await completedMove({}, -3); // retained until 3 days from now
    const dropped = await completedMove({ oldDatabaseDroppedAt: new Date(NOW.getTime() - DAY) });
    const failed = await completedMove({ status: 'failed' });
    const noRetention = await completedMove({ oldDatabaseRetainedUntil: null });

    const result = await sweepRetainedDatabases(world.env, options());

    expect(result).toEqual({ due: 0, dropped: 0, skipped: 0, failed: 0 });
    expect(dropDatabaseAt).not.toHaveBeenCalled();
    expect((await moveRow(future)).oldDatabaseDroppedAt).toBeNull();
    expect((await moveRow(failed)).oldDatabaseDroppedAt).toBeNull();
    expect((await moveRow(noRetention)).oldDatabaseDroppedAt).toBeNull();
    expect((await moveRow(dropped)).oldDatabaseDroppedAt).toEqual(new Date(NOW.getTime() - DAY));
  });

  it('does not drop twice: a second run finds nothing due', async () => {
    await switchWorkspaceToTarget();
    await completedMove();

    await sweepRetainedDatabases(world.env, options());
    const second = await sweepRetainedDatabases(world.env, options());

    expect(second.due).toBe(0);
    expect(dropDatabaseAt).toHaveBeenCalledTimes(1);
  });

  describe('safety', () => {
    it('refuses to drop a database the workspace still points at, and says so on the row', async () => {
      // The workspace row was never switched (or was put back by hand): it still uses the "old" database.
      const moveId = await completedMove();

      const result = await sweepRetainedDatabases(world.env, options());

      expect(result).toEqual({ due: 1, dropped: 0, skipped: 1, failed: 0 });
      expect(dropDatabaseAt).not.toHaveBeenCalled();
      const row = await moveRow(moveId);
      expect(row.oldDatabaseDroppedAt).toBeNull();
      expect(row.oldDatabaseDropError).toBe('Not dropped: a workspace still points at the old database');
      expect(logged(consoleSpies[2] as never)).toContain(moveId);
    });

    it('checks every workspace, not just the move\'s own: another workspace on the same shard database blocks the drop', async () => {
      await switchWorkspaceToTarget();
      await world.masterDb.insert(workspaces).values({
        id: 'ws_neighbour',
        clerkOrgId: 'org_neighbour',
        name: 'Neighbour',
        slug: 'neighbour',
        neonProjectId: SOURCE.project,
        neonBranchId: SOURCE.branch,
        neonRoleName: SOURCE.role,
        neonDatabaseName: SOURCE.db,
        sharedProjectId: SOURCE.shard,
      });
      const moveId = await completedMove();

      const result = await sweepRetainedDatabases(world.env, options());

      expect(result.skipped).toBe(1);
      expect(dropDatabaseAt).not.toHaveBeenCalled();
      expect((await moveRow(moveId)).oldDatabaseDropError).toMatch(/still points/);
    });

    it('lets a shard database go when only a neighbour on ANOTHER database of the shard remains', async () => {
      await switchWorkspaceToTarget();
      await world.masterDb.insert(workspaces).values({
        id: 'ws_neighbour',
        clerkOrgId: 'org_neighbour',
        name: 'Neighbour',
        slug: 'neighbour',
        neonProjectId: SOURCE.project,
        neonBranchId: SOURCE.branch,
        neonRoleName: 'neighbour_role',
        neonDatabaseName: 'neighbour_db',
        sharedProjectId: SOURCE.shard,
      });
      await completedMove();

      const result = await sweepRetainedDatabases(world.env, options());

      expect(result.dropped).toBe(1);
    });

    it('treats a dedicated source as a whole project: any workspace on it blocks the drop', async () => {
      await world.masterDb
        .update(workspaces)
        .set({ neonProjectId: 'prj-dedicated-old', neonDatabaseName: 'neondb', sharedProjectId: null })
        .where(eq(workspaces.id, WORKSPACE_ID));
      const moveId = await completedMove({
        kind: 'dedicated_to_shard',
        sourceNeonProjectId: 'prj-dedicated-old',
        sourceDatabaseName: 'neondb',
        sourceSharedProjectId: null,
      });

      expect((await sweepRetainedDatabases(world.env, options())).skipped).toBe(1);
      expect(dropDatabaseAt).not.toHaveBeenCalled();

      // Once the workspace lives elsewhere the whole project goes.
      await switchWorkspaceToTarget();
      expect((await sweepRetainedDatabases(world.env, options())).dropped).toBe(1);
      expect(dropDatabaseAt).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ neonProjectId: 'prj-dedicated-old', sharedProjectId: null }),
        { ignoreMissing: true },
      );
      expect((await moveRow(moveId)).oldDatabaseDroppedAt).toEqual(NOW);
    });

    it('drops the old database of a workspace that was deleted meanwhile (its row no longer points anywhere)', async () => {
      await world.masterDb
        .update(workspaces)
        .set({ neonProjectId: null, neonBranchId: null, neonRoleName: null, neonDatabaseName: null, sharedProjectId: null })
        .where(eq(workspaces.id, WORKSPACE_ID));
      await completedMove();

      expect((await sweepRetainedDatabases(world.env, options())).dropped).toBe(1);
    });
  });

  describe('failures and the batch', () => {
    it('records a failed drop without its details and goes on with the other moves', async () => {
      await switchWorkspaceToTarget();
      const bad = await completedMove({ id: 'dbm_bad', sourceDatabaseName: 'db_bad' }, 3);
      const good = await completedMove({ id: 'dbm_good', sourceDatabaseName: 'db_good' }, 1);
      dropDatabaseAt.mockImplementation(async (_db: unknown, target: { databaseName: string }) => {
        if (target.databaseName === 'db_bad') throw new NeonApiError(`${SECRET_PREFIX}leak postgresql://u:p@h/db`, 500);
      });

      const result = await sweepRetainedDatabases(world.env, options());

      expect(result).toEqual({ due: 2, dropped: 1, skipped: 0, failed: 1 });
      expect(dropDatabaseAt).toHaveBeenCalledTimes(2);
      expect(await moveRow(bad)).toMatchObject({ oldDatabaseDroppedAt: null, oldDatabaseDropError: 'Neon API error (HTTP 500)' });
      expect(await moveRow(good)).toMatchObject({ oldDatabaseDroppedAt: NOW, oldDatabaseDropError: null });
    });

    it('tries a failed move again the next day and clears the error once it works', async () => {
      await switchWorkspaceToTarget();
      const moveId = await completedMove();
      dropDatabaseAt.mockRejectedValueOnce(new NeonApiError('down', 503));

      await sweepRetainedDatabases(world.env, options());
      expect((await moveRow(moveId)).oldDatabaseDropError).toBe('Neon API error (HTTP 503)');

      const second = await sweepRetainedDatabases(world.env, options());
      expect(second).toEqual({ due: 1, dropped: 1, skipped: 0, failed: 0 });
      expect(await moveRow(moveId)).toMatchObject({ oldDatabaseDroppedAt: NOW, oldDatabaseDropError: null });
    });

    it('does at most one batch per run: 10 by default, those that never failed first', async () => {
      await switchWorkspaceToTarget();
      const stuck = await completedMove(
        { id: 'dbm_stuck', oldDatabaseDropError: 'Neon API error (HTTP 500)' },
        30, // the oldest of all
      );
      const fresh: string[] = [];
      for (let i = 0; i < RETENTION_BATCH_LIMIT; i++) {
        fresh.push(await completedMove({ id: `dbm_fresh_${String(i).padStart(2, '0')}` }, 2));
      }

      const first = await sweepRetainedDatabases(world.env, options());

      expect(first).toEqual({ due: RETENTION_BATCH_LIMIT, dropped: RETENTION_BATCH_LIMIT, skipped: 0, failed: 0 });
      const rows = await world.masterDb.select().from(workspaceDatabaseMoves).where(inArray(workspaceDatabaseMoves.id, fresh));
      expect(rows.every((row) => row.oldDatabaseDroppedAt !== null)).toBe(true);
      expect((await moveRow(stuck)).oldDatabaseDroppedAt).toBeNull();

      const second = await sweepRetainedDatabases(world.env, options());
      expect(second.dropped).toBe(1);
      expect((await moveRow(stuck)).oldDatabaseDroppedAt).toEqual(NOW);
    });

    it('honours a smaller batch limit', async () => {
      await switchWorkspaceToTarget();
      for (let i = 0; i < 5; i++) await completedMove({ id: `dbm_b${i}` });

      expect((await sweepRetainedDatabases(world.env, { ...options(), batchLimit: 2 })).due).toBe(2);
    });
  });
});

// ── Watchdog ─────────────────────────────────────────────────────────────

describe('flagStalledMoves', () => {
  it('notes a live move that has been quiet for hours, keeps its status, and does not touch updated_at', async () => {
    const moveId = await startedMove();
    const quietSince = new Date(NOW.getTime() - 7 * HOUR);
    await setMove(moveId, { status: 'copying', currentStep: 'copy-3', updatedAt: quietSince });

    const stalled = await flagStalledMoves(world.env, options());

    expect(stalled).toEqual([
      { moveId, workspaceId: WORKSPACE_ID, status: 'copying', lastUpdate: quietSince.toISOString() },
    ]);
    expect(await moveRow(moveId)).toMatchObject({ status: 'copying', currentStep: 'stalled (was: copy-3)', updatedAt: quietSince });
    const warning = logged(consoleSpies[1] as never);
    expect(warning).toContain(moveId);
    expect(warning).toContain(WORKSPACE_ID);
    expect(warning).toContain('Recover');
  });

  it('ignores a move that is recent, and moves that are over', async () => {
    const recent = await startedMove();
    await setMove(recent, { status: 'copying', currentStep: 'copy-1', updatedAt: new Date(NOW.getTime() - 5 * HOUR) });
    for (const [i, status] of (['completed', 'failed', 'cancelled'] as const).entries()) {
      await completedMove({ id: `dbm_over_${i}`, status, updatedAt: new Date(NOW.getTime() - 40 * DAY), oldDatabaseRetainedUntil: null });
    }

    expect(await flagStalledMoves(world.env, options())).toEqual([]);
    expect((await moveRow(recent)).currentStep).toBe('copy-1');
  });

  it.each(['queued', 'preparing', 'soft_locked', 'locked', 'copying', 'verifying', 'switching', 'cancelling'] as const)(
    'covers a %s move',
    async (status) => {
      const moveId = await startedMove();
      await setMove(moveId, { status, currentStep: 'x', updatedAt: new Date(NOW.getTime() - 8 * HOUR) });
      expect((await flagStalledMoves(world.env, options())).map((m) => m.moveId)).toEqual([moveId]);
    },
  );

  it('is idempotent: a second run reports it again but does not rewrite the note', async () => {
    const moveId = await startedMove();
    await setMove(moveId, { status: 'copying', currentStep: 'copy-3', updatedAt: new Date(NOW.getTime() - 9 * HOUR) });

    await flagStalledMoves(world.env, options());
    const second = await flagStalledMoves(world.env, options());

    expect(second.map((m) => m.moveId)).toEqual([moveId]);
    expect((await moveRow(moveId)).currentStep).toBe('stalled (was: copy-3)');
    expect(logged(consoleSpies[1] as never)).toContain('already flagged');
  });

  it('notes a move with no step, and keeps the note within the 60-character column', async () => {
    const moveId = await startedMove();
    await setMove(moveId, { status: 'queued', currentStep: null, updatedAt: new Date(NOW.getTime() - 7 * HOUR) });
    await flagStalledMoves(world.env, options());
    expect((await moveRow(moveId)).currentStep).toBe('stalled (was: -)');

    await setMove(moveId, { currentStep: 'a-very-long-step-name-'.repeat(2).slice(0, 59), updatedAt: new Date(NOW.getTime() - 7 * HOUR) });
    await flagStalledMoves(world.env, options());
    const note = (await moveRow(moveId)).currentStep ?? '';
    expect(note.length).toBeLessThanOrEqual(60);
    expect(note.startsWith('stalled (was: a-very-long')).toBe(true);
  });

  it('flags it again after the move resumed and went quiet once more', async () => {
    const moveId = await startedMove();
    await setMove(moveId, { status: 'copying', currentStep: 'copy-3', updatedAt: new Date(NOW.getTime() - 9 * HOUR) });
    await flagStalledMoves(world.env, options());
    // The Workflow came back: its next step names itself and bumps updated_at.
    await setMove(moveId, { currentStep: 'copy-9', updatedAt: new Date(NOW.getTime() - 7 * HOUR) });

    await flagStalledMoves(world.env, options());

    expect((await moveRow(moveId)).currentStep).toBe('stalled (was: copy-9)');
  });
});

// ── Entry point ──────────────────────────────────────────────────────────

describe('runDatabaseMoveSweep', () => {
  it('runs the retention sweep and the watchdog', async () => {
    const quiet = await startedMove();
    await setMove(quiet, { status: 'locked', currentStep: 'lock-source', updatedAt: new Date(NOW.getTime() - 10 * HOUR) });
    await switchWorkspaceToTarget();
    const dueMove = await completedMove();

    const result = await runDatabaseMoveSweep(world.env, options());

    expect(result.retention).toEqual({ due: 1, dropped: 1, skipped: 0, failed: 0 });
    expect(result.stalled.map((m) => m.moveId)).toEqual([quiet]);
    expect((await moveRow(dueMove)).oldDatabaseDroppedAt).toEqual(NOW);
    expect(logged(consoleSpies[0] as never)).toContain('Retention: 1 due, 1 dropped, 0 skipped, 0 failed');
  });

  it('never throws, and one half failing does not skip the other', async () => {
    const quiet = await startedMove();
    await setMove(quiet, { status: 'locked', currentStep: 'lock-source', updatedAt: new Date(NOW.getTime() - 10 * HOUR) });
    await switchWorkspaceToTarget();
    let broken = true;
    const flaky = new Proxy(world.masterDb, {
      get(target, prop, receiver) {
        if (prop === 'select' && broken) {
          broken = false;
          return () => {
            throw new Error(`master is down postgresql://u:${SECRET_PREFIX}p@h/db`);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const result = await runDatabaseMoveSweep(world.env, { ...options(), masterDb: flaky });

    expect(result.retention).toEqual({ due: 0, dropped: 0, skipped: 0, failed: 0 });
    expect(result.stalled.map((m) => m.moveId)).toEqual([quiet]);
    expect(logged(consoleSpies[2] as never)).toContain('Retention sweep failed');
  });
});
