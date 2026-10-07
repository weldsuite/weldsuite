/**
 * Workflow version history — point-in-time snapshots of a `workflows` row.
 *
 * Snapshot policy (decided for this feature, see docs/plans/weldconnect.md
 * phase 2 "extras"): a version is written
 *   - whenever a workflow activates (draft/paused -> active), and
 *   - whenever an ALREADY-active workflow is saved with a meaningful change
 *     (name, triggers, steps or settings — not a tag/folder-only touch), and
 *   - whenever a version is restored (the restore itself becomes a new
 *     version, on top of the one it's restoring from).
 *
 * This deliberately does NOT snapshot every draft autosave: a workflow being
 * built up in the editor churns through many intermediate, often-invalid
 * states before it's ever activated, and none of those are "a version" a
 * user would want to browse or roll back to. Once a workflow is live,
 * though, every save that actually changes its behavior is a point someone
 * may want to come back to.
 *
 * Routes call `snapshotWorkflowVersion` themselves right after the write
 * that warrants one (see routes/workflows/index.ts) — kept here as a single
 * well-documented decision point rather than scattered inline logic.
 */

import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';

const { workflowVersions, workflows } = schema;

export type SnapshotReason = 'activated' | 'saved' | 'restored';

export interface SnapshotWorkflowVersionInput {
  workflowId: string;
  name: string;
  status: string;
  triggers?: unknown;
  steps?: unknown;
  settings?: unknown;
  createdBy?: string | null;
  reason: SnapshotReason;
  restoredFromVersion?: number | null;
  note?: string | null;
}

/**
 * Write a new version row — version number is `max(version) + 1` for this
 * workflow (1 for its first snapshot). Also bumps `workflows.version` to
 * match, so `workflow_executions.workflowVersion` (snapshotted at run time)
 * lines up with a real row in this table.
 */
export async function snapshotWorkflowVersion(
  db: Database,
  input: SnapshotWorkflowVersionInput,
): Promise<{ id: string; version: number }> {
  const [{ maxVersion }] = await db
    .select({ maxVersion: sql<number>`coalesce(max(${workflowVersions.version}), 0)::int` })
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, input.workflowId));
  const version = maxVersion + 1;
  const id = generateId('wfv');
  const now = new Date();

  await db.insert(workflowVersions).values({
    id,
    workflowId: input.workflowId,
    version,
    name: input.name,
    status: input.status,
    triggers: (input.triggers ?? []) as any,
    steps: (input.steps ?? []) as any,
    settings: (input.settings ?? {}) as any,
    createdBy: input.createdBy ?? null,
    reason: input.reason,
    restoredFromVersion: input.restoredFromVersion ?? null,
    note: input.note ?? null,
    createdAt: now,
  });

  await db.update(workflows).set({ version }).where(eq(workflows.id, input.workflowId));

  return { id, version };
}

export interface ListWorkflowVersionsParams {
  /** Omit to list across every workflow (mirrors workflow-schedules' optional filter). */
  workflowId?: string;
  cursor?: string;
  limit?: number;
}

/** Cursor is the version number (list is ordered newest-first; `lt` on version). */
export async function listWorkflowVersions(db: Database, params: ListWorkflowVersionsParams) {
  const limit = Math.min(params.limit ?? 25, 100);
  const filterConditions = params.workflowId ? [eq(workflowVersions.workflowId, params.workflowId)] : [];
  const conditions = [...filterConditions];
  if (params.cursor) {
    const cursorVersion = Number(params.cursor);
    if (Number.isFinite(cursorVersion)) conditions.push(lt(workflowVersions.version, cursorVersion));
  }

  const [rows, countRes] = await Promise.all([
    db
      .select({
        id: workflowVersions.id,
        workflowId: workflowVersions.workflowId,
        version: workflowVersions.version,
        name: workflowVersions.name,
        status: workflowVersions.status,
        createdBy: workflowVersions.createdBy,
        createdAt: workflowVersions.createdAt,
        reason: workflowVersions.reason,
        restoredFromVersion: workflowVersions.restoredFromVersion,
        note: workflowVersions.note,
      })
      .from(workflowVersions)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(workflowVersions.version))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowVersions)
      .where(filterConditions.length ? and(...filterConditions) : undefined),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const cursor = hasMore && data.length > 0 ? String(data[data.length - 1].version) : null;
  return { data, totalCount: Number(countRes[0]?.count ?? 0), hasMore, cursor };
}

export async function getWorkflowVersion(db: Database, id: string) {
  const [row] = await db.select().from(workflowVersions).where(eq(workflowVersions.id, id)).limit(1);
  return row ?? null;
}
