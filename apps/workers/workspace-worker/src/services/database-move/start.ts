/**
 * Starting and cancelling a database move: the two calls the admin routes make
 * (the routes themselves, and their auth, are not part of this file).
 *
 * `startDatabaseMove` validates the request against the workspace row, inserts
 * the `workspace_database_moves` row (the partial unique index allows one active
 * move per workspace, so a concurrent second start fails there) and creates the
 * `MoveDatabaseWorkflow` instance, whose id is the row id.
 *
 * `requestMoveCancel` flips a live row to `cancelling` with a compare-and-set on
 * its status. The Workflow notices at its next step boundary, so a cancel is
 * never instant; once the switch has begun it is refused.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  ACTIVE_DATABASE_MOVE_STATUSES,
  neonSharedProjects,
  workspaceDatabaseMoves,
  type DatabaseMoveKind,
  type DatabaseMoveStatus,
  type NewWorkspaceDatabaseMove,
} from '@weldsuite/db/schema/master';
import type { Env } from '../../index';
import { getMasterDb, type MasterDatabase } from '../../db';
import { generateId } from '../../lib/id';
import { isUniqueViolation } from '../../lib/database-move/pg-errors';
import { DatabaseMoveRequestError } from './errors';
import { CANCELLABLE_MOVE_STATUSES, loadMove, loadWorkspace, updateMove } from './state';

/** `dedicated`, `shard:auto` (any other active shard in the region) or a shard id (`nsp_…`). */
const TARGET_PATTERN = /^(dedicated|shard:auto|nsp_[a-z0-9]{1,30})$/;

export const startDatabaseMoveInputSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  target: z.string().regex(TARGET_PATTERN, 'target must be "dedicated", "shard:auto" or a shard id'),
  /** Email of the admin who asked. */
  startedBy: z.string().min(1).max(255),
  startedByUserId: z.string().min(1).max(255).optional(),
  reason: z.string().max(2000).optional(),
});

export type StartDatabaseMoveInput = z.infer<typeof startDatabaseMoveInputSchema>;

export interface StartDatabaseMoveOptions {
  /** Master DB; defaults to the Worker's own. */
  masterDb?: MasterDatabase;
}

export interface StartedDatabaseMove {
  moveId: string;
  kind: DatabaseMoveKind;
  /** Workflow instance id (equal to `moveId`). */
  workflowInstanceId: string;
}

function placementOf(
  sourceShardId: string | null,
  target: string,
): { kind: DatabaseMoveKind; shardId: string | null } {
  if (target === 'dedicated') {
    if (!sourceShardId) {
      throw new DatabaseMoveRequestError('ALREADY_PLACED', 'The workspace already has a dedicated database');
    }
    return { kind: 'shard_to_dedicated', shardId: null };
  }
  const kind: DatabaseMoveKind = sourceShardId ? 'shard_to_shard' : 'dedicated_to_shard';
  if (target === 'shard:auto') return { kind, shardId: null };
  if (target === sourceShardId) {
    throw new DatabaseMoveRequestError('ALREADY_PLACED', 'The workspace database already lives on that shard');
  }
  return { kind, shardId: target };
}

/**
 * Validate and start a move. Throws {@link DatabaseMoveRequestError} for every
 * refusal (its `httpStatus` is a suggestion for the route).
 */
export async function startDatabaseMove(
  env: Env,
  rawInput: StartDatabaseMoveInput,
  options: StartDatabaseMoveOptions = {},
): Promise<StartedDatabaseMove> {
  const parsed = startDatabaseMoveInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DatabaseMoveRequestError('INVALID_INPUT', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const input = parsed.data;
  const db = options.masterDb ?? getMasterDb(env);

  const workspace = await loadWorkspace(db, input.workspaceId);
  if (!workspace) throw new DatabaseMoveRequestError('WORKSPACE_NOT_FOUND', 'Workspace not found');
  if (workspace.deletedAt) throw new DatabaseMoveRequestError('WORKSPACE_DELETED', 'The workspace is deleted');
  if (workspace.scheduledDeletionAt) {
    throw new DatabaseMoveRequestError(
      'WORKSPACE_SCHEDULED_FOR_DELETION',
      'The workspace is scheduled for deletion; cancel the deletion before moving its database',
    );
  }
  const { neonProjectId, neonBranchId, neonRoleName, neonDatabaseName, databaseUrl } = workspace;
  if (
    !neonProjectId ||
    !neonBranchId ||
    !neonRoleName ||
    !neonDatabaseName ||
    !databaseUrl ||
    !workspace.databaseProvisionedAt
  ) {
    throw new DatabaseMoveRequestError('WORKSPACE_NOT_PROVISIONED', 'The workspace database is not provisioned yet');
  }

  const [active] = await db
    .select({ id: workspaceDatabaseMoves.id })
    .from(workspaceDatabaseMoves)
    .where(
      and(
        eq(workspaceDatabaseMoves.workspaceId, workspace.id),
        inArray(workspaceDatabaseMoves.status, [...ACTIVE_DATABASE_MOVE_STATUSES]),
      ),
    )
    .limit(1);
  if (active) {
    throw new DatabaseMoveRequestError('MOVE_ALREADY_ACTIVE', 'This workspace already has a database move in progress');
  }

  const region = workspace.neonRegion || env.NEON_DEFAULT_REGION || 'aws-eu-central-1';
  const { kind, shardId } = placementOf(workspace.sharedProjectId, input.target);

  if (shardId) {
    const [shard] = await db
      .select({ status: neonSharedProjects.status, region: neonSharedProjects.region })
      .from(neonSharedProjects)
      .where(eq(neonSharedProjects.id, shardId))
      .limit(1);
    if (!shard) throw new DatabaseMoveRequestError('SHARD_NOT_FOUND', 'Shard not found');
    if (shard.status !== 'active') {
      throw new DatabaseMoveRequestError('SHARD_UNAVAILABLE', `That shard is ${shard.status}, not active`);
    }
    if (shard.region !== region) {
      throw new DatabaseMoveRequestError('SHARD_UNAVAILABLE', 'That shard is in another region than the workspace');
    }
  }

  const moveId = generateId('dbm');
  const row: NewWorkspaceDatabaseMove = {
    id: moveId,
    workspaceId: workspace.id,
    kind,
    status: 'queued',
    requestedTarget: input.target,
    sourceNeonProjectId: neonProjectId,
    sourceNeonBranchId: neonBranchId,
    sourceDatabaseName: neonDatabaseName,
    sourceRoleName: neonRoleName,
    sourceSharedProjectId: workspace.sharedProjectId,
    sourceRegion: workspace.neonRegion,
    workflowInstanceId: moveId,
    startedBy: input.startedBy,
    startedByUserId: input.startedByUserId ?? null,
    reason: input.reason ?? null,
  };
  try {
    await db.insert(workspaceDatabaseMoves).values(row);
  } catch (err) {
    // The partial unique index: another start won the race.
    if (isUniqueViolation(err)) {
      throw new DatabaseMoveRequestError(
        'MOVE_ALREADY_ACTIVE',
        'This workspace already has a database move in progress',
        { cause: err },
      );
    }
    throw err;
  }

  try {
    await env.MOVE_DATABASE.create({ id: moveId, params: { moveId } });
  } catch (err) {
    // No Workflow will ever advance this row: close it so it does not block the next attempt.
    await updateMove(db, moveId, { status: 'failed', error: 'The move workflow could not be started' });
    throw new DatabaseMoveRequestError('WORKFLOW_START_FAILED', 'The move workflow could not be started', {
      cause: err,
    });
  }

  return { moveId, kind, workflowInstanceId: moveId };
}

export interface CancelDatabaseMoveOptions {
  masterDb?: MasterDatabase;
  now?: () => Date;
}

export interface CancelRequested {
  moveId: string;
  /** `cancelling` (the Workflow stops at its next step boundary). */
  status: DatabaseMoveStatus;
}

/**
 * Ask a live move to stop. Idempotent for a move that is already being
 * cancelled. Refused (`MOVE_NOT_CANCELLABLE`) once the switch began or the move
 * is over, and `MOVE_NOT_FOUND` for an unknown id.
 */
export async function requestMoveCancel(
  env: Env,
  moveId: string,
  options: CancelDatabaseMoveOptions = {},
): Promise<CancelRequested> {
  const db = options.masterDb ?? getMasterDb(env);
  const now = options.now?.() ?? new Date();

  const [updated] = await db
    .update(workspaceDatabaseMoves)
    .set({ status: 'cancelling', cancelRequestedAt: now, updatedAt: now })
    .where(
      and(eq(workspaceDatabaseMoves.id, moveId), inArray(workspaceDatabaseMoves.status, [...CANCELLABLE_MOVE_STATUSES])),
    )
    .returning({ status: workspaceDatabaseMoves.status });
  if (updated) return { moveId, status: updated.status };

  const current = await loadMove(db, moveId);
  if (!current) throw new DatabaseMoveRequestError('MOVE_NOT_FOUND', 'Move not found');
  if (current.status === 'cancelling') return { moveId, status: 'cancelling' };
  throw new DatabaseMoveRequestError(
    'MOVE_NOT_CANCELLABLE',
    current.status === 'switching'
      ? 'The move is switching to the new database and can no longer be cancelled'
      : `The move is ${current.status} and can no longer be cancelled`,
  );
}
