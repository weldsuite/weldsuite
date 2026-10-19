/**
 * The database-move services on a real master schema (PGlite): starting and
 * cancelling a move, the state guards the Workflow relies on, and the
 * compensation and recovery that restore a workspace after a failed move. The
 * tenant databases are not needed here (the Workflow test covers the copy), so
 * they are stubs; the lock statements are the harness's fake guard.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { eq } from 'drizzle-orm';
import { neonSharedProjects, workspaceDatabaseMoves, workspaces, type DatabaseMoveStatus } from '@weldsuite/db/schema/master';
import { NeonApiError } from '@weldsuite/neon-provisioning';

vi.mock('../../lib/database-move/guard', async () => (await import('../../test/move-harness')).createGuardModule());

import { DatabaseMoveError, GuardError, JournalMismatchError } from '../../lib/database-move';
import { MIGRATION_JOURNAL } from '../../generated/tenant-migrations';
import {
  CLERK_ORG_ID,
  REGION,
  SECRET_PREFIX,
  SOURCE,
  TARGET,
  WORKSPACE_ID,
  connectionUrl,
  createLightWorld,
  createMoveMaster,
  guardState,
  type LightWorld,
  type MoveMaster,
  type WorldOptions,
} from '../../test/move-harness';
import { compensateDatabaseMove, recoverDatabaseMove } from './compensate';
import { bundledJournalSummary, retentionDaysFromEnv } from './deps';
import { MoveCancelledError, MoveFlowError } from './errors';
import { describeFailure, isPermanentFailure, storedMessageOf } from './failure';
import { requestMoveCancel, startDatabaseMove } from './start';
import { advance, writeProgress } from './state';
import { checksumGroupsOf, prepareTarget, targetRequestOf } from './steps';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let master: MoveMaster;
let world: LightWorld;
let consoleSpies: ReturnType<typeof vi.spyOn>[];

beforeAll(async () => {
  master = await createMoveMaster();
});

afterAll(async () => {
  await master.close();
});

beforeEach(() => {
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

async function setup(options: WorldOptions = {}): Promise<LightWorld> {
  world = await createLightWorld(master, options);
  return world;
}

async function moveRow(moveId: string) {
  const [row] = await world.masterDb.select().from(workspaceDatabaseMoves).where(eq(workspaceDatabaseMoves.id, moveId));
  if (!row) throw new Error('no move row');
  return row;
}

async function workspaceRow() {
  const [row] = await world.masterDb.select().from(workspaces).where(eq(workspaces.id, WORKSPACE_ID));
  if (!row) throw new Error('no workspace row');
  return row;
}

async function setMove(moveId: string, values: Partial<typeof workspaceDatabaseMoves.$inferInsert>) {
  await world.masterDb.update(workspaceDatabaseMoves).set(values).where(eq(workspaceDatabaseMoves.id, moveId));
}

async function setWorkspace(values: Partial<typeof workspaces.$inferInsert>) {
  await world.masterDb.update(workspaces).set(values).where(eq(workspaces.id, WORKSPACE_ID));
}

function start(target: string) {
  return startDatabaseMove(
    world.env,
    { workspaceId: WORKSPACE_ID, target, startedBy: 'admin@weldsuite.org' },
    { masterDb: world.masterDb },
  );
}

const refusal = (code: string) => expect.objectContaining({ name: 'DatabaseMoveRequestError', code });

// ── startDatabaseMove ────────────────────────────────────────────────────

describe('startDatabaseMove', () => {
  it('inserts a queued row with the source coordinates and starts the Workflow with the row id', async () => {
    await setup();
    const started = await startDatabaseMove(
      world.env,
      { workspaceId: WORKSPACE_ID, target: 'dedicated', startedBy: 'admin@weldsuite.org', startedByUserId: 'user_1', reason: 'noisy neighbour' },
      { masterDb: world.masterDb },
    );

    expect(started).toEqual({ moveId: expect.stringMatching(/^dbm_/), kind: 'shard_to_dedicated', workflowInstanceId: started.moveId });
    expect(world.env.MOVE_DATABASE.create).toHaveBeenCalledWith({ id: started.moveId, params: { moveId: started.moveId } });
    expect(await moveRow(started.moveId)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      kind: 'shard_to_dedicated',
      status: 'queued',
      requestedTarget: 'dedicated',
      sourceNeonProjectId: SOURCE.project,
      sourceNeonBranchId: SOURCE.branch,
      sourceDatabaseName: SOURCE.db,
      sourceRoleName: SOURCE.role,
      sourceSharedProjectId: SOURCE.shard,
      sourceRegion: REGION,
      targetNeonProjectId: null,
      workflowInstanceId: started.moveId,
      startedBy: 'admin@weldsuite.org',
      startedByUserId: 'user_1',
      reason: 'noisy neighbour',
      startedAt: null,
    });
  });

  it('derives the kind from where the workspace is and where it should go', async () => {
    await setup();
    expect((await start('shard:auto')).kind).toBe('shard_to_shard');

    await setup({ sourceShard: null });
    expect((await start('shard:auto')).kind).toBe('dedicated_to_shard');

    await setup();
    expect((await start(TARGET.shard)).kind).toBe('shard_to_shard');
    expect((await moveRowsOf()).map((r) => r.requestedTarget)).toEqual([TARGET.shard]);
  });

  it('refuses invalid input', async () => {
    await setup();
    await expect(start('nowhere')).rejects.toEqual(refusal('INVALID_INPUT'));
    await expect(start('nsp_UPPER')).rejects.toEqual(refusal('INVALID_INPUT'));
    await expect(
      startDatabaseMove(world.env, { workspaceId: '', target: 'dedicated', startedBy: 'a@b.c' }, { masterDb: world.masterDb }),
    ).rejects.toEqual(refusal('INVALID_INPUT'));
  });

  it('refuses a workspace that does not exist, is not provisioned, is deleted or is scheduled for deletion', async () => {
    await setup();
    await expect(
      startDatabaseMove(world.env, { workspaceId: 'ws_missing', target: 'dedicated', startedBy: 'a@b.c' }, { masterDb: world.masterDb }),
    ).rejects.toEqual(refusal('WORKSPACE_NOT_FOUND'));

    await setWorkspace({ databaseProvisionedAt: null });
    await expect(start('dedicated')).rejects.toEqual(refusal('WORKSPACE_NOT_PROVISIONED'));
    await setWorkspace({ databaseProvisionedAt: new Date(), databaseUrl: null });
    await expect(start('dedicated')).rejects.toEqual(refusal('WORKSPACE_NOT_PROVISIONED'));
    await setWorkspace({ databaseUrl: 'v2:aa:bb', neonBranchId: null });
    await expect(start('dedicated')).rejects.toEqual(refusal('WORKSPACE_NOT_PROVISIONED'));

    await setWorkspace({ neonBranchId: SOURCE.branch, scheduledDeletionAt: new Date(Date.now() + 86_400_000) });
    await expect(start('dedicated')).rejects.toEqual(refusal('WORKSPACE_SCHEDULED_FOR_DELETION'));
    await setWorkspace({ deletedAt: new Date() });
    await expect(start('dedicated')).rejects.toEqual(refusal('WORKSPACE_DELETED'));
    expect(await moveRowsOf()).toEqual([]);
  });

  it('refuses a target equal to the current placement', async () => {
    await setup({ sourceShard: null });
    await expect(start('dedicated')).rejects.toEqual(refusal('ALREADY_PLACED'));

    await setup();
    await expect(start(SOURCE.shard)).rejects.toEqual(refusal('ALREADY_PLACED'));
  });

  it('checks a requested shard exists, is active and is in the workspace\'s region', async () => {
    await setup();
    await expect(start('nsp_unknown')).rejects.toEqual(refusal('SHARD_NOT_FOUND'));

    await world.masterDb.update(neonSharedProjects).set({ status: 'disabled' }).where(eq(neonSharedProjects.id, TARGET.shard));
    await expect(start(TARGET.shard)).rejects.toEqual(refusal('SHARD_UNAVAILABLE'));

    await world.masterDb
      .update(neonSharedProjects)
      .set({ status: 'active', region: 'aws-us-east-2' })
      .where(eq(neonSharedProjects.id, TARGET.shard));
    await expect(start(TARGET.shard)).rejects.toEqual(refusal('SHARD_UNAVAILABLE'));
    expect(await moveRowsOf()).toEqual([]);
  });

  it('allows one active move per workspace, and another once it is over', async () => {
    await setup();
    const first = await start('dedicated');
    await expect(start('shard:auto')).rejects.toEqual(refusal('MOVE_ALREADY_ACTIVE'));

    for (const status of ['failed', 'cancelled', 'completed'] as const) {
      await setMove(first.moveId, { status });
      const next = await start('shard:auto');
      await setMove(next.moveId, { status: 'failed' });
    }
  });

  it('maps a lost race on the unique index to MOVE_ALREADY_ACTIVE and starts only one Workflow', async () => {
    await setup();

    const outcomes = await Promise.allSettled([start('dedicated'), start('shard:auto')]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toEqual(refusal('MOVE_ALREADY_ACTIVE'));
    expect(world.env.MOVE_DATABASE.create).toHaveBeenCalledTimes(1);
    expect(await moveRowsOf()).toHaveLength(1);
  });

  it('closes the row when the Workflow cannot be created, so the next attempt is not blocked', async () => {
    await setup();
    vi.mocked(world.env.MOVE_DATABASE.create).mockRejectedValueOnce(new Error('workflow binding down'));

    await expect(start('dedicated')).rejects.toEqual(refusal('WORKFLOW_START_FAILED'));

    const [row] = await moveRowsOf();
    expect(row).toMatchObject({ status: 'failed', error: 'The move workflow could not be started' });
    await expect(start('dedicated')).resolves.toMatchObject({ kind: 'shard_to_dedicated' });
  });

  it('uses the default region when the workspace row has none', async () => {
    await setup();
    await setWorkspace({ neonRegion: null });

    const started = await start(TARGET.shard);

    expect((await moveRow(started.moveId)).sourceRegion).toBeNull();
  });
});

async function moveRowsOf() {
  return world.masterDb.select().from(workspaceDatabaseMoves).where(eq(workspaceDatabaseMoves.workspaceId, WORKSPACE_ID));
}

// ── requestMoveCancel ────────────────────────────────────────────────────

describe('requestMoveCancel', () => {
  it.each(['queued', 'preparing', 'soft_locked', 'locked', 'copying', 'verifying'] as const)(
    'flips a %s move to cancelling and stamps the request',
    async (status) => {
      await setup();
      const { moveId } = await start('dedicated');
      await setMove(moveId, { status });

      const result = await requestMoveCancel(world.env, moveId, { masterDb: world.masterDb });

      expect(result).toEqual({ moveId, status: 'cancelling' });
      const row = await moveRow(moveId);
      expect(row.status).toBe('cancelling');
      expect(row.cancelRequestedAt).toBeInstanceOf(Date);
    },
  );

  it('is idempotent while the cancel is pending', async () => {
    await setup();
    const { moveId } = await start('dedicated');
    await requestMoveCancel(world.env, moveId, { masterDb: world.masterDb });
    const firstRequest = (await moveRow(moveId)).cancelRequestedAt;

    await expect(requestMoveCancel(world.env, moveId, { masterDb: world.masterDb })).resolves.toEqual({ moveId, status: 'cancelling' });
    expect((await moveRow(moveId)).cancelRequestedAt).toEqual(firstRequest);
  });

  it.each(['switching', 'completed', 'failed', 'cancelled'] as const)('refuses a %s move', async (status) => {
    await setup();
    const { moveId } = await start('dedicated');
    await setMove(moveId, { status });

    await expect(requestMoveCancel(world.env, moveId, { masterDb: world.masterDb })).rejects.toEqual(refusal('MOVE_NOT_CANCELLABLE'));
    expect((await moveRow(moveId)).status).toBe(status);
    expect((await moveRow(moveId)).cancelRequestedAt).toBeNull();
  });

  it('refuses an unknown move', async () => {
    await setup();
    await expect(requestMoveCancel(world.env, 'dbm_missing', { masterDb: world.masterDb })).rejects.toEqual(refusal('MOVE_NOT_FOUND'));
  });
});

// ── State guards ─────────────────────────────────────────────────────────

describe('advance and writeProgress', () => {
  it('advances a live move, naming the step and returning the row', async () => {
    await setup();
    const { moveId } = await start('dedicated');

    const row = await advance(world.masterDb, moveId, { step: 'check-source', status: 'preparing' });

    expect(row).toMatchObject({ id: moveId, status: 'preparing', currentStep: 'check-source' });
  });

  it('never overwrites a cancel with a later status', async () => {
    await setup();
    const { moveId } = await start('dedicated');
    await requestMoveCancel(world.env, moveId, { masterDb: world.masterDb });

    await expect(advance(world.masterDb, moveId, { step: 'soft-lock', status: 'soft_locked' })).rejects.toBeInstanceOf(MoveCancelledError);

    expect((await moveRow(moveId)).status).toBe('cancelling');
  });

  it('refuses to advance a move that is over', async () => {
    await setup();
    const { moveId } = await start('dedicated');
    await setMove(moveId, { status: 'failed' });

    await expect(advance(world.masterDb, moveId, { step: 'copy-0' })).rejects.toMatchObject({ code: 'MOVE_ENDED' });
  });

  it('saves progress and reports a cancel without touching the status', async () => {
    await setup();
    const { moveId } = await start('dedicated');
    const progress = { tables: [], copiedRows: 5, totalRows: 10 };

    expect(await writeProgress(world.masterDb, moveId, progress)).toEqual({ cancelRequested: false });
    await requestMoveCancel(world.env, moveId, { masterDb: world.masterDb });
    expect(await writeProgress(world.masterDb, moveId, { ...progress, copiedRows: 7 })).toEqual({ cancelRequested: true });

    const row = await moveRow(moveId);
    expect(row.status).toBe('cancelling');
    expect(row.progress?.copiedRows).toBe(7);
  });
});

// ── Compensation and recovery ────────────────────────────────────────────

/** A move that got as far as the lock: the row says so, and the source is locked. */
async function lockedMove(over: Partial<typeof workspaceDatabaseMoves.$inferInsert> = {}): Promise<string> {
  const { moveId } = await start('dedicated');
  await setMove(moveId, {
    status: 'copying',
    progress: { tables: [], copiedRows: 0, totalRows: null, lockStartedAt: new Date().toISOString() },
    lockedAt: new Date(),
    targetNeonProjectId: TARGET.project,
    targetNeonBranchId: TARGET.branch,
    targetDatabaseName: TARGET.db,
    targetRoleName: TARGET.role,
    targetSharedProjectId: null,
    targetPoolId: 'pool_1',
    targetDatabaseUrl: 'v2:aa:bb',
    ...over,
  });
  guardState.locked.add(SOURCE.db);
  return moveId;
}

describe('compensateDatabaseMove', () => {
  it('unlocks the source with the URL the workspace holds, releases the target and closes the row', async () => {
    await setup();
    const moveId = await lockedMove();

    const result = await compensateDatabaseMove(world.deps, moveId, { error: 'Verification failed' });

    expect(result).toEqual({ status: 'failed', sourceUnlocked: true, targetReleased: true });
    expect(guardState.log).toEqual([`unlock:${SOURCE.db}`]);
    expect(world.provisioning.rotateRolePassword).not.toHaveBeenCalled();
    expect(world.provisioning.releaseMoveTarget).toHaveBeenCalledWith(expect.anything(), {
      kind: 'dedicated',
      neonProjectId: TARGET.project,
      neonBranchId: TARGET.branch,
      databaseName: TARGET.db,
      roleName: TARGET.role,
      sharedProjectId: null,
      poolId: 'pool_1',
    });
    expect(await moveRow(moveId)).toMatchObject({ status: 'failed', error: 'Verification failed', targetDatabaseUrl: null });
    expect(world.purges).toEqual([{ workspaceId: WORKSPACE_ID, clerkOrgId: CLERK_ORG_ID }]);
  });

  it('releases a shard target as a shard target', async () => {
    await setup();
    const moveId = await lockedMove({ kind: 'shard_to_shard', targetSharedProjectId: TARGET.shard, targetPoolId: null });

    await compensateDatabaseMove(world.deps, moveId);

    expect(world.provisioning.releaseMoveTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'shard', sharedProjectId: TARGET.shard, poolId: null }),
    );
  });

  it('rotates the password once more when the stored URL is dead (the lock rotated it but never stored the new one)', async () => {
    await setup();
    const moveId = await lockedMove({ status: 'cancelling', cancelRequestedAt: new Date() });
    const database = world.connections.databases.get(SOURCE.db);
    if (!database) throw new Error('missing fake database');
    database.password = `${SECRET_PREFIX}lost-in-a-failed-step`;

    const result = await compensateDatabaseMove(world.deps, moveId);

    expect(result).toMatchObject({ status: 'cancelled', sourceUnlocked: true });
    expect(world.provisioning.rotateRolePassword).toHaveBeenCalledTimes(1);
    expect(guardState.log).toEqual([`unlock:${SOURCE.db}`]);
    // The fresh URL is on the workspace row now, and works.
    const stored = await world.deps.decryptUrl((await workspaceRow()).databaseUrl ?? '');
    expect(stored).toBe(connectionUrl({ role: SOURCE.role, password: `${SECRET_PREFIX}rotated-1`, db: SOURCE.db, pooled: true }));
    expect(world.purges.length).toBeGreaterThanOrEqual(2); // after storing the URL, and at the end
  });

  it('never unlocks a source the lock never reached', async () => {
    await setup();
    const { moveId } = await start('dedicated');
    await setMove(moveId, { status: 'preparing' });

    const result = await compensateDatabaseMove(world.deps, moveId, { error: 'check failed' });

    expect(result).toEqual({ status: 'failed', sourceUnlocked: false, targetReleased: false });
    expect(guardState.log).toEqual([]);
    expect(world.provisioning.rotateRolePassword).not.toHaveBeenCalled();
    expect(world.provisioning.releaseMoveTarget).not.toHaveBeenCalled();
  });

  it('keeps the row live and throws a retryable error when the unlock fails, then finishes on the next run', async () => {
    await setup();
    const moveId = await lockedMove();
    const database = world.connections.databases.get(SOURCE.db);
    if (!database) throw new Error('missing fake database');
    const realSql = database.sql;
    database.sql = { query: () => Promise.reject(new Error('compute is down')), transaction: () => Promise.reject(new Error('compute is down')) };

    const failure = await compensateDatabaseMove(world.deps, moveId, { error: 'copy failed' }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ name: 'MoveFlowError', code: 'COMPENSATION_INCOMPLETE', retryable: true });
    expect(isPermanentFailure(failure)).toBe(false);
    // Still live (writes stay blocked), cause recorded, the target already released.
    const row = await moveRow(moveId);
    expect(row.status).toBe('copying');
    expect(row.error).toBe('copy failed');
    expect(world.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);

    database.sql = realSql;
    const result = await compensateDatabaseMove(world.deps, moveId, { error: 'copy failed' });
    expect(result).toMatchObject({ status: 'failed', sourceUnlocked: true });
    // The target was released by the first run, so it is not dropped again.
    expect(world.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);
  });

  it('refuses to undo a move whose workspace already points at the target', async () => {
    await setup();
    const moveId = await lockedMove();
    await setWorkspace({ neonProjectId: TARGET.project, neonDatabaseName: TARGET.db });

    const failure = await compensateDatabaseMove(world.deps, moveId).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: 'WORKSPACE_CHANGED', retryable: false });
    expect(guardState.log).toEqual([]);
    expect(world.provisioning.releaseMoveTarget).not.toHaveBeenCalled();
  });

  it('leaves a workspace that moved elsewhere alone, but still gives the target back', async () => {
    await setup();
    const moveId = await lockedMove();
    await setWorkspace({ neonDatabaseName: 'somewhere_else' });

    const result = await compensateDatabaseMove(world.deps, moveId);

    expect(result).toEqual({ status: 'failed', sourceUnlocked: false, targetReleased: true });
    expect(guardState.log).toEqual([]);
  });
});

describe('recoverDatabaseMove', () => {
  it('finishes undoing a failed move that left the source locked', async () => {
    await setup();
    const moveId = await lockedMove({ status: 'failed', error: 'Neon was down' });

    const result = await recoverDatabaseMove(world.deps, moveId);

    expect(result).toMatchObject({ status: 'failed', sourceUnlocked: true });
    expect(guardState.locked.has(SOURCE.db)).toBe(false);
    expect((await moveRow(moveId)).error).toBe('Neon was down');
  });

  it('recovers a cancelling move as cancelled', async () => {
    await setup();
    const moveId = await lockedMove({ status: 'cancelling', cancelRequestedAt: new Date() });

    expect(await recoverDatabaseMove(world.deps, moveId)).toMatchObject({ status: 'cancelled' });
  });

  it('refuses a move that still looks live unless forced', async () => {
    await setup();
    const moveId = await lockedMove({ status: 'copying' });

    await expect(recoverDatabaseMove(world.deps, moveId)).rejects.toEqual(refusal('MOVE_NOT_RECOVERABLE'));
    expect(guardState.locked.has(SOURCE.db)).toBe(true);

    expect(await recoverDatabaseMove(world.deps, moveId, { force: true })).toMatchObject({ status: 'failed', sourceUnlocked: true });
  });

  it('refuses a completed move and an unknown one', async () => {
    await setup();
    const { moveId } = await start('dedicated');
    await setMove(moveId, { status: 'completed' });

    await expect(recoverDatabaseMove(world.deps, moveId)).rejects.toEqual(refusal('MOVE_NOT_RECOVERABLE'));
    await expect(recoverDatabaseMove(world.deps, 'dbm_missing')).rejects.toEqual(refusal('MOVE_NOT_FOUND'));
  });

  it.each<DatabaseMoveStatus>(['queued', 'preparing', 'soft_locked', 'locked', 'verifying', 'switching'])(
    'forced recovery works from %s',
    async (status) => {
      await setup();
      const moveId = await lockedMove({ status });

      await expect(recoverDatabaseMove(world.deps, moveId, { force: true })).resolves.toMatchObject({ status: 'failed' });
    },
  );
});

// ── prepareTarget ────────────────────────────────────────────────────────

describe('prepareTarget', () => {
  it('records the target and its encrypted URL on the row, and reuses it when run again', async () => {
    await setup();
    const { moveId } = await start('dedicated');

    expect(await prepareTarget(world.deps, moveId)).toEqual({ reused: false, kind: 'dedicated', claimedFromPool: false });
    const row = await moveRow(moveId);
    expect(row).toMatchObject({
      targetNeonProjectId: TARGET.project,
      targetNeonBranchId: TARGET.branch,
      targetDatabaseName: TARGET.db,
      targetRoleName: TARGET.role,
      targetSharedProjectId: null,
      targetRegion: REGION,
      targetPoolId: null,
    });
    expect(row.targetDatabaseUrl).not.toContain('postgres');
    expect(await world.deps.decryptUrl(row.targetDatabaseUrl ?? '')).toBe(
      connectionUrl({ role: TARGET.role, password: `${SECRET_PREFIX}target-0`, db: TARGET.db, pooled: true }),
    );

    expect(await prepareTarget(world.deps, moveId)).toEqual({ reused: true, kind: 'dedicated', claimedFromPool: false });
    expect(world.provisioning.prepareMoveTarget).toHaveBeenCalledTimes(1);
  });

  it('releases the target it just prepared when it cannot record it, so nothing is orphaned', async () => {
    await setup();
    const { moveId } = await start('shard:auto');
    const failing = { ...world.deps, encryptUrl: vi.fn().mockRejectedValueOnce(new Error('no key')) };

    await expect(prepareTarget(failing, moveId)).rejects.toThrow('no key');

    expect(world.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);
    expect(world.provisioning.releaseMoveTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'shard', neonProjectId: TARGET.project, databaseName: TARGET.db, sharedProjectId: TARGET.shard }),
    );
    expect((await moveRow(moveId)).targetNeonProjectId).toBeNull();
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('describeFailure', () => {
  it('reports a database error by its SQLSTATE only, however the driver wrapped it', () => {
    const driver = Object.assign(new Error('invalid input syntax for type integer: "secret cell value"'), { code: '22P02' });
    const wrapped = Object.assign(new Error('Failed query: INSERT INTO t VALUES ($1)\nparams: secret cell value'), {
      name: 'DrizzleQueryError',
      cause: driver,
    });

    expect(describeFailure(driver)).toBe('Database error 22P02');
    expect(describeFailure(wrapped)).toBe('Database error 22P02');
    expect(describeFailure(Object.assign(new Error('Failed query: SELECT secret'), { name: 'DrizzleQueryError' }))).toBe(
      'Database query failed',
    );
  });

  it('names a rotated password and a read-only database without their messages', () => {
    expect(describeFailure(new Error('password authentication failed for user "role_x"'))).toBe(
      'Database error 28P01 (password authentication failed)',
    );
    expect(describeFailure(new Error('cannot execute INSERT in a read-only transaction'))).toBe(
      'Database error 25006 (read-only transaction)',
    );
  });

  it('redacts connection strings from any other message', () => {
    const text = describeFailure(new TypeError(`fetch failed for postgresql://role:${SECRET_PREFIX}pw@host/db?sslmode=require now`));
    expect(text).toBe('TypeError: fetch failed for postgres://[redacted] now');
    expect(storedMessageOf(new Error('see postgres://u:p@h/d'))).toBe('see postgres://[redacted]');
  });

  it('passes the engine\'s and this code\'s own messages through, and Neon errors by status', () => {
    expect(describeFailure(new MoveFlowError('SOURCE_NOT_CURRENT', 'The source is behind'))).toBe('The source is behind');
    expect(describeFailure(new MoveCancelledError())).toBe('MOVE_CANCELLED');
    expect(describeFailure(new JournalMismatchError(null, null))).toMatch(/^JOURNAL_MISMATCH: /);
    expect(describeFailure(new NeonApiError(`rate limited for key ${SECRET_PREFIX}key`, 429))).toBe('Neon API error (HTTP 429)');
    expect(describeFailure('plain string')).toBe('Unknown error');
  });

  it('marks what a retry cannot fix as permanent', () => {
    expect(isPermanentFailure(new JournalMismatchError(null, null))).toBe(true);
    expect(isPermanentFailure(new MoveCancelledError())).toBe(true);
    expect(isPermanentFailure(new MoveFlowError('VERIFICATION_FAILED', 'x'))).toBe(true);
    expect(isPermanentFailure(new MoveFlowError('COMPENSATION_INCOMPLETE', 'x', true))).toBe(false);
    expect(isPermanentFailure(new GuardError('sessions survived'))).toBe(false);
    expect(isPermanentFailure(new DatabaseMoveError('X', 'x'))).toBe(true);
    expect(isPermanentFailure(new Error('connection reset'))).toBe(false);
  });
});

describe('checksumGroupsOf', () => {
  const table = (name: string, estimatedRows: number | null) => ({ table: name, rows: 0, cursor: null, done: false, estimatedRows });

  it('keeps the plan order and splits where the estimated rows add up', () => {
    const groups = checksumGroupsOf({
      tables: [table('a', 100_000), table('b', 100_000), table('c', 100_000), table('big', 900_000), table('d', 10)],
      emptyTables: [],
    });
    expect(groups).toEqual([['a', 'b'], ['c'], ['big'], ['d']]);
  });

  it('caps the tables per group, counts unknown estimates as zero, and appends the empty tables in chunks', () => {
    const many = Array.from({ length: 250 }, (_, i) => table(`t${i}`, null));
    const empty = Array.from({ length: 650 }, (_, i) => `e${i}`);
    const groups = checksumGroupsOf({ tables: many, emptyTables: empty });
    expect(groups.map((g) => g.length)).toEqual([100, 100, 50, 300, 300, 50]);
    expect(groups.flat()).toEqual([...many.map((t) => t.table), ...empty]);
  });

  it('is empty for nothing to verify', () => {
    expect(checksumGroupsOf({ tables: [], emptyTables: undefined })).toEqual([]);
  });
});

describe('targetRequestOf', () => {
  it('maps the requested target to what the provisioning helper takes', () => {
    expect(targetRequestOf({ requestedTarget: 'dedicated', sourceSharedProjectId: 'nsp_a' })).toEqual({ kind: 'dedicated' });
    expect(targetRequestOf({ requestedTarget: 'shard:auto', sourceSharedProjectId: 'nsp_a' })).toEqual({ kind: 'shard', excludeShardId: 'nsp_a' });
    expect(targetRequestOf({ requestedTarget: 'shard:auto', sourceSharedProjectId: null })).toEqual({ kind: 'shard' });
    expect(targetRequestOf({ requestedTarget: 'nsp_b', sourceSharedProjectId: null })).toEqual({ kind: 'shard', shardId: 'nsp_b' });
  });
});

describe('deps helpers', () => {
  it('reads the retention days from the env, defaulting to 7', () => {
    expect(retentionDaysFromEnv({ DATABASE_MOVE_RETENTION_DAYS: '14' })).toBe(14);
    expect(retentionDaysFromEnv({ DATABASE_MOVE_RETENTION_DAYS: '0.5' })).toBe(0.5);
    for (const bad of [undefined, '', 'soon', '0', '-3']) {
      expect(retentionDaysFromEnv({ DATABASE_MOVE_RETENTION_DAYS: bad })).toBe(7);
    }
  });

  it('summarises the bundled journal the way readJournalSummary does: entry count and newest created_at as text', () => {
    const newest = Math.max(...MIGRATION_JOURNAL.map((m) => m.when));
    expect(bundledJournalSummary()).toEqual({ count: MIGRATION_JOURNAL.length, maxCreatedAt: String(newest) });
  });
});


