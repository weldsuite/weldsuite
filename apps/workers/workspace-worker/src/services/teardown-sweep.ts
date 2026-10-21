/**
 * Teardown retry sweep: the backstop for workspace database teardowns that
 * never finished.
 *
 * A deleted workspace's database is torn down by the Clerk `organization.deleted`
 * handler (routes/webhooks/clerk.ts), which answers 500 when the teardown
 * fails so Svix redelivers. Svix gives up after about a day (it retries 5s, 5m,
 * 30m, 2h, 5h, 10h and 10h after the first attempt: ~27.6h). From then on
 * nothing retried it, and the workspace kept its `neon_project_id`, its
 * 'assigned' pool row, its shard slot and its role for good (production,
 * 2026-10-20).
 *
 * This sweep finds deleted workspaces that still hold a database and runs
 * `deleteWorkspaceDatabase` for them again; since PR #1222 a retry finishes a
 * half-done teardown (a database already gone is not an error).
 *
 * What it picks: `deleted_at` set more than {@link TEARDOWN_RETRY_AFTER_MS} ago,
 * `is_active = false`, `neon_project_id` still set.
 *  - The margin outlasts Svix's whole retry window, so the sweep never runs a
 *    teardown at the same time as a webhook redelivery (two concurrent drops
 *    could count a shard slot back twice).
 *  - `is_active = false` keeps a workspace that was restored by hand out of it.
 *  - A workspace whose database is being moved is left for a later run: the move
 *    owns the database until it ends.
 *
 * One failure never stops the rest, a run does a bounded amount of work (each
 * teardown is a handful of Neon calls, within the cron's subrequest budget),
 * and it never throws.
 */

import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { workspaces } from '@weldsuite/db/schema/master';
import { createProvisioningService, type DatabaseProvisioningService } from '@weldsuite/neon-provisioning';
import { getMasterDb, type MasterDatabase } from '../db';
import type { Env } from '../index';
import { describeFailure } from './database-move/failure';
import { hasActiveMove } from './database-move/state';

/** Teardowns retried per run. */
export const TEARDOWN_BATCH_LIMIT = 10;
/** How long after `deleted_at` a teardown is retried: past Svix's ~27.6h retry window, with room to spare. */
export const TEARDOWN_RETRY_AFTER_MS = 48 * 60 * 60 * 1000;

export interface TeardownSweepOptions {
  /** Master DB; defaults to the Worker's own. */
  masterDb?: MasterDatabase;
  /** The part of the provisioning service the retry uses; defaults to one built from the Worker env. */
  provisioning?: Pick<DatabaseProvisioningService, 'deleteWorkspaceDatabase'>;
  now?: () => Date;
  batchLimit?: number;
  retryAfterMs?: number;
}

export interface TeardownSweepResult {
  /** Deleted workspaces still holding a database that were looked at this run. */
  due: number;
  succeeded: number;
  failed: number;
  /** Skipped because a database move is in progress; picked up by a later run. */
  deferred: number;
}

type Outcome = 'succeeded' | 'failed' | 'deferred';

async function retryTeardown(
  db: MasterDatabase,
  provisioning: Pick<DatabaseProvisioningService, 'deleteWorkspaceDatabase'>,
  workspaceId: string,
  now: Date,
): Promise<Outcome> {
  try {
    if (await hasActiveMove(db, workspaceId)) {
      console.warn(`[TeardownSweep] Workspace ${workspaceId} has a database move in progress, deferring its teardown`);
      return 'deferred';
    }

    const result = await provisioning.deleteWorkspaceDatabase(db, workspaceId);
    if (result.success) {
      console.log(`[TeardownSweep] Finished the database teardown of deleted workspace ${workspaceId}`);
      return 'succeeded';
    }
    console.error(`[TeardownSweep] Database teardown of deleted workspace ${workspaceId} failed again: ${result.error}`);
  } catch (err) {
    console.error(`[TeardownSweep] Database teardown of deleted workspace ${workspaceId} failed again: ${describeFailure(err)}`);
  }

  // A workspace whose retry failed goes to the back of the queue, so a few stuck rows cannot starve the rest.
  try {
    await db.update(workspaces).set({ updatedAt: now }).where(eq(workspaces.id, workspaceId));
  } catch (err) {
    console.error(`[TeardownSweep] Workspace ${workspaceId}: could not requeue it: ${describeFailure(err)}`);
  }
  return 'failed';
}

/**
 * Retry the database teardown of every deleted workspace that still holds one
 * (at most `batchLimit` per run, longest untouched first). Never throws.
 */
export async function sweepUnfinishedTeardowns(
  env: Env,
  options: TeardownSweepOptions = {},
): Promise<TeardownSweepResult> {
  const result: TeardownSweepResult = { due: 0, succeeded: 0, failed: 0, deferred: 0 };

  try {
    if (!options.provisioning && !env.NEON_API_KEY) {
      console.log('[TeardownSweep] NEON_API_KEY is not set, skipping');
      return result;
    }
    const db = options.masterDb ?? getMasterDb(env);
    const now = (options.now ?? (() => new Date()))();
    const deletedBefore = new Date(now.getTime() - (options.retryAfterMs ?? TEARDOWN_RETRY_AFTER_MS));
    const provisioning =
      options.provisioning ??
      createProvisioningService({
        NEON_API_KEY: env.NEON_API_KEY,
        NEON_ORG_ID: env.NEON_ORG_ID,
        NEON_DEFAULT_REGION: env.NEON_DEFAULT_REGION || 'aws-eu-central-1',
      });

    const due = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(
        isNotNull(workspaces.deletedAt),
        lt(workspaces.deletedAt, deletedBefore),
        eq(workspaces.isActive, false),
        isNotNull(workspaces.neonProjectId),
      ))
      .orderBy(asc(workspaces.updatedAt), asc(workspaces.id))
      .limit(options.batchLimit ?? TEARDOWN_BATCH_LIMIT);

    result.due = due.length;
    for (const workspace of due) {
      const outcome = await retryTeardown(db, provisioning, workspace.id, now);
      result[outcome] += 1;
    }
  } catch (err) {
    console.error(`[TeardownSweep] Sweep failed: ${describeFailure(err)}`);
  }

  const { due, succeeded, failed, deferred } = result;
  console.log(`[TeardownSweep] Done: ${due} due, ${succeeded} succeeded, ${failed} failed, ${deferred} deferred`);
  return result;
}
