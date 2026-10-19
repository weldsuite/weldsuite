/**
 * The move row and the `workspaces` row, as the move Workflow reads and writes
 * them. Every write that must not clobber a cancel is a compare-and-set on the
 * row's status, so the cancel route (which flips an active row to `cancelling`)
 * and the Workflow can race without either overwriting the other:
 *
 *  - `advance` moves a row forward only while it is neither cancelled nor over,
 *    and returns the row, so one subrequest is the step's cancel check, its
 *    progress marker and its read of the move;
 *  - `writeProgress` saves the copy cursors and reports whether a cancel arrived;
 *  - `switchWorkspace` is the one write that swaps the workspace to the target.
 *
 * Nothing here handles a connection string except as the opaque ciphertext
 * column it is stored in.
 */

import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import {
  workspaceDatabaseMoves,
  workspaces,
  type DatabaseMoveProgress,
  type DatabaseMoveStatus,
  type WorkspaceDatabaseMove,
} from '@weldsuite/db/schema/master';
import type { MasterDatabase } from '../../db';
import { MoveCancelledError, MoveFlowError } from './errors';

export type MoveRow = WorkspaceDatabaseMove;

/** A move row in any of these statuses is over: nothing advances it. */
export const FINISHED_MOVE_STATUSES = ['completed', 'failed', 'cancelled'] as const satisfies readonly DatabaseMoveStatus[];

/** The `workspaces` columns a move reads. */
export const workspaceColumns = {
  id: workspaces.id,
  clerkOrgId: workspaces.clerkOrgId,
  neonProjectId: workspaces.neonProjectId,
  neonBranchId: workspaces.neonBranchId,
  neonRoleName: workspaces.neonRoleName,
  neonDatabaseName: workspaces.neonDatabaseName,
  neonRegion: workspaces.neonRegion,
  sharedProjectId: workspaces.sharedProjectId,
  databaseUrl: workspaces.databaseUrl,
  databaseProvisionedAt: workspaces.databaseProvisionedAt,
  scheduledDeletionAt: workspaces.scheduledDeletionAt,
  deletedAt: workspaces.deletedAt,
};

export interface WorkspaceRow {
  id: string;
  clerkOrgId: string | null;
  neonProjectId: string | null;
  neonBranchId: string | null;
  neonRoleName: string | null;
  neonDatabaseName: string | null;
  neonRegion: string | null;
  sharedProjectId: string | null;
  databaseUrl: string | null;
  databaseProvisionedAt: Date | null;
  scheduledDeletionAt: Date | null;
  deletedAt: Date | null;
}

export async function loadMove(db: MasterDatabase, moveId: string): Promise<MoveRow | undefined> {
  const [row] = await db.select().from(workspaceDatabaseMoves).where(eq(workspaceDatabaseMoves.id, moveId)).limit(1);
  return row;
}

export async function requireMove(db: MasterDatabase, moveId: string): Promise<MoveRow> {
  const row = await loadMove(db, moveId);
  if (!row) throw new MoveFlowError('MOVE_NOT_FOUND', `Move ${moveId} does not exist`);
  return row;
}

export async function loadWorkspace(db: MasterDatabase, workspaceId: string): Promise<WorkspaceRow | undefined> {
  const [row] = await db.select(workspaceColumns).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row;
}

/** Is the move cancelled (or being cancelled)? */
export function isCancelled(row: Pick<MoveRow, 'status' | 'cancelRequestedAt'>): boolean {
  return row.status === 'cancelling' || row.cancelRequestedAt !== null;
}

/** Does the workspace row still point at the database the move started from? */
export function workspaceIsAtSource(
  workspace: Pick<WorkspaceRow, 'neonProjectId' | 'neonDatabaseName'>,
  move: Pick<MoveRow, 'sourceNeonProjectId' | 'sourceDatabaseName'>,
): boolean {
  return (
    workspace.neonProjectId === move.sourceNeonProjectId && workspace.neonDatabaseName === move.sourceDatabaseName
  );
}

/** Does the workspace row already point at the move's target? */
export function workspaceIsAtTarget(
  workspace: Pick<WorkspaceRow, 'neonProjectId' | 'neonDatabaseName'>,
  move: Pick<MoveRow, 'targetNeonProjectId' | 'targetDatabaseName'>,
): boolean {
  return (
    move.targetNeonProjectId !== null &&
    move.targetDatabaseName !== null &&
    workspace.neonProjectId === move.targetNeonProjectId &&
    workspace.neonDatabaseName === move.targetDatabaseName
  );
}

export interface AdvanceOptions {
  /** Name of the step being entered (`current_step`, for the admin progress view). */
  step: string;
  /** New status; omitted to keep the current one. */
  status?: DatabaseMoveStatus;
  /** Further columns to set in the same write. */
  set?: Partial<Pick<typeof workspaceDatabaseMoves.$inferInsert, 'startedAt' | 'softLockedAt' | 'lockedAt'>>;
}

/**
 * Enter a step: set `current_step` (and optionally the status) and return the
 * row, but only while the move is live (not cancelled, not over). When it is
 * not, this throws {@link MoveCancelledError} (a cancel was requested) or a
 * `MOVE_ENDED` {@link MoveFlowError}, so every step starts with a cancel check
 * that costs one query.
 */
export async function advance(
  db: MasterDatabase,
  moveId: string,
  options: AdvanceOptions,
  now: Date = new Date(),
): Promise<MoveRow> {
  const [row] = await db
    .update(workspaceDatabaseMoves)
    .set({
      currentStep: options.step,
      ...(options.status ? { status: options.status } : {}),
      ...options.set,
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceDatabaseMoves.id, moveId),
        notInArray(workspaceDatabaseMoves.status, ['cancelling', ...FINISHED_MOVE_STATUSES]),
        isNull(workspaceDatabaseMoves.cancelRequestedAt),
      ),
    )
    .returning();
  if (row) return row;

  const current = await requireMove(db, moveId);
  if (isCancelled(current)) throw new MoveCancelledError();
  throw new MoveFlowError('MOVE_ENDED', `Move ${moveId} is already ${current.status}`);
}

/**
 * Save the copy progress. Returns true when a cancel has been requested (the
 * caller stops and lets the Workflow compensate); the progress is saved either
 * way. The write does not touch the status, so it cannot undo a cancel.
 */
export async function writeProgress(
  db: MasterDatabase,
  moveId: string,
  progress: DatabaseMoveProgress,
  now: Date = new Date(),
): Promise<{ cancelRequested: boolean }> {
  const [row] = await db
    .update(workspaceDatabaseMoves)
    .set({ progress, updatedAt: now })
    .where(
      and(eq(workspaceDatabaseMoves.id, moveId), notInArray(workspaceDatabaseMoves.status, [...FINISHED_MOVE_STATUSES])),
    )
    .returning({
      status: workspaceDatabaseMoves.status,
      cancelRequestedAt: workspaceDatabaseMoves.cancelRequestedAt,
    });
  if (!row) throw new MoveFlowError('MOVE_ENDED', `Move ${moveId} is already over`);
  return { cancelRequested: isCancelled(row) };
}

/** Save the non-progress columns a step records (target coordinates, verification, error). */
export async function updateMove(
  db: MasterDatabase,
  moveId: string,
  values: Partial<typeof workspaceDatabaseMoves.$inferInsert>,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(workspaceDatabaseMoves)
    .set({ ...values, updatedAt: now })
    .where(eq(workspaceDatabaseMoves.id, moveId));
}

/**
 * Compare-and-set the workspace's stored connection URL, only while it still
 * points at the source database. True when it was written. Used by the lock
 * (the rotated source URL) and by the recovery that rotates again.
 */
export async function setSourceDatabaseUrl(
  db: MasterDatabase,
  move: Pick<MoveRow, 'workspaceId' | 'sourceNeonProjectId' | 'sourceDatabaseName'>,
  encryptedUrl: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(workspaces)
    .set({ databaseUrl: encryptedUrl, updatedAt: now })
    .where(
      and(
        eq(workspaces.id, move.workspaceId),
        eq(workspaces.neonProjectId, move.sourceNeonProjectId),
        eq(workspaces.neonDatabaseName, move.sourceDatabaseName),
      ),
    )
    .returning({ id: workspaces.id });
  return rows.length === 1;
}

export interface SwitchResult {
  /** True when the workspace now points at the target and the move row is `completed`. */
  switched: boolean;
}

/**
 * The switch: one `db.batch` (one transaction) that swaps the workspace to the
 * target with a compare-and-set on the source coordinates, and marks the move
 * `completed` only if that swap took effect. The second statement is guarded by
 * an EXISTS on the workspace now carrying the target coordinates, so a lost
 * compare-and-set leaves the move row untouched instead of recording a switch
 * that did not happen.
 *
 * `database_provisioned_at` and `provisioning_status` are left alone. The
 * stored target URL (already encrypted on the move row) becomes the workspace's
 * URL, and is cleared from the move row.
 */
export async function switchWorkspace(
  db: MasterDatabase,
  move: MoveRow,
  retainedUntil: Date,
  now: Date = new Date(),
): Promise<SwitchResult> {
  const {
    targetNeonProjectId,
    targetNeonBranchId,
    targetRoleName,
    targetDatabaseName,
    targetRegion,
    targetDatabaseUrl,
  } = move;
  if (!targetNeonProjectId || !targetNeonBranchId || !targetRoleName || !targetDatabaseName || !targetDatabaseUrl) {
    throw new MoveFlowError('TARGET_LOST', 'The move has no complete target to switch to');
  }

  const [swapped, completed] = await db.batch([
    db
      .update(workspaces)
      .set({
        neonProjectId: targetNeonProjectId,
        neonBranchId: targetNeonBranchId,
        neonRoleName: targetRoleName,
        neonDatabaseName: targetDatabaseName,
        neonRegion: targetRegion,
        sharedProjectId: move.targetSharedProjectId,
        databaseUrl: targetDatabaseUrl,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaces.id, move.workspaceId),
          eq(workspaces.neonProjectId, move.sourceNeonProjectId),
          eq(workspaces.neonDatabaseName, move.sourceDatabaseName),
        ),
      )
      .returning({ id: workspaces.id }),
    db
      .update(workspaceDatabaseMoves)
      .set({
        status: 'completed',
        currentStep: 'completed',
        switchedAt: now,
        completedAt: now,
        oldDatabaseRetainedUntil: retainedUntil,
        targetDatabaseUrl: null,
        error: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(workspaceDatabaseMoves.id, move.id),
          eq(workspaceDatabaseMoves.status, 'switching'),
          sql`exists (
            select 1 from ${workspaces}
            where ${workspaces.id} = ${move.workspaceId}
              and ${workspaces.neonProjectId} = ${targetNeonProjectId}
              and ${workspaces.neonDatabaseName} = ${targetDatabaseName}
          )`,
        ),
      )
      .returning({ id: workspaceDatabaseMoves.id }),
  ]);
  return { switched: swapped.length === 1 && completed.length === 1 };
}

/** Statuses a cancel may still stop: everything before the switch. */
export const CANCELLABLE_MOVE_STATUSES = [
  'queued',
  'preparing',
  'soft_locked',
  'locked',
  'copying',
  'verifying',
] as const satisfies readonly DatabaseMoveStatus[];

