/**
 * Subtask trees — walking a task's descendants and deleting a task together
 * with them.
 *
 * `softDeleteTaskTree` backs `DELETE` on a task in flow-api
 * (apps/workers/flow-api/src/routes/tasks/index.ts), external-api
 * (`/v1/tasks/:id`) and the mcp-server's copy of that route, so a task removed
 * through any of them takes its subtasks and dependency links with it.
 *
 * Pure business logic; no Hono context. Kept apart from `./tasks` so the
 * workers that only delete tasks don't pull in task creation's dependencies.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';

/** How many subtask levels below a task are followed when walking its tree. */
export const MAX_SUBTASK_DEPTH = 10;

/** A task removed by `softDeleteTaskTree`, enough for the caller's events. */
export interface RemovedTask {
  id: string;
  projectId: string | null;
  title: string;
  calendarEventId: string | null;
}

/**
 * Soft-delete a task together with its whole subtask tree, in one atomic write:
 *
 * - every descendant (BFS over `parentTaskId`, bounded by `MAX_SUBTASK_DEPTH`).
 *   Project views only list a subtask under its parent, so a subtask left
 *   behind would vanish there yet stay live in My Tasks, digests and counts;
 * - the calendar slot linked to each removed task;
 * - the removed ids from every other live task's `dependsOn` / `blocks`,
 *   workspace-wide, since a dependency can cross projects.
 *
 * Returns the removed tasks, the requested one first, or `null` when it does
 * not exist or is already deleted. Publishing the `project_task` `deleted`
 * entity event for each one is the caller's job: it needs the Hono context.
 */
export async function softDeleteTaskTree(db: Database, id: string): Promise<RemovedTask[] | null> {
  const t = schema.tasks;
  const columns = { id: t.id, projectId: t.projectId, title: t.title, calendarEventId: t.calendarEventId };

  const [existing] = await db
    .select(columns)
    .from(t)
    .where(and(eq(t.id, id), isNull(t.deletedAt)))
    .limit(1);
  if (!existing) return null;

  const removed: RemovedTask[] = [existing];
  const removedIdSet = new Set([id]);
  let frontier = [id];
  for (let depth = 0; depth < MAX_SUBTASK_DEPTH && frontier.length > 0; depth++) {
    const children = await db
      .select(columns)
      .from(t)
      .where(and(inArray(t.parentTaskId, frontier), isNull(t.deletedAt)));
    const fresh = children.filter((row) => !removedIdSet.has(row.id));
    if (fresh.length === 0) break;
    for (const row of fresh) removedIdSet.add(row.id);
    removed.push(...fresh);
    frontier = fresh.map((row) => row.id);
  }
  const removedIds = [...removedIdSet];

  // Tasks outside the deleted tree that still point at it through dependsOn / blocks.
  const removedIdArray = sql`array[${sql.join(
    removedIds.map((rid) => sql`${rid}`),
    sql`, `,
  )}]::text[]`;
  const dependentTasks = await db
    .select({ id: t.id, dependsOn: t.dependsOn, blocks: t.blocks })
    .from(t)
    .where(
      and(
        isNull(t.deletedAt),
        or(sql`${t.dependsOn}::jsonb ?| ${removedIdArray}`, sql`${t.blocks}::jsonb ?| ${removedIdArray}`),
      ),
    );

  const calendarEventIds = removed
    .map((row) => row.calendarEventId)
    .filter((eventId): eventId is string => !!eventId);

  const now = new Date();
  await atomically(db, (handle) => [
    handle
      .update(t)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(inArray(t.id, removedIds), isNull(t.deletedAt))),
    ...(calendarEventIds.length > 0
      ? [
          handle
            .update(schema.calendarEvents)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              and(inArray(schema.calendarEvents.id, calendarEventIds), isNull(schema.calendarEvents.deletedAt)),
            ),
        ]
      : []),
    ...dependentTasks
      .filter((dep) => !removedIdSet.has(dep.id))
      .map((dep) =>
        handle
          .update(t)
          .set({
            dependsOn: (dep.dependsOn ?? []).filter((did) => !removedIdSet.has(did)),
            blocks: (dep.blocks ?? []).filter((bid) => !removedIdSet.has(bid)),
            updatedAt: now,
          })
          .where(eq(t.id, dep.id)),
      ),
  ]);

  return removed;
}
