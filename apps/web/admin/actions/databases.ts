'use server';

import { revalidatePath } from 'next/cache';
import { getAdminIdentity, guardSuperAdmin, guardWrite } from '@/lib/auth';
import {
  MOVE_REASON_MAX,
  MOVE_REASON_MIN,
  isMoveTarget,
  type DatabaseMoveKind,
  type DatabaseMoveStatus,
  type DatabaseMoveView,
  type ShardSizes,
} from '@/lib/database-moves';
import { adminCopy } from '@/lib/i18n';
import {
  cancelDatabaseMove,
  loadDatabaseMove,
  measureShardSizes,
  recoverDatabaseMove,
  startDatabaseMove,
  type RecoveredMove,
  type WorkerResult,
} from '@/lib/workspace-worker';
import type { ActionResult } from './workspaces';

/**
 * Database moves and shard measurements from the admin console (task 1150,
 * phase 3). Everything goes through the workspace worker's admin API, which
 * re-checks the role (a change needs a superadmin) and writes the admin audit
 * rows itself, failures included, so these actions do not record a second one.
 */

const ID_MAX = 255;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX;
}

function fromWorker<T>(result: WorkerResult<T>): ActionResult<T> {
  if (result.ok) return result;
  const t = adminCopy().databases.moves.errors;
  const error = result.code === 'NOT_CONFIGURED' ? t.notConfigured : result.error;
  return { ok: false, error, code: result.code };
}

function refresh(workspaceId: string | null): void {
  revalidatePath('/databases');
  if (workspaceId) revalidatePath(`/workspaces/${workspaceId}`);
}

export async function startDatabaseMoveAction(
  workspaceId: string,
  target: string,
  reason: string,
): Promise<ActionResult<{ moveId: string; kind: DatabaseMoveKind }>> {
  const guard = await guardSuperAdmin();
  if (!guard.ok) return guard;
  const t = adminCopy().databases.moves.errors;

  if (!isId(workspaceId)) return { ok: false, error: t.invalidWorkspace };
  if (!isMoveTarget(target)) return { ok: false, error: t.invalidTarget };
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.length < MOVE_REASON_MIN || trimmed.length > MOVE_REASON_MAX) {
    return { ok: false, error: t.invalidReason };
  }

  const result = fromWorker(
    await startDatabaseMove(guard.identity, workspaceId, {
      target,
      reason: trimmed,
    }),
  );
  refresh(workspaceId);
  return result;
}

export async function cancelDatabaseMoveAction(
  moveId: string,
  workspaceId: string,
): Promise<ActionResult<{ moveId: string; status: DatabaseMoveStatus }>> {
  const guard = await guardSuperAdmin();
  if (!guard.ok) return guard;
  if (!isId(moveId)) return { ok: false, error: adminCopy().databases.moves.errors.invalidMove };

  const result = fromWorker(await cancelDatabaseMove(guard.identity, moveId));
  refresh(isId(workspaceId) ? workspaceId : null);
  return result;
}

export async function recoverDatabaseMoveAction(
  moveId: string,
  workspaceId: string,
  force: boolean,
): Promise<ActionResult<RecoveredMove>> {
  const guard = await guardSuperAdmin();
  if (!guard.ok) return guard;
  if (!isId(moveId)) return { ok: false, error: adminCopy().databases.moves.errors.invalidMove };

  const result = fromWorker(await recoverDatabaseMove(guard.identity, moveId, force === true));
  refresh(isId(workspaceId) ? workspaceId : null);
  return result;
}

/** One move's current state, for the live panel's polling. Every admin role may read it. */
export async function loadDatabaseMoveAction(moveId: string): Promise<ActionResult<DatabaseMoveView>> {
  const identity = await getAdminIdentity();
  if (!identity)
    return {
      ok: false,
      error: adminCopy().databases.moves.errors.notAuthorized,
    };
  if (!isId(moveId)) return { ok: false, error: adminCopy().databases.moves.errors.invalidMove };
  return fromWorker(await loadDatabaseMove(identity, moveId));
}

/** Measure every database on a shard. Wakes the shard's compute, so not for read-only viewers. */
export async function measureShardSizesAction(shardId: string): Promise<ActionResult<ShardSizes>> {
  const guard = await guardWrite();
  if (!guard.ok) return guard;
  if (!isId(shardId))
    return {
      ok: false,
      error: adminCopy().databases.moves.errors.invalidShard,
    };
  return fromWorker(await measureShardSizes(guard.identity, shardId));
}
