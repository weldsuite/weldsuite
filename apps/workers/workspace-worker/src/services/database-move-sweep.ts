/**
 * Daily sweep after database moves (TASK-1150, ADR DATA-016):
 *
 *  1. Retention. A completed move leaves the OLD database in place, locked and
 *     read-only, until `old_database_retained_until`. This drops the ones whose
 *     time is up (Neon database + role in a shard, the whole project when it
 *     was dedicated) and records `old_database_dropped_at`, or the reason it
 *     could not, in `old_database_drop_error`.
 *  2. Watchdog. A move that is live but has not touched its row for hours has
 *     probably lost its Workflow. It is logged and its `current_step` says so;
 *     it is NOT failed here: an admin looks at it and uses Recover, because
 *     only a human knows whether the Workflow is really gone.
 *
 * What stops a drop (the safety is checked first, every run, from the master
 * rows, not from what the move believed when it completed):
 *  - any workspace row still pointing at the source coordinates (a move that
 *    "completed" but whose switch was undone by hand, a restore, a bug). The
 *    database is left alone and the row says why, loudly;
 *  - nothing else is assumed: a Neon 404 means somebody already dropped it and
 *    counts as done (`ignoreMissing`).
 *
 * One bad move never stops the rest, and a run does a bounded amount of work
 * (a batch of drops, each a handful of Neon calls) so it fits the cron's
 * subrequest budget; what is left is picked up the next day.
 */

import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  ACTIVE_DATABASE_MOVE_STATUSES,
  databasePool,
  workspaceDatabaseMoves,
  workspaces,
  type WorkspaceDatabaseMove,
} from '@weldsuite/db/schema/master';
import { createProvisioningService, type DatabaseProvisioningService } from '@weldsuite/neon-provisioning';
import { getMasterDb, type MasterDatabase } from '../db';
import type { Env } from '../index';
import { describeFailure } from './database-move/failure';

const m = workspaceDatabaseMoves;

/** Old databases dropped per run. */
export const RETENTION_BATCH_LIMIT = 10;
/** A live move untouched for this long is reported as stalled. */
export const STALLED_AFTER_MS = 6 * 60 * 60 * 1000;
/** A note on `current_step` (a varchar(60)) that keeps the step the move was on: `stalled (was: copy-12)`. */
const STALLED_PREFIX = 'stalled';

export interface MoveSweepOptions {
  /** Master DB; defaults to the Worker's own. */
  masterDb?: MasterDatabase;
  /** The part of the provisioning service the drop uses; defaults to one built from the Worker env. */
  provisioning?: Pick<DatabaseProvisioningService, 'dropDatabaseAt'>;
  now?: () => Date;
  batchLimit?: number;
  stalledAfterMs?: number;
}

export interface RetentionSweepResult {
  /** Moves whose retention had run out and that were looked at this run. */
  due: number;
  dropped: number;
  /** Left alone because a workspace still points at the old database. */
  skipped: number;
  failed: number;
}

export interface StalledMove {
  moveId: string;
  workspaceId: string;
  status: string;
  lastUpdate: string;
}

export interface DatabaseMoveSweepResult {
  retention: RetentionSweepResult;
  stalled: StalledMove[];
}

// ── Retention ────────────────────────────────────────────────────────────

/** Does any workspace row still point at the database this move left behind? */
async function sourceStillInUse(db: MasterDatabase, move: WorkspaceDatabaseMove): Promise<boolean> {
  // A dedicated source is a whole Neon project: any workspace on it is in use. A shard source is one database in
  // a shard other tenants live in, so only a workspace on that very database counts.
  const onSource = move.sourceSharedProjectId
    ? and(eq(workspaces.neonProjectId, move.sourceNeonProjectId), eq(workspaces.neonDatabaseName, move.sourceDatabaseName))
    : eq(workspaces.neonProjectId, move.sourceNeonProjectId);
  const [row] = await db.select({ id: workspaces.id }).from(workspaces).where(onSource).limit(1);
  return Boolean(row);
}

/** The `database_pool` row that tracked the source database (a slot claimed at provisioning), if any. */
async function sourcePoolId(db: MasterDatabase, move: WorkspaceDatabaseMove): Promise<string | undefined> {
  const [row] = await db
    .select({ id: databasePool.id })
    .from(databasePool)
    .where(
      and(eq(databasePool.neonProjectId, move.sourceNeonProjectId), eq(databasePool.databaseName, move.sourceDatabaseName)),
    )
    .limit(1);
  return row?.id;
}

type Outcome = 'dropped' | 'skipped' | 'failed';

async function dropRetainedDatabase(
  db: MasterDatabase,
  provisioning: Pick<DatabaseProvisioningService, 'dropDatabaseAt'>,
  move: WorkspaceDatabaseMove,
  now: Date,
): Promise<Outcome> {
  const recordError = (message: string) =>
    db.update(m).set({ oldDatabaseDropError: message }).where(eq(m.id, move.id));

  try {
    if (await sourceStillInUse(db, move)) {
      const message = 'Not dropped: a workspace still points at the old database';
      console.error(`[DatabaseMoveSweep] Move ${move.id}: ${message} (workspace ${move.workspaceId})`);
      await recordError(message);
      return 'skipped';
    }

    await provisioning.dropDatabaseAt(
      db,
      {
        neonProjectId: move.sourceNeonProjectId,
        neonBranchId: move.sourceNeonBranchId,
        databaseName: move.sourceDatabaseName,
        roleName: move.sourceRoleName,
        sharedProjectId: move.sourceSharedProjectId,
        poolId: await sourcePoolId(db, move),
      },
      { ignoreMissing: true },
    );
    await db.update(m).set({ oldDatabaseDroppedAt: now, oldDatabaseDropError: null }).where(eq(m.id, move.id));
    return 'dropped';
  } catch (err) {
    const message = describeFailure(err);
    console.error(`[DatabaseMoveSweep] Move ${move.id}: dropping the old database failed: ${message}`);
    try {
      await recordError(message);
    } catch (recordErr) {
      console.error(`[DatabaseMoveSweep] Move ${move.id}: could not record the failure: ${describeFailure(recordErr)}`);
    }
    return 'failed';
  }
}

/**
 * Drop the old database of every completed move whose retention is over (at
 * most `batchLimit` per run, those that never failed first, then the oldest).
 */
export async function sweepRetainedDatabases(
  env: Env,
  options: MoveSweepOptions = {},
): Promise<RetentionSweepResult> {
  const db = options.masterDb ?? getMasterDb(env);
  const now = (options.now ?? (() => new Date()))();
  const provisioning =
    options.provisioning ??
    createProvisioningService({
      NEON_API_KEY: env.NEON_API_KEY,
      NEON_ORG_ID: env.NEON_ORG_ID,
      NEON_DEFAULT_REGION: env.NEON_DEFAULT_REGION,
    });

  const due = await db
    .select()
    .from(m)
    .where(and(eq(m.status, 'completed'), isNull(m.oldDatabaseDroppedAt), lt(m.oldDatabaseRetainedUntil, now)))
    // A move that already failed once goes after the ones never tried, so a few stuck rows cannot starve the rest.
    .orderBy(sql`${m.oldDatabaseDropError} is not null`, asc(m.oldDatabaseRetainedUntil))
    .limit(options.batchLimit ?? RETENTION_BATCH_LIMIT);

  const result: RetentionSweepResult = { due: due.length, dropped: 0, skipped: 0, failed: 0 };
  for (const move of due) {
    const outcome = await dropRetainedDatabase(db, provisioning, move, now);
    result[outcome] += 1;
  }
  return result;
}

// ── Watchdog ─────────────────────────────────────────────────────────────

/**
 * Note, on every live move that has not been touched for `stalledAfterMs`, that
 * it looks stalled, and return them. Idempotent: a move already noted is
 * reported again but not rewritten, and `updated_at` is left alone so the
 * console keeps showing how long it has really been quiet. Does not fail the
 * move.
 */
export async function flagStalledMoves(env: Env, options: MoveSweepOptions = {}): Promise<StalledMove[]> {
  const db = options.masterDb ?? getMasterDb(env);
  const now = (options.now ?? (() => new Date()))();
  const threshold = new Date(now.getTime() - (options.stalledAfterMs ?? STALLED_AFTER_MS));

  const quiet = and(
    inArray(m.status, [...ACTIVE_DATABASE_MOVE_STATUSES]),
    lt(m.updatedAt, threshold),
  );

  // Newly stalled: write the note in the same statement that selects them (no step it advanced to is overwritten).
  const flagged = await db
    .update(m)
    .set({ currentStep: sql`left('stalled (was: ' || coalesce(${m.currentStep}, '-') || ')', 60)` })
    .where(and(quiet, or(isNull(m.currentStep), sql`${m.currentStep} not like ${STALLED_PREFIX + '%'}`)))
    .returning({ id: m.id });
  const flaggedNow = new Set(flagged.map((row) => row.id));

  const stalled = await db
    .select({ id: m.id, workspaceId: m.workspaceId, status: m.status, updatedAt: m.updatedAt })
    .from(m)
    .where(quiet)
    .orderBy(asc(m.updatedAt));

  for (const move of stalled) {
    console.warn(
      `[DatabaseMoveSweep] Move ${move.id} (workspace ${move.workspaceId}) has been ${move.status} without progress ` +
        `since ${move.updatedAt.toISOString()}${flaggedNow.has(move.id) ? '' : ' (already flagged)'}; use Recover if its Workflow is gone`,
    );
  }
  return stalled.map((move) => ({
    moveId: move.id,
    workspaceId: move.workspaceId,
    status: move.status,
    lastUpdate: move.updatedAt.toISOString(),
  }));
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * The daily cron's call: retention, then the watchdog, each in its own
 * try/catch so one failing never skips the other. Never throws.
 */
export async function runDatabaseMoveSweep(
  env: Env,
  options: MoveSweepOptions = {},
): Promise<DatabaseMoveSweepResult> {
  const result: DatabaseMoveSweepResult = {
    retention: { due: 0, dropped: 0, skipped: 0, failed: 0 },
    stalled: [],
  };

  try {
    result.retention = await sweepRetainedDatabases(env, options);
    const { due, dropped, skipped, failed } = result.retention;
    console.log(`[DatabaseMoveSweep] Retention: ${due} due, ${dropped} dropped, ${skipped} skipped, ${failed} failed`);
  } catch (err) {
    console.error(`[DatabaseMoveSweep] Retention sweep failed: ${describeFailure(err)}`);
  }

  try {
    result.stalled = await flagStalledMoves(env, options);
  } catch (err) {
    console.error(`[DatabaseMoveSweep] Stalled-move check failed: ${describeFailure(err)}`);
  }

  return result;
}
