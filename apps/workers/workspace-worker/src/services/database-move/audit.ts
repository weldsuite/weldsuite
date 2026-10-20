/**
 * The admin audit trail of a database move: the verbs, and the two rows the
 * Workflow writes itself when a move ends (`database.move_complete`,
 * `database.move_fail`), attributed to the admin who started the move.
 *
 * Those two rows are written exactly once per move, whichever step, retry or
 * recovery gets there: the row id is derived from the move id, and a second
 * write of the same id does nothing (`recordAdminAudit` with a fixed `id`).
 * What the routes record (start, cancel, recover) is in `routes/admin-databases.ts`.
 */

import type { MasterDatabase } from '../../db';
import { recordAdminAudit } from '../../lib/admin-audit';
import type { MoveRow } from './state';

export const MOVE_AUDIT_ACTIONS = {
  start: 'database.move_start',
  cancel: 'database.move_cancel',
  recover: 'database.move_recover',
  complete: 'database.move_complete',
  fail: 'database.move_fail',
} as const;

/** `admin_audit_events.id` is a varchar(30): `aae_mc_` / `aae_mf_` plus the tail of the move id. */
function outcomeAuditId(kind: 'mc' | 'mf', moveId: string): string {
  const suffix = moveId.replace(/^dbm_/, '');
  return `aae_${kind}_${suffix.slice(-23)}`;
}

function coordinates(move: MoveRow) {
  return {
    moveId: move.id,
    kind: move.kind,
    requestedTarget: move.requestedTarget,
    from: { neonProjectId: move.sourceNeonProjectId, databaseName: move.sourceDatabaseName },
    to: move.targetNeonProjectId
      ? { neonProjectId: move.targetNeonProjectId, databaseName: move.targetDatabaseName }
      : null,
  };
}

/** The move switched: record `database.move_complete` (once per move). Never throws. */
export async function recordMoveCompleted(db: MasterDatabase, move: MoveRow): Promise<void> {
  await recordAdminAudit(db, {
    id: outcomeAuditId('mc', move.id),
    actor: { email: move.startedBy, userId: move.startedByUserId },
    workspaceId: move.workspaceId,
    targetType: 'workspace',
    targetId: move.workspaceId,
    action: MOVE_AUDIT_ACTIONS.complete,
    outcome: 'success',
    reason: move.reason,
    details: {
      ...coordinates(move),
      oldDatabaseRetainedUntil: move.oldDatabaseRetainedUntil?.toISOString() ?? null,
    },
  });
}

/**
 * The move failed and was undone: record `database.move_fail` (once per move),
 * with the already-safe error text. Never throws.
 */
export async function recordMoveFailed(db: MasterDatabase, move: MoveRow, error: string | null): Promise<void> {
  await recordAdminAudit(db, {
    id: outcomeAuditId('mf', move.id),
    actor: { email: move.startedBy, userId: move.startedByUserId },
    workspaceId: move.workspaceId,
    targetType: 'workspace',
    targetId: move.workspaceId,
    action: MOVE_AUDIT_ACTIONS.fail,
    outcome: 'failure',
    reason: move.reason,
    details: { ...coordinates(move), step: move.currentStep },
    error,
  });
}
