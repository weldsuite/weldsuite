/**
 * MoveDatabaseWorkflow end to end on real Postgres (PGlite): a real master
 * schema, a real source and target tenant database, the real copy engine. Faked:
 * the Neon API (it rotates the passwords of the PGlite databases), the lock
 * statements PGlite cannot run, and the Workflow runtime (a step that memoizes
 * and retries like Cloudflare's).
 *
 * All PGlite-backed tests of the Workflow live in this one file and run one
 * after the other: pglite crashes when many instances start at once.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { eq } from 'drizzle-orm';
import { adminAuditEvents, workspaceDatabaseMoves, workspaces } from '@weldsuite/db/schema/master';
import type { MoveDeps } from '../services/database-move/deps';

const holder = vi.hoisted(() => ({ deps: null as MoveDeps | null }));
vi.mock('../services/database-move/deps', () => ({
  createMoveDeps: () => {
    if (!holder.deps) throw new Error('test did not set the move deps');
    return holder.deps;
  },
}));
vi.mock('../lib/database-move/guard', async () => (await import('../test/move-harness')).createGuardModule());

import { tableChecksums, readTables, compareChecksums } from '../lib/database-move';
import { compensateDatabaseMove } from '../services/database-move/compensate';
import { requestMoveCancel } from '../services/database-move/start';
import {
  CLERK_ORG_ID,
  CRASHED,
  FIXTURE_JOURNAL,
  SECRET_PREFIX,
  SOURCE,
  TARGET,
  WORKSPACE_ID,
  connectionUrl,
  createFakeStep,
  createMoveMaster,
  createMoveWorld,
  guardState,
  startMove,
  type FakeStep,
  type MoveMaster,
  type MoveWorld,
  type WorldOptions,
} from '../test/move-harness';
import { MoveDatabaseWorkflow } from './move-database';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let master: MoveMaster;
let world: MoveWorld | null = null;
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

afterEach(async () => {
  const output = consoleSpies.map((spy) => inspect(spy.mock.calls, { depth: 6 })).join('\n');
  vi.restoreAllMocks();
  holder.deps = null;
  await world?.close();
  world = null;
  // No connection string and no password, in any log line, on any path.
  expect(output).not.toContain(SECRET_PREFIX);
  expect(output).not.toContain('postgresql://');
});

// ── Helpers ──────────────────────────────────────────────────────────────

async function setup(options: WorldOptions = {}): Promise<MoveWorld> {
  world = await createMoveWorld(master, options);
  holder.deps = world.deps;
  return world;
}

function launch(w: MoveWorld, step: FakeStep, moveId: string): Promise<unknown> {
  holder.deps = w.deps;
  const workflow = new MoveDatabaseWorkflow({} as never, w.env);
  return workflow.run({ payload: { moveId }, timestamp: new Date(), instanceId: moveId } as never, step as never);
}

async function moveRow(w: MoveWorld, moveId: string) {
  const [row] = await w.masterDb.select().from(workspaceDatabaseMoves).where(eq(workspaceDatabaseMoves.id, moveId));
  if (!row) throw new Error('no move row');
  return row;
}

/** The admin trail rows the move wrote itself (start/cancel/recover are the routes' and are not written here). */
async function outcomeAudit(w: MoveWorld) {
  const rows = await w.masterDb.select().from(adminAuditEvents);
  return rows.filter((r) => r.action === 'database.move_complete' || r.action === 'database.move_fail');
}

async function workspaceRow(w: MoveWorld) {
  const [row] = await w.masterDb.select().from(workspaces).where(eq(workspaces.id, WORKSPACE_ID));
  if (!row) throw new Error('no workspace row');
  return row;
}

/** Make the copy page through tables two rows at a time, so a move has many pages and progress saves. */
async function usePagesOf(w: MoveWorld, moveId: string, pageSize: number): Promise<void> {
  const row = await moveRow(w, moveId);
  const progress = row.progress;
  if (!progress) throw new Error('no progress to patch');
  await w.masterDb
    .update(workspaceDatabaseMoves)
    .set({ progress: { ...progress, tables: progress.tables.map((t) => ({ ...t, pageSize })) } })
    .where(eq(workspaceDatabaseMoves.id, moveId));
}

/** Count and checksum every table of both fixture databases and compare them. */
async function databasesMatch(w: MoveWorld): Promise<boolean> {
  const tables = await readTables(w.source.sql);
  const fromSource = await tableChecksums(w.source.sql, tables);
  const fromTarget = await tableChecksums(w.target.sql, tables);
  return compareChecksums(fromSource, fromTarget).ok;
}

// ── Happy paths ──────────────────────────────────────────────────────────

describe('MoveDatabaseWorkflow · happy path', () => {
  it('moves a shard database to a dedicated project: copy, verify, switch, 3 purges, old database stays locked', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    const before = await workspaceRow(w);
    const step = createFakeStep();

    const result = await launch(w, step, moveId);
    expect(result).toEqual({ moveId, status: 'completed' });

    // The workspace row now points at the target; what provisioning set is left alone.
    const after = await workspaceRow(w);
    expect(after).toMatchObject({
      neonProjectId: TARGET.project,
      neonBranchId: TARGET.branch,
      neonRoleName: TARGET.role,
      neonDatabaseName: TARGET.db,
      neonRegion: 'aws-eu-central-1',
      sharedProjectId: null,
      provisioningStatus: 'ready',
    });
    expect(after.databaseProvisionedAt).toEqual(before.databaseProvisionedAt);
    // The stored URL is the (encrypted) pooled target URL.
    expect(after.databaseUrl).not.toContain('postgres');
    expect(await w.deps.decryptUrl(after.databaseUrl ?? '', WORKSPACE_ID)).toBe(
      connectionUrl({ role: TARGET.role, password: `${SECRET_PREFIX}target-0`, db: TARGET.db, pooled: true }),
    );

    const move = await moveRow(w, moveId);
    expect(move).toMatchObject({ status: 'completed', kind: 'shard_to_dedicated', currentStep: 'completed', error: null });
    expect(move.targetDatabaseUrl).toBeNull();
    expect(move.switchedAt).toBeInstanceOf(Date);
    expect(move.completedAt).toBeInstanceOf(Date);
    expect(move.startedAt).toBeInstanceOf(Date);
    expect(move.softLockedAt).toBeInstanceOf(Date);
    expect(move.lockedAt).toBeInstanceOf(Date);
    const retainedMs = (move.oldDatabaseRetainedUntil?.getTime() ?? 0) - (move.completedAt?.getTime() ?? 0);
    expect(retainedMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(move.oldDatabaseDroppedAt).toBeNull();
    expect(move.verification?.ok).toBe(true);
    expect(move.verification?.sourceUnchanged).toBe(true);
    expect(move.verification?.tables.length).toBeGreaterThan(8);
    expect(move.progress?.prepared).toBe(true);
    expect(move.progress?.tables.every((t) => t.done)).toBe(true);
    expect(move.progress?.copiedRows).toBe(move.progress?.totalRows);

    // Same data on both sides, and the source was locked, never unlocked.
    expect(await databasesMatch(w)).toBe(true);
    expect(guardState.locked.has(SOURCE.db)).toBe(true);
    expect(guardState.log.filter((entry) => entry.startsWith('unlock'))).toEqual([]);
    expect(w.provisioning.rotateRolePassword).toHaveBeenCalledTimes(1);
    expect(w.provisioning.releaseMoveTarget).not.toHaveBeenCalled();
    expect(w.provisioning.restartDedicatedEndpoint).not.toHaveBeenCalled(); // a shard's compute serves other tenants

    // Caches are purged at the soft lock, at the lock (after the URL changed) and after the switch.
    expect(w.purges).toEqual([
      { workspaceId: WORKSPACE_ID, clerkOrgId: CLERK_ORG_ID },
      { workspaceId: WORKSPACE_ID, clerkOrgId: CLERK_ORG_ID },
      { workspaceId: WORKSPACE_ID, clerkOrgId: CLERK_ORG_ID },
    ]);

    // Order of the phases, and the two waits.
    const order = (name: string) => step.names.indexOf(name);
    expect(order('begin')).toBeLessThan(order('prepare-target'));
    expect(order('prepare-target')).toBeLessThan(order('soft-lock'));
    expect(order('soft-lock')).toBeLessThan(order('drain'));
    expect(order('drain')).toBeLessThan(order('lock-source'));
    expect(order('lock-source')).toBeLessThan(order('lock-settle'));
    expect(order('lock-settle')).toBeLessThan(order('lock-source-verify'));
    expect(order('lock-source-verify')).toBeLessThan(order('prepare-copy'));
    expect(order('record-source-checksums')).toBeLessThan(order('copy-0'));
    expect(order('copy-0')).toBeLessThan(order('finish-target-0'));
    expect(order('analyze-target')).toBeLessThan(order('verify-compare'));
    expect(order('verify-compare')).toBeLessThan(order('switch'));
    expect(order('switch')).toBeLessThan(order('purge-caches-after-switch'));
    expect(step.names).not.toContain('compensate');
    expect(step.sleeps).toEqual([
      { name: 'drain', duration: '90 seconds' },
      { name: 'lock-settle', duration: '3 seconds' },
    ]);

    // Nothing a step returned (they are stored by Cloudflare) holds a URL or a password.
    expect(inspect([...step.results.values()], { depth: 8 })).not.toMatch(/postgres|secret-/);
    expect(JSON.stringify(move)).not.toMatch(/postgres|secret-/);

    // The admin trail has one `database.move_complete`, attributed to the admin who started the move.
    const audit = await outcomeAudit(w);
    expect(audit).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        targetType: 'workspace',
        targetId: WORKSPACE_ID,
        action: 'database.move_complete',
        outcome: 'success',
        actorEmail: 'admin@weldsuite.org',
        reason: 'test',
        error: null,
        details: expect.objectContaining({
          moveId,
          kind: 'shard_to_dedicated',
          from: { neonProjectId: SOURCE.project, databaseName: SOURCE.db },
          to: { neonProjectId: TARGET.project, databaseName: TARGET.db },
          oldDatabaseRetainedUntil: move.oldDatabaseRetainedUntil?.toISOString(),
        }),
      }),
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/postgres|secret-/);
  });

  it('moves a dedicated database to a shard, and restarts the dedicated source\'s compute', async () => {
    const w = await setup({ sourceShard: null });
    const moveId = await startMove(w, 'shard:auto');

    const result = await launch(w, createFakeStep(), moveId);
    expect(result).toEqual({ moveId, status: 'completed' });

    expect(w.provisioning.prepareMoveTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceId: WORKSPACE_ID, target: { kind: 'shard' }, region: 'aws-eu-central-1' }),
    );
    expect(w.provisioning.restartDedicatedEndpoint).toHaveBeenCalledWith(expect.anything(), SOURCE.project);
    expect((await moveRow(w, moveId)).kind).toBe('dedicated_to_shard');
    expect(await workspaceRow(w)).toMatchObject({ neonDatabaseName: TARGET.db, sharedProjectId: TARGET.shard });
    expect(await databasesMatch(w)).toBe(true);
  });

  it('moves a shard database to another shard, excluding the shard it leaves', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'shard:auto');

    await launch(w, createFakeStep(), moveId);

    expect(w.provisioning.prepareMoveTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ target: { kind: 'shard', excludeShardId: SOURCE.shard } }),
    );
    expect((await moveRow(w, moveId)).kind).toBe('shard_to_shard');
    expect(await workspaceRow(w)).toMatchObject({ sharedProjectId: TARGET.shard });
  });

  it('lands on exactly the shard that was asked for', async () => {
    const w = await setup({ sourceShard: null });
    const moveId = await startMove(w, TARGET.shard);

    await launch(w, createFakeStep(), moveId);

    expect(w.provisioning.prepareMoveTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ target: { kind: 'shard', shardId: TARGET.shard } }),
    );
  });

  it('records the stored URL as the lock rotated it, and lets later steps connect with it', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    // Stop right after the lock: the workspace now carries the rotated source URL.
    const step = createFakeStep({
      after: {
        'lock-source-verify': ({ crash }) => crash(),
      },
    });
    const outcome = await Promise.race([launch(w, step, moveId), step.crashed]);
    expect(outcome).toBe(CRASHED);

    const stored = await w.deps.decryptUrl((await workspaceRow(w)).databaseUrl ?? '', WORKSPACE_ID);
    expect(stored).toBe(
      connectionUrl({ role: SOURCE.role, password: `${SECRET_PREFIX}rotated-1`, db: SOURCE.db, pooled: true }),
    );
    // The old URL is dead, as on Neon.
    await expect(
      w.deps
        .connect(connectionUrl({ role: SOURCE.role, password: `${SECRET_PREFIX}source-0`, db: SOURCE.db, pooled: true }))
        .query('SELECT 1'),
    ).rejects.toMatchObject({ code: '28P01' });
    expect((await moveRow(w, moveId)).status).toBe('locked');
  });
});

// ── Replay ───────────────────────────────────────────────────────────────

describe('MoveDatabaseWorkflow · replay', () => {
  it('resumes a crashed copy from the saved cursor: no duplicates, no gaps', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    // Two rows per page: `accounts` (123 rows) becomes 62 pages, saved every 20.
    const step = createFakeStep({ after: { 'prepare-copy': () => usePagesOf(w, moveId, 2) } });

    let crashedAtReads = -1;
    w.connections.hooks.onTargetInsert = async (count) => {
      if (count !== 45) return;
      crashedAtReads = w.connections.sourceReads.length;
      await step.crash();
    };
    const first = await Promise.race([launch(w, step, moveId), step.crashed]);
    expect(first).toBe(CRASHED);
    w.connections.hooks.onTargetInsert = null;

    // 44 pages were inserted; progress was saved after page 40: that is where the retry must start.
    const saved = (await moveRow(w, moveId)).progress?.tables.find((t) => t.table === 'accounts');
    expect(saved).toMatchObject({ rows: 80, cursor: JSON.stringify(['acc_0080']), done: false });
    expect((await moveRow(w, moveId)).status).toBe('copying');

    // The same Workflow instance resumes: finished steps return their stored results.
    const second = await launch(w, step, moveId);
    expect(second).toEqual({ moveId, status: 'completed' });

    const firstReadAfterCrash = w.connections.sourceReads.slice(crashedAtReads).find((r) => r.text.includes('"accounts"'));
    expect(firstReadAfterCrash?.params).toEqual(['acc_0080']);

    const move = await moveRow(w, moveId);
    expect(move.verification?.ok).toBe(true);
    expect(await databasesMatch(w)).toBe(true);
    const accounts = await w.target.sql.query('SELECT count(*)::text AS n, count(DISTINCT id)::text AS d FROM accounts');
    expect(accounts[0]).toEqual({ n: '123', d: '123' });
    // prepare-copy truncates: it ran once, not again for the retry.
    expect(step.attempts.get('prepare-copy')).toBe(1);
  });

  it('retries a failed step without redoing finished ones', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    // The target's first page insert fails once (a dropped connection), then works.
    let failed = false;
    w.connections.hooks.onTargetInsert = () => {
      if (failed) return;
      failed = true;
      throw new Error('connection reset');
    };
    const step = createFakeStep();

    const result = await launch(w, step, moveId);

    expect(result).toEqual({ moveId, status: 'completed' });
    expect(step.attempts.get('copy-0')).toBe(2);
    expect(step.attempts.get('soft-lock')).toBe(1);
    expect(w.provisioning.rotateRolePassword).toHaveBeenCalledTimes(1);
    expect(await databasesMatch(w)).toBe(true);
  });
});

// ── Failure: verification ────────────────────────────────────────────────

describe('MoveDatabaseWorkflow · a move that cannot be verified', () => {
  it('fails on a checksum mismatch: source unlocked, target released, workspace untouched', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    const step = createFakeStep({
      after: { 'analyze-target': () => w.target.exec(`UPDATE accounts SET name = 'tampered' WHERE id = 'acc_0001'`) },
    });

    await expect(launch(w, step, moveId)).rejects.toThrow(/Verification failed/);

    const move = await moveRow(w, moveId);
    expect(move.status).toBe('failed');
    expect(move.error).toMatch(/differs from the source in 1 table\(s\): accounts/);
    expect(move.targetDatabaseUrl).toBeNull();
    expect(move.verification?.ok).toBe(false);
    expect(move.verification?.tables.find((t) => t.table === 'accounts')?.ok).toBe(false);
    expect(move.switchedAt).toBeNull();
    expect(move.progress?.targetReleasedAt).toBeTruthy();

    // The source is writable again, through a URL that works.
    expect(guardState.log).toContain(`unlock:${SOURCE.db}`);
    expect(guardState.locked.has(SOURCE.db)).toBe(false);
    const ws = await workspaceRow(w);
    expect(ws).toMatchObject({ neonProjectId: SOURCE.project, neonDatabaseName: SOURCE.db, sharedProjectId: SOURCE.shard });
    await expect(w.deps.connect(directOf(await w.deps.decryptUrl(ws.databaseUrl ?? '', WORKSPACE_ID))).query('SELECT 1')).resolves.toBeDefined();

    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);
    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'dedicated', neonProjectId: TARGET.project, databaseName: TARGET.db, sharedProjectId: null }),
    );
    // Soft lock, lock, and the undo.
    expect(w.purges).toHaveLength(3);
    expect(step.names).toContain('compensate');
    expect(step.names).not.toContain('switch');

    // One `database.move_fail` with the stored error, attributed to the admin who started the move.
    expect(await outcomeAudit(w)).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        action: 'database.move_fail',
        outcome: 'failure',
        actorEmail: 'admin@weldsuite.org',
        error: move.error,
        details: expect.objectContaining({ moveId, kind: 'shard_to_dedicated', step: expect.any(String) }),
      }),
    ]);
  });

  it('fails when the source changed after the lock, even though the copy matches the first reading', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    const step = createFakeStep({
      after: { 'copy-0': () => w.source.exec(`INSERT INTO seeded_defaults (id, label) VALUES ('def_sneaky', 'written after the lock')`) },
    });

    await expect(launch(w, step, moveId)).rejects.toThrow(/source changed after the lock/);

    const move = await moveRow(w, moveId);
    expect(move.status).toBe('failed');
    expect(move.verification).toMatchObject({ ok: false, sourceUnchanged: false, sourceChangedTables: ['seeded_defaults'] });
    expect(move.error).not.toContain('sneaky'); // table names, never row contents
    expect(guardState.locked.has(SOURCE.db)).toBe(false);
    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);
  });

  it('keeps going when ANALYZE fails on the target, and says so in the verification', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    const realConnect = w.deps.connect;
    w.deps.connect = (url) => {
      const sql = realConnect(url);
      return {
        transaction: (statements) => sql.transaction(statements),
        query: (text, params) => {
          if (text.trim() === 'ANALYZE' && url.includes(TARGET.db)) {
            return Promise.reject(Object.assign(new Error(`canceling statement due to statement timeout: "secret row"`), { code: '57014' }));
          }
          return sql.query(text, params);
        },
      };
    };

    const result = await launch(w, createFakeStep(), moveId);

    expect(result).toEqual({ moveId, status: 'completed' });
    const move = await moveRow(w, moveId);
    expect(move.verification?.warnings).toEqual(['ANALYZE on the target failed (Database error 57014)']);
  });
});

// ── Failure: before the lock ─────────────────────────────────────────────

describe('MoveDatabaseWorkflow · refusing to start the downtime', () => {
  it('fails early, with nothing created or locked, when the source is behind the bundled migrations', async () => {
    const w = await setup({ bundledJournal: { count: FIXTURE_JOURNAL.count + 1, maxCreatedAt: '1700000200000' } });
    const moveId = await startMove(w, 'dedicated');

    await expect(launch(w, createFakeStep(), moveId)).rejects.toThrow(/not at the bundled migration level/);

    const move = await moveRow(w, moveId);
    expect(move.status).toBe('failed');
    expect(move.error).toContain('source: 2 entries');
    expect(move.error).toContain('bundled: 3 entries');
    expect(w.provisioning.prepareMoveTarget).not.toHaveBeenCalled();
    expect(w.provisioning.rotateRolePassword).not.toHaveBeenCalled();
    expect(w.provisioning.releaseMoveTarget).not.toHaveBeenCalled();
    expect(guardState.log).toEqual([]);
    expect(w.purges).toHaveLength(1); // only the undo
    expect(move.softLockedAt).toBeNull();
  });

  it('does not retry a failure a retry cannot fix', async () => {
    const w = await setup({ bundledJournal: { count: 99, maxCreatedAt: '1' } });
    const moveId = await startMove(w, 'dedicated');
    const step = createFakeStep();

    await expect(launch(w, step, moveId)).rejects.toThrow();

    expect(step.attempts.get('check-source')).toBe(1);
  });

  it('fails before the downtime when the target is at another migration level than the source', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    await w.target.exec(`INSERT INTO __drizzle_migrations (hash, created_at, tag) VALUES ('hash-2', 1700000200000, '0002_extra')`);

    await expect(launch(w, createFakeStep(), moveId)).rejects.toThrow(/JOURNAL_MISMATCH/);

    const move = await moveRow(w, moveId);
    expect(move.status).toBe('failed');
    expect(move.softLockedAt).toBeNull();
    expect(guardState.log).toEqual([]);
    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1); // the target was created, so it is returned
  });

  it('reuses the target a retried prepare-target step finds on the row instead of preparing another', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    // Attempt 1 prepares and records the target, then loses its result (the instance dies before the step returns).
    const step = createFakeStep({
      after: {
        'prepare-target': ({ crash }) => crash(),
      },
    });
    expect(await Promise.race([launch(w, step, moveId), step.crashed])).toBe(CRASHED);
    expect(w.provisioning.prepareMoveTarget).toHaveBeenCalledTimes(1);
    expect((await moveRow(w, moveId)).targetNeonProjectId).toBe(TARGET.project);

    // Replay: the step result was lost with the instance, so the step runs again.
    step.results.delete('prepare-target');
    const second = createFakeStep();
    for (const [name, value] of step.results) second.results.set(name, value);
    await launch(w, second, moveId);

    expect(w.provisioning.prepareMoveTarget).toHaveBeenCalledTimes(1);
    expect((await moveRow(w, moveId)).status).toBe('completed');
  });
});

// ── Failure: the lock ────────────────────────────────────────────────────

describe('MoveDatabaseWorkflow · a lock that does not hold', () => {
  it('fails when a fresh session on the source is still read-write, and unlocks the source again', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    guardState.probe = 'off';
    const step = createFakeStep();

    await expect(launch(w, step, moveId)).rejects.toThrow(/read-write mode after the lock/);

    // A guard that did not take effect may take effect on the next try: the step is retried (3 retries).
    expect(step.attempts.get('lock-source-verify')).toBe(4);
    expect((await moveRow(w, moveId)).status).toBe('failed');
    expect(guardState.locked.has(SOURCE.db)).toBe(false);
    expect(step.names).not.toContain('prepare-copy');
    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);
  });

  it('stops before the lock when the workspace was scheduled for deletion meanwhile', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    const step = createFakeStep({
      after: {
        'target-ready': async () => {
          await w.masterDb
            .update(workspaces)
            .set({ scheduledDeletionAt: new Date(Date.now() + 86_400_000) })
            .where(eq(workspaces.id, WORKSPACE_ID));
        },
      },
    });

    await expect(launch(w, step, moveId)).rejects.toThrow(/scheduled for deletion/);

    const move = await moveRow(w, moveId);
    expect(move.status).toBe('failed');
    expect(move.softLockedAt).toBeNull(); // nobody was refused a write for a workspace that is going away
    expect(move.lockedAt).toBeNull();
    expect(w.provisioning.rotateRolePassword).not.toHaveBeenCalled();
    expect(guardState.log).toEqual([]);
    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);
  });
});

// ── Cancel ───────────────────────────────────────────────────────────────

describe('MoveDatabaseWorkflow · cancel', () => {
  it('cancelled before the lock: nothing rotated or locked, target released, row cancelled', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    const step = createFakeStep({
      after: { drain: async () => void (await requestMoveCancel(w.env, moveId, { masterDb: w.masterDb })) },
    });

    const result = await launch(w, step, moveId);

    expect(result).toEqual({ moveId, status: 'cancelled' });
    const move = await moveRow(w, moveId);
    expect(move).toMatchObject({ status: 'cancelled', error: null, targetDatabaseUrl: null });
    expect(move.cancelRequestedAt).toBeInstanceOf(Date);
    expect(w.provisioning.rotateRolePassword).not.toHaveBeenCalled();
    expect(guardState.log).toEqual([]);
    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);
    expect(w.purges).toHaveLength(2); // soft lock, undo
    expect(step.names).not.toContain('prepare-copy');
    expect(await workspaceRow(w)).toMatchObject({ neonProjectId: SOURCE.project, neonDatabaseName: SOURCE.db });
    // A cancel is on the trail from the cancel request (the route), not as a failure.
    expect(await outcomeAudit(w)).toEqual([]);
  });

  it('cancelled during the copy: stops within a few pages, source unlocked, target released', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    const step = createFakeStep({ after: { 'prepare-copy': () => usePagesOf(w, moveId, 2) } });
    w.connections.hooks.onTargetInsert = async (count) => {
      if (count === 25) await requestMoveCancel(w.env, moveId, { masterDb: w.masterDb });
    };

    const result = await launch(w, step, moveId);

    expect(result).toEqual({ moveId, status: 'cancelled' });
    const move = await moveRow(w, moveId);
    expect(move.status).toBe('cancelled');
    // The next progress save (page 40) saw the cancel; not much was copied after the request.
    const progress = move.progress;
    expect(progress?.copiedRows).toBeGreaterThan(0);
    expect(progress?.copiedRows).toBeLessThan(progress?.totalRows ?? 0);
    expect(guardState.log).toContain(`lock:${SOURCE.db}`);
    expect(guardState.log).toContain(`unlock:${SOURCE.db}`);
    expect(guardState.locked.has(SOURCE.db)).toBe(false);
    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);
    expect(step.attempts.get('copy-0')).toBe(1); // a cancel is not retried
    expect(step.names).not.toContain('switch');
    expect(await workspaceRow(w)).toMatchObject({ neonProjectId: SOURCE.project, neonDatabaseName: SOURCE.db });
  });

  it('cancelled between steps after the lock: the undo unlocks even though the cancel flipped the status', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    const step = createFakeStep({
      after: { 'record-source-checksums': async () => void (await requestMoveCancel(w.env, moveId, { masterDb: w.masterDb })) },
    });

    expect(await launch(w, step, moveId)).toEqual({ moveId, status: 'cancelled' });

    expect(guardState.locked.has(SOURCE.db)).toBe(false);
    expect((await moveRow(w, moveId)).status).toBe('cancelled');
  });

  it('a cancel that arrives once the switch began is refused, and the move completes', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    let refused: unknown;
    w.master.hooks.beforeBatch = async () => {
      refused = await requestMoveCancel(w.env, moveId, { masterDb: w.masterDb }).catch((e: unknown) => e);
    };

    const result = await launch(w, createFakeStep(), moveId);

    expect(result).toEqual({ moveId, status: 'completed' });
    expect(refused).toMatchObject({ code: 'MOVE_NOT_CANCELLABLE' });
    expect(await workspaceRow(w)).toMatchObject({ neonDatabaseName: TARGET.db });
  });
});

// ── Failure: the switch ──────────────────────────────────────────────────

describe('MoveDatabaseWorkflow · the switch', () => {
  it('fails, and records no switch, when the workspace changed under the move', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    // Between the check that the workspace is still on the source and the compare-and-set itself.
    w.master.hooks.beforeBatch = async () => {
      await w.masterDb.update(workspaces).set({ neonDatabaseName: 'moved_elsewhere' }).where(eq(workspaces.id, WORKSPACE_ID));
    };
    const step = createFakeStep();

    await expect(launch(w, step, moveId)).rejects.toThrow(/workspace changed while the database was being copied/);

    const move = await moveRow(w, moveId);
    expect(move.status).toBe('failed');
    expect(move.switchedAt).toBeNull();
    expect(move.completedAt).toBeNull();
    expect(move.oldDatabaseRetainedUntil).toBeNull();
    expect(move.targetDatabaseUrl).toBeNull();
    // The compare-and-set swapped nothing: the workspace is as the other writer left it.
    const ws = await workspaceRow(w);
    expect(ws).toMatchObject({ neonProjectId: SOURCE.project, neonDatabaseName: 'moved_elsewhere', sharedProjectId: SOURCE.shard });
    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1);
    expect(step.names).not.toContain('purge-caches-after-switch');
  });

  it('finds an already committed switch when the switch step is retried, and does not undo it', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    // The switch commits, then the step attempt dies before Cloudflare stores its result.
    const step = createFakeStep({
      after: {
        switch: ({ crash }) => crash(),
      },
    });
    expect(await Promise.race([launch(w, step, moveId), step.crashed])).toBe(CRASHED);
    expect((await moveRow(w, moveId)).status).toBe('completed');

    step.results.delete('switch');
    const second = createFakeStep();
    for (const [name, value] of step.results) second.results.set(name, value);
    const result = await launch(w, second, moveId);

    expect(result).toEqual({ moveId, status: 'completed' });
    expect(await workspaceRow(w)).toMatchObject({ neonDatabaseName: TARGET.db });
    expect(w.provisioning.releaseMoveTarget).not.toHaveBeenCalled();
    expect(guardState.log.filter((entry) => entry.startsWith('unlock'))).toEqual([]);
    expect(second.names).not.toContain('compensate');
    // The first attempt died before it could record the completion: the retry records it, once.
    expect((await outcomeAudit(w)).map((r) => r.action)).toEqual(['database.move_complete']);
  });

  it('records the completion once however often the switch step runs', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    await launch(w, createFakeStep(), moveId);
    expect(await outcomeAudit(w)).toHaveLength(1);

    // A replay of the switch step after the commit (the step ran again) finds the row and writes nothing new.
    const { switchToTarget } = await import('../services/database-move/steps');
    await switchToTarget(w.deps, moveId);
    await switchToTarget(w.deps, moveId);

    expect(await outcomeAudit(w)).toHaveLength(1);
  });
});

// ── Compensation ─────────────────────────────────────────────────────────

describe('MoveDatabaseWorkflow · undoing', () => {
  it('compensation can run again: it finds the work done and closes nothing twice', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    const step = createFakeStep({
      after: { 'analyze-target': () => w.target.exec(`UPDATE accounts SET name = 'tampered' WHERE id = 'acc_0001'`) },
    });
    await expect(launch(w, step, moveId)).rejects.toThrow();
    const failed = await moveRow(w, moveId);

    const again = await compensateDatabaseMove(w.deps, moveId);

    expect(again).toEqual({ status: 'failed', sourceUnlocked: true, targetReleased: false });
    expect(w.provisioning.releaseMoveTarget).toHaveBeenCalledTimes(1); // not dropped a second time
    const row = await moveRow(w, moveId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe(failed.error);
    expect(guardState.locked.has(SOURCE.db)).toBe(false);
    // And the trail still has one `database.move_fail`.
    expect((await outcomeAudit(w)).map((r) => r.action)).toEqual(['database.move_fail']);
  });

  it('never undoes a completed move', async () => {
    const w = await setup();
    const moveId = await startMove(w, 'dedicated');
    await launch(w, createFakeStep(), moveId);

    const result = await compensateDatabaseMove(w.deps, moveId, { error: 'late failure' });

    expect(result).toEqual({ status: 'completed', sourceUnlocked: false, targetReleased: false });
    expect((await moveRow(w, moveId)).status).toBe('completed');
    expect(guardState.locked.has(SOURCE.db)).toBe(true); // the old database stays locked until the sweep drops it
    expect(w.provisioning.releaseMoveTarget).not.toHaveBeenCalled();
    expect((await outcomeAudit(w)).map((r) => r.action)).toEqual(['database.move_complete']); // never a fail row
  });
});

/** The direct form of a pooled URL, the way the Workflow derives it. */
function directOf(pooledUrl: string): string {
  return pooledUrl.replace('-pooler', '');
}
