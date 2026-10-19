/**
 * Undoing a move that did not reach the switch: the compensation the Workflow
 * runs when a step fails for good or the move is cancelled, and the recovery
 * the admin "unlock" route calls for a move that got stuck.
 *
 * It restores service first (unlock the source), then gives the target back,
 * and only then closes the row, so a row that says `failed` or `cancelled`
 * means the workspace is serving from its original database again. Every part
 * is idempotent: it can run twice (a retried step, the Workflow and the admin
 * route both acting) and a part that already happened is a no-op.
 *
 * Never run after the switch: a `completed` row returns at once, and a
 * workspace that already points at the target is refused. The old database of a
 * completed move stays locked until the retention sweep drops it.
 */

import { directUrlOf } from '@weldsuite/neon-provisioning';
import type { DatabaseMoveProgress, DatabaseMoveStatus } from '@weldsuite/db/schema/master';
import { and, eq, ne } from 'drizzle-orm';
import { workspaceDatabaseMoves } from '@weldsuite/db/schema/master';
import { unlockDatabase } from '../../lib/database-move/guard';
import { isPasswordAuthFailure } from '../../lib/database-move/pg-errors';
import { recordMoveFailed } from './audit';
import type { MoveDeps } from './deps';
import { DatabaseMoveRequestError, MoveFlowError } from './errors';
import { describeFailure } from './failure';
import {
  loadMove,
  loadWorkspace,
  requireMove,
  setSourceDatabaseUrl,
  updateMove,
  workspaceIsAtSource,
  workspaceIsAtTarget,
  type MoveRow,
  type WorkspaceRow,
} from './state';

export interface CompensationOptions {
  /** Why the move ended, already safe to store (see `describeFailure`). Omit for a cancel. */
  error?: string | null;
  /** Final status. Defaults to `cancelled` when a cancel was requested, else `failed`. */
  outcome?: 'failed' | 'cancelled';
}

export interface CompensationResult {
  /** The row's final status; `completed` means the move had already switched and nothing was undone. */
  status: DatabaseMoveStatus;
  /** The source was unlocked by this run. */
  sourceUnlocked: boolean;
  /** The target was dropped or returned by this run. */
  targetReleased: boolean;
}

function emptyProgress(): DatabaseMoveProgress {
  return { tables: [], copiedRows: 0, totalRows: null };
}

function sourceCoordinates(move: MoveRow) {
  return {
    neonProjectId: move.sourceNeonProjectId,
    neonBranchId: move.sourceNeonBranchId,
    databaseName: move.sourceDatabaseName,
    roleName: move.sourceRoleName,
    sharedProjectId: move.sourceSharedProjectId,
  };
}

/**
 * Make the source database writable again. It connects with the URL stored on
 * the workspace row (the lock wrote the rotated one there). If that URL is dead
 * (the password was rotated but the new URL never reached the row) it rotates
 * the password once more, stores the fresh URL, and unlocks with that.
 */
export async function unlockMoveSource(deps: MoveDeps, move: MoveRow, workspace: WorkspaceRow): Promise<void> {
  const dbName = move.sourceDatabaseName;
  if (workspace.databaseUrl) {
    const stored = await deps.decryptUrl(workspace.databaseUrl, move.workspaceId);
    try {
      await unlockDatabase(deps.connect(directUrlOf(stored)), dbName);
      return;
    } catch (err) {
      if (!isPasswordAuthFailure(err)) throw err;
    }
  }

  const urls = await deps.provisioning.rotateRolePassword(sourceCoordinates(move));
  const encrypted = await deps.encryptUrl(urls.pooledUrl, move.workspaceId);
  if (!(await setSourceDatabaseUrl(deps.masterDb, move, encrypted, deps.now()))) {
    throw new MoveFlowError('WORKSPACE_CHANGED', 'The workspace no longer points at the source database');
  }
  await deps.purgeCaches({ workspaceId: move.workspaceId, clerkOrgId: workspace.clerkOrgId });
  await unlockDatabase(deps.connect(urls.directUrl), dbName);
}

/** Drop or return the target database the move prepared, once. */
async function releaseTarget(deps: MoveDeps, move: MoveRow): Promise<boolean> {
  const progress = move.progress ?? emptyProgress();
  const { targetNeonProjectId, targetNeonBranchId, targetDatabaseName, targetRoleName } = move;
  if (progress.targetReleasedAt || !targetNeonProjectId || !targetNeonBranchId || !targetDatabaseName || !targetRoleName) {
    return false;
  }
  await deps.provisioning.releaseMoveTarget(deps.masterDb, {
    kind: move.kind === 'shard_to_dedicated' ? 'dedicated' : 'shard',
    neonProjectId: targetNeonProjectId,
    neonBranchId: targetNeonBranchId,
    databaseName: targetDatabaseName,
    roleName: targetRoleName,
    sharedProjectId: move.targetSharedProjectId,
    poolId: move.targetPoolId,
  });
  return true;
}

/** How one part of the cleanup went: whether it did its work, and what to report when it failed. */
interface CleanupPart {
  done: boolean;
  problem: string | null;
}

/** Unlock the source, when the move locked it and the workspace still points at it. Never throws. */
async function unlockSourceIfLocked(
  deps: MoveDeps,
  move: MoveRow,
  workspace: WorkspaceRow | undefined,
  progress: DatabaseMoveProgress,
): Promise<CleanupPart> {
  // A workspace that is gone or no longer at the source has nothing to unlock through the workspace row.
  if (!progress.lockStartedAt || !workspace || !workspaceIsAtSource(workspace, move)) {
    return { done: false, problem: null };
  }
  try {
    await unlockMoveSource(deps, move, workspace);
    return { done: true, problem: null };
  } catch (err) {
    return { done: false, problem: `unlocking the source failed (${describeFailure(err)})` };
  }
}

/** Release the target and record that on the row. Never throws. */
async function releaseTargetOnce(deps: MoveDeps, move: MoveRow, progress: DatabaseMoveProgress): Promise<CleanupPart> {
  try {
    const released = await releaseTarget(deps, move);
    // Remember it now: if the unlock failed, the retry must not drop the target a second time.
    if (released) {
      await updateMove(
        deps.masterDb,
        move.id,
        { progress: { ...progress, targetReleasedAt: deps.now().toISOString() } },
        deps.now(),
      );
    }
    return { done: released, problem: null };
  } catch (err) {
    return { done: false, problem: `releasing the target failed (${describeFailure(err)})` };
  }
}

/**
 * Close a move that will not switch. See the file header for the order and the
 * guarantees. Throws a retryable `COMPENSATION_INCOMPLETE` when the unlock or
 * the release failed (the row then stays live, still blocking writes, until a
 * retry or the admin route finishes the job).
 */
export async function compensateDatabaseMove(
  deps: MoveDeps,
  moveId: string,
  options: CompensationOptions = {},
): Promise<CompensationResult> {
  const db = deps.masterDb;
  const move = await requireMove(db, moveId);
  if (move.status === 'completed') return { status: 'completed', sourceUnlocked: false, targetReleased: false };

  const workspace = await loadWorkspace(db, move.workspaceId);
  if (workspace && workspaceIsAtTarget(workspace, move)) {
    throw new MoveFlowError(
      'WORKSPACE_CHANGED',
      'The workspace already points at the move target; refusing to undo the move',
    );
  }

  const outcome = options.outcome ?? (move.cancelRequestedAt ? 'cancelled' : 'failed');
  const error = options.error === undefined ? move.error : options.error;
  // Say why while the cleanup runs, so a stuck cleanup still shows the cause.
  if (options.error !== undefined) await updateMove(db, moveId, { error: options.error }, deps.now());

  const progress = move.progress ?? emptyProgress();
  const unlock = await unlockSourceIfLocked(deps, move, workspace, progress);
  const release = await releaseTargetOnce(deps, move, progress);

  const problems = [unlock.problem, release.problem].filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    throw new MoveFlowError('COMPENSATION_INCOMPLETE', `Could not undo the move: ${problems.join('; ')}`, true);
  }

  const [closed] = await db
    .update(workspaceDatabaseMoves)
    .set({
      status: outcome,
      error: outcome === 'cancelled' ? null : error,
      targetDatabaseUrl: null,
      updatedAt: deps.now(),
    })
    .where(and(eq(workspaceDatabaseMoves.id, moveId), ne(workspaceDatabaseMoves.status, 'completed')))
    .returning({ id: workspaceDatabaseMoves.id });

  // The admin trail says how the move ended, once per move (a repeated recovery writes the same row id again,
  // which does nothing). A cancel is already on the trail from the cancel request.
  if (closed && outcome === 'failed') await recordMoveFailed(db, move, error);

  await deps.purgeCaches({ workspaceId: move.workspaceId, clerkOrgId: workspace?.clerkOrgId ?? null });
  return { status: outcome, sourceUnlocked: unlock.done, targetReleased: release.done };
}

export interface RecoverOptions {
  /** Run even though the move still looks live (its Workflow instance is dead). */
  force?: boolean;
}

/**
 * The admin "unlock" recovery: finish undoing a move that is stuck, i.e. failed
 * or cancelling with the source still locked or a target still allocated.
 * Refuses a completed move, and a live one (status other than `cancelling`)
 * unless `force` says its Workflow is gone.
 */
export async function recoverDatabaseMove(
  deps: MoveDeps,
  moveId: string,
  options: RecoverOptions = {},
): Promise<CompensationResult> {
  const move = await loadMove(deps.masterDb, moveId);
  if (!move) throw new DatabaseMoveRequestError('MOVE_NOT_FOUND', 'Move not found');
  if (move.status === 'completed') {
    throw new DatabaseMoveRequestError('MOVE_NOT_RECOVERABLE', 'The move completed; there is nothing to undo');
  }
  const finished = move.status === 'failed' || move.status === 'cancelled' || move.status === 'cancelling';
  if (!finished && !options.force) {
    throw new DatabaseMoveRequestError(
      'MOVE_NOT_RECOVERABLE',
      `The move is ${move.status} and its Workflow may still be running; cancel it first or force the recovery`,
    );
  }
  return compensateDatabaseMove(deps, moveId, {
    // A recovery of a failed move keeps its status and error; anything else becomes `failed`.
    outcome: move.status === 'cancelled' || move.cancelRequestedAt ? 'cancelled' : 'failed',
  });
}
