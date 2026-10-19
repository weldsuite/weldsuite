/**
 * Workspaces whose tenant database is being moved (TASK-1150, ADR DATA-007).
 *
 * A move locks the OLD database (rotated password, read-only) while it copies,
 * so a migration run against it fails by design (28P01 or read-only), and
 * the tenant migrations would fail the whole deploy because of one workspace
 * that is simply busy. The runner leaves such a workspace out and says so; it is
 * not a failure. The move applies the bundled migrations to its target itself,
 * and the next run migrates the workspace wherever it ended up.
 */

import { inArray, and } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { ACTIVE_DATABASE_MOVE_STATUSES, workspaceDatabaseMoves } from '@weldsuite/db/schema/master';

/** Ids (out of `workspaceIds`) that have a live move: queued up to and including switching, or being cancelled. */
export async function workspacesWithActiveMove(
  db: PostgresJsDatabase,
  workspaceIds: readonly string[],
): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set();
  const rows = await db
    .select({ workspaceId: workspaceDatabaseMoves.workspaceId })
    .from(workspaceDatabaseMoves)
    .where(
      and(
        inArray(workspaceDatabaseMoves.workspaceId, [...workspaceIds]),
        inArray(workspaceDatabaseMoves.status, [...ACTIVE_DATABASE_MOVE_STATUSES]),
      ),
    );
  return new Set(rows.map((row) => row.workspaceId));
}

/** Split a workspace list into the ones to migrate and the ones with a live move, keeping the order. */
export function partitionByActiveMove<T extends { id: string }>(
  workspaces: readonly T[],
  activeMoveWorkspaceIds: ReadonlySet<string>,
): { migratable: T[]; skipped: T[] } {
  const migratable: T[] = [];
  const skipped: T[] = [];
  for (const workspace of workspaces) {
    (activeMoveWorkspaceIds.has(workspace.id) ? skipped : migratable).push(workspace);
  }
  return { migratable, skipped };
}
