/**
 * MoveDatabaseWorkflow: moves a workspace's tenant database between a shared
 * Neon shard and a dedicated Neon project, or between shards (TASK-1150, ADR
 * DATA-016). The instance id is the `workspace_database_moves` row id, and the
 * row is the durable state; this class only decides the order of the steps,
 * their names, the sleeps and the retry settings. What a step does lives in
 * `services/database-move/steps.ts`.
 *
 * The sequence:
 *
 *   preparing     check the source, create or claim the target, migrate it to
 *                 the source's level (no downtime yet; a cancel costs nothing)
 *   soft lock     the move row says `soft_locked`: first-party APIs answer 503
 *                 WORKSPACE_MOVING for writes; caches purged
 *   drain         sleep 90 s while in-flight requests finish
 *   lock          rotate the SOURCE role's password, store the new URL on the
 *                 workspace row, purge, make the database read-only, end its
 *                 sessions, (dedicated source: restart the compute), verify
 *   copy          prepare the target once, checksum the source, copy table by
 *                 table in resumable steps
 *   verify        finish the target (keys, triggers, views), ANALYZE, checksum
 *                 the target and the source again, compare
 *   switch        one compare-and-set on `workspaces`; the OLD database stays
 *                 locked and is dropped by the retention sweep later
 *
 * Failure and cancel: any step that fails for good (or a cancel noticed at a
 * step boundary) ends in `compensate`, which unlocks the source, releases the
 * target and closes the row. After the switch nothing is ever undone: the only
 * step left is a cache purge whose failure is ignored.
 *
 * Replay: Cloudflare re-runs this method from the top on every resume and
 * returns the stored result of each finished step, so everything outside a
 * `step.do` must be a pure function of those results. Loops therefore name
 * their steps by index (`copy-3`), and state a later step needs (the checksum
 * maps) is rebuilt from the results of earlier ones.
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from '../index';
import type { ChecksumMap } from '../lib/database-move';
import { compensateDatabaseMove } from '../services/database-move/compensate';
import { createMoveDeps, type MoveDeps } from '../services/database-move/deps';
import { MOVE_CANCELLED_MESSAGE, MoveFlowError } from '../services/database-move/errors';
import { describeFailure, isPermanentFailure, storedMessageOf } from '../services/database-move/failure';
import * as steps from '../services/database-move/steps';

export interface MoveDatabaseParams {
  moveId: string;
}

// ── Step settings ────────────────────────────────────────────────────────

const LIGHT: WorkflowStepConfig = { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } };
/** Steps that call the Neon API (create, rotate, restart): slower, and worth a longer pause between tries. */
const NEON: WorkflowStepConfig = {
  retries: { limit: 3, delay: '15 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};
const MIGRATE: WorkflowStepConfig = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '15 minutes',
};
const COPY: WorkflowStepConfig = {
  retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' },
  timeout: '15 minutes',
};
/** ANALYZE only refreshes planner statistics: it gets one retry and a short leash, and its failure is a warning. */
const ANALYZE: WorkflowStepConfig = {
  retries: { limit: 1, delay: '5 seconds' },
  timeout: '5 minutes',
};
/** The undo is what restores service, so it is the last thing to give up. */
const COMPENSATE: WorkflowStepConfig = {
  retries: { limit: 6, delay: '20 seconds', backoff: 'exponential' },
  timeout: '15 minutes',
};

/** Loop ceilings: a step count the move cannot reasonably reach; hitting one is a bug, not a slow database. */
const MAX_MIGRATION_STEPS = 40;
const MAX_COPY_STEPS = 700;
const MAX_FINISH_STEPS = 40;

// ── Error plumbing ───────────────────────────────────────────────────────

/**
 * What leaves a step. The original error can carry a SQL statement with its
 * parameters, a Neon response or a connection string, and Cloudflare stores
 * and logs whatever a step throws, so the error is replaced by its
 * `describeFailure` text. Failures a retry cannot fix become a
 * `NonRetryableError` (the step then fails at once), and keep their class name
 * so the cause stays recognisable after the error crosses the step boundary.
 */
function toStepError(err: unknown): Error {
  const message = describeFailure(err);
  if (isPermanentFailure(err)) return new NonRetryableError(message, err instanceof Error ? err.name : undefined);
  return new Error(message);
}

function guarded<T>(fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      throw toStepError(err);
    }
  };
}

function tooManySteps(what: string): MoveFlowError {
  return new MoveFlowError('VERIFICATION_FAILED', `The ${what} did not finish within its step limit`);
}

// ── Workflow ─────────────────────────────────────────────────────────────

export class MoveDatabaseWorkflow extends WorkflowEntrypoint<Env, MoveDatabaseParams> {
  async run(event: WorkflowEvent<MoveDatabaseParams>, step: WorkflowStep) {
    const { moveId } = event.payload;
    const deps = createMoveDeps(this.env);
    console.log(`[MoveDatabase] Starting move ${moveId}`);

    let switched = false;
    try {
      await this.moveSteps(deps, moveId, step);
      switched = true;
    } catch (err) {
      const message = storedMessageOf(err);
      const cancelled = message === MOVE_CANCELLED_MESSAGE;
      console.error(`[MoveDatabase] Move ${moveId} ${cancelled ? 'was cancelled' : 'failed'}: ${message}`);

      const undone = await step.do(
        'compensate',
        COMPENSATE,
        guarded(() =>
          compensateDatabaseMove(deps, moveId, {
            error: cancelled ? null : message,
            ...(cancelled ? { outcome: 'cancelled' as const } : {}),
          }),
        ),
      );
      if (undone.status === 'completed') {
        // The switch had committed before the error: the move succeeded, so nothing was undone.
        switched = true;
      } else if (undone.status === 'cancelled') {
        console.log(`[MoveDatabase] Move ${moveId} cancelled; the workspace is back on its original database`);
        return { moveId, status: 'cancelled' as const };
      } else {
        // Rethrow so Cloudflare marks the instance errored. The row already says `failed`.
        throw err;
      }
    }

    if (switched) {
      // The switch is committed; nothing below may undo it, and a failed purge only means entries expire on their TTL.
      await step
        .do('purge-caches-after-switch', LIGHT, guarded(() => steps.purgeAfterSwitch(deps, moveId)))
        .catch((err) => console.warn(`[MoveDatabase] Cache purge after the switch failed: ${storedMessageOf(err)}`));
      console.log(`[MoveDatabase] Move ${moveId} completed`);
    }
    return { moveId, status: 'completed' as const };
  }

  /** Everything up to and including the switch. Throws on any failure or cancel; the caller compensates. */
  private async moveSteps(deps: MoveDeps, moveId: string, step: WorkflowStep): Promise<void> {
    // ── Preparing: no downtime yet ─────────────────────────────────────
    await step.do('begin', LIGHT, guarded(() => steps.beginMove(deps, moveId)));
    await step.do('check-source', NEON, guarded(() => steps.checkSource(deps, moveId)));
    await step.do('prepare-target', NEON, guarded(() => steps.prepareTarget(deps, moveId)));

    for (let batch = 0; ; batch++) {
      if (batch >= MAX_MIGRATION_STEPS) throw tooManySteps('target migration');
      const name = `migrate-target-${batch}`;
      const migrated = await step.do(name, MIGRATE, guarded(() => steps.migrateTarget(deps, moveId, name)));
      if (migrated.remaining === 0) break;
    }
    await step.do('target-ready', LIGHT, guarded(() => steps.checkTargetLevel(deps, moveId)));

    // ── Soft lock and drain ────────────────────────────────────────────
    await step.do('soft-lock', LIGHT, guarded(() => steps.softLock(deps, moveId)));
    await step.sleep('drain', `${steps.DRAIN_SECONDS} seconds`);

    // ── Lock the source ────────────────────────────────────────────────
    await step.do('lock-source', NEON, guarded(() => steps.lockSourcePartOne(deps, moveId)));
    await step.sleep('lock-settle', `${steps.LOCK_SETTLE_SECONDS} seconds`);
    await step.do('lock-source-verify', NEON, guarded(() => steps.lockSourcePartTwo(deps, moveId)));

    // ── Copy ───────────────────────────────────────────────────────────
    const plan = await step.do('prepare-copy', COPY, guarded(() => steps.prepareCopy(deps, moveId)));

    const sourceBefore = await this.checksumPass(deps, moveId, step, 'source', 'checksums-source', plan.checksumGroups);
    await step.do('record-source-checksums', LIGHT, guarded(() => steps.recordSourceChecksums(deps, moveId, sourceBefore)));

    for (let chunk = 0; ; chunk++) {
      if (chunk >= MAX_COPY_STEPS) throw tooManySteps('copy');
      const name = `copy-${chunk}`;
      const copied = await step.do(name, COPY, guarded(() => steps.copyChunk(deps, moveId, name)));
      if (copied.done) break;
    }

    // ── Verify ─────────────────────────────────────────────────────────
    for (let part = 0; ; part++) {
      if (part >= MAX_FINISH_STEPS) throw tooManySteps('finishing of the target');
      const name = `finish-target-${part}`;
      const finished = await step.do(name, COPY, guarded(() => steps.finishTargetStep(deps, moveId, name)));
      if (finished.complete) break;
    }
    const analysed = await step
      .do('analyze-target', ANALYZE, guarded(() => steps.analyzeTarget(deps, moveId)))
      .catch((err: unknown) => {
        // A cancel must stop the move; anything else (a timeout, a dropped connection) only costs the statistics,
        // and the steps that follow check the move again themselves.
        if (storedMessageOf(err) === MOVE_CANCELLED_MESSAGE) throw err;
        return { analysed: false, warning: `ANALYZE on the target did not finish (${storedMessageOf(err)})` };
      });

    const targetSums = await this.checksumPass(deps, moveId, step, 'target', 'checksums-target', plan.checksumGroups);
    const sourceAfter = await this.checksumPass(deps, moveId, step, 'source', 'checksums-source-after', plan.checksumGroups);
    await step.do(
      'verify-compare',
      LIGHT,
      guarded(() =>
        steps.verifyMove(deps, moveId, {
          sourceBefore,
          target: targetSums,
          sourceAfter,
          warnings: analysed.warning ? [analysed.warning] : [],
        }),
      ),
    );

    // ── Switch ─────────────────────────────────────────────────────────
    await step.do('switch', LIGHT, guarded(() => steps.switchToTarget(deps, moveId)));
  }

  /** One checksum pass over every group, merged. Each group is its own step so one slow table cannot stall the rest. */
  private async checksumPass(
    deps: MoveDeps,
    moveId: string,
    step: WorkflowStep,
    side: steps.ChecksumSide,
    prefix: string,
    groups: number,
  ): Promise<ChecksumMap> {
    const merged: ChecksumMap = {};
    for (let group = 0; group < groups; group++) {
      const name = `${prefix}-${group}`;
      const part = await step.do(name, COPY, guarded(() => steps.checksumGroup(deps, moveId, name, side, group)));
      Object.assign(merged, part);
    }
    return merged;
  }
}
