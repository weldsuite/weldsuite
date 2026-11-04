/**
 * Task relation guards that sit between a request body and the `tasks` row:
 * dependency links (`dependsOn` / `blocks`) with cycle detection and reciprocal
 * sync, and `parentTaskId` / `projectId` validation.
 *
 * Pure database logic, no Hono context and no per-user project access check, so
 * it serves callers that have no per-user project boundary (the public API's
 * workspace-wide `wsk_` keys, the MCP server's v1 routes). flow-api has its own
 * copy of the plan/commit pair with the member-access check folded in.
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { atomically } from '@weldsuite/worker-kit/atomically';
import { generateId } from '@weldsuite/worker-kit/id';
import { softDeleteTaskTree } from './task-tree';

const t = schema.tasks;
const deps = schema.taskDependencies;

export type DependencyFailure = { ok: false; kind: 'not-found' | 'invalid'; message: string };
export type ReciprocalLink = { id: string; set: { blocks?: string[]; dependsOn?: string[] } };

/** A predecessor and the task that waits for it. */
export interface DependencyPair {
  predecessorId: string;
  successorId: string;
}

/**
 * The `task_dependencies` rows a change of the `dependsOn` / `blocks` arrays
 * implies (FLOW-015, transition release): a new pair becomes an `fs` row with
 * lag 0 (a pair that already has a row keeps its type and lag), a dropped pair
 * loses its row. A pair that cannot be a row (a task of another project, or no
 * project) stays in the arrays only.
 */
export interface DependencyRowChanges {
  add: Array<DependencyPair & { projectId: string }>;
  remove: DependencyPair[];
}

export type DependencyPlan = {
  ok: true;
  dependsOn: string[];
  blocks: string[];
  reciprocal: ReciprocalLink[];
  rows: DependencyRowChanges;
};

/** What changed in a task's two lists. */
export interface LinkDiff {
  addedDeps: string[];
  removedDeps: string[];
  addedBlocks: string[];
  removedBlocks: string[];
}

/**
 * What a task waits for: its `dependsOn` array and the predecessors of its
 * `task_dependencies` rows (FLOW-015: cycle detection reads the table, and the
 * arrays too while they are still written by old rows and direct writers).
 */
export async function predecessorsOf(db: Database, taskId: string): Promise<string[]> {
  const [task] = await db.select({ dependsOn: t.dependsOn }).from(t).where(eq(t.id, taskId)).limit(1);
  const rows = await db.select({ predecessorId: deps.predecessorId }).from(deps).where(eq(deps.successorId, taskId));
  return [...new Set([...((task?.dependsOn as string[] | null) ?? []), ...rows.map((row) => row.predecessorId)])];
}

/**
 * True when following what each task waits for, from `newDependsOn`, reaches
 * `taskId` (i.e. adding those edges to `taskId` would close a cycle).
 */
export async function detectCycle(
  db: Database,
  taskId: string,
  newDependsOn: string[],
): Promise<boolean> {
  const visited = new Set<string>();
  const queue = [...newDependsOn];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(await predecessorsOf(db, current)));
  }
  return false;
}

/**
 * What a task waits for once a request is applied, for the cycle check of a new
 * `blocks` edge: its new `dependsOn` list plus the predecessors of its
 * `task_dependencies` rows that the request does not drop.
 */
export async function waitsForAfter(
  db: Database,
  taskId: string,
  newDependsOn: string[],
  removedDeps: string[],
): Promise<string[]> {
  const rows = await db.select({ predecessorId: deps.predecessorId }).from(deps).where(eq(deps.successorId, taskId));
  const kept = rows.map((row) => row.predecessorId).filter((id) => !removedDeps.includes(id));
  return [...new Set([...newDependsOn, ...kept])];
}

/**
 * The rows a diff of a task's two lists implies, for pairs inside one project
 * (both tasks live, same non-null `projectId`). Reads the project of each task
 * involved.
 */
export async function dependencyRowChanges(db: Database, selfId: string, diff: LinkDiff): Promise<DependencyRowChanges> {
  const linkedIds = [...new Set([...diff.addedDeps, ...diff.removedDeps, ...diff.addedBlocks, ...diff.removedBlocks])];
  if (linkedIds.length === 0) return { add: [], remove: [] };
  const rows = await db
    .select({ id: t.id, projectId: t.projectId, deletedAt: t.deletedAt })
    .from(t)
    .where(inArray(t.id, [selfId, ...linkedIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const projectOf = (id: string): string | null => {
    const row = byId.get(id);
    return row && !row.deletedAt ? (row.projectId ?? null) : null;
  };
  const selfProject = projectOf(selfId);
  const sameProject = (other: string): string | null => {
    const project = projectOf(other);
    return selfProject !== null && project === selfProject ? selfProject : null;
  };
  const changes: DependencyRowChanges = { add: [], remove: [] };
  for (const pred of diff.addedDeps) {
    const projectId = sameProject(pred);
    if (projectId) changes.add.push({ predecessorId: pred, successorId: selfId, projectId });
  }
  for (const succ of diff.addedBlocks) {
    const projectId = sameProject(succ);
    if (projectId) changes.add.push({ predecessorId: selfId, successorId: succ, projectId });
  }
  for (const pred of diff.removedDeps) changes.remove.push({ predecessorId: pred, successorId: selfId });
  for (const succ of diff.removedBlocks) changes.remove.push({ predecessorId: selfId, successorId: succ });
  return changes;
}

/**
 * The statements that write those rows, for one `atomically` batch: new pairs
 * are inserted as `fs` / lag 0 and left alone when they already have a row;
 * dropped pairs are deleted.
 */
export function dependencyRowStatements(
  handle: Database,
  changes: DependencyRowChanges,
  userId: string,
  now: Date,
): unknown[] {
  const statements: unknown[] = [];
  if (changes.add.length > 0) {
    statements.push(
      handle
        .insert(deps)
        .values(
          changes.add.map((pair) => ({
            id: generateId('tdp'),
            projectId: pair.projectId,
            predecessorId: pair.predecessorId,
            successorId: pair.successorId,
            type: 'fs' as const,
            lagDays: 0,
            createdBy: userId,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  if (changes.remove.length > 0) {
    statements.push(
      handle
        .delete(deps)
        .where(
          or(
            ...changes.remove.map((pair) =>
              and(eq(deps.predecessorId, pair.predecessorId), eq(deps.successorId, pair.successorId)),
            ),
          ),
        ),
    );
  }
  return statements;
}

/** Who a row made by an array write is credited to when the writer did not say (the public API's keys have no member). */
export const SYSTEM_ACTOR = 'system';

/** The refusals of `/api/task-dependencies`, sent to the client as they are. */
export const DEPENDENCY_MESSAGES = {
  self: 'A task cannot depend on itself',
  noProject: 'Both tasks must belong to a project',
  differentProjects: 'Both tasks must belong to the same project',
  duplicate: 'These tasks are already linked',
  cycle: 'Circular dependency detected',
  listScope: 'Give projectId or taskId',
} as const;

/**
 * Would a new link close a cycle: does the predecessor already wait, through
 * any chain of rows or array entries, for the successor? Reads the table and
 * the arrays, like `detectCycle`.
 */
export async function wouldCloseCycle(db: Database, predecessorId: string, successorId: string): Promise<boolean> {
  return detectCycle(db, successorId, [predecessorId]);
}

/** `list` with `item` once: the arrays hold each id at most once. */
export function withId(ids: readonly string[] | null | undefined, id: string): string[] {
  const list = ids ?? [];
  return list.includes(id) ? [...list] : [...list, id];
}

/** `list` without `id`. */
export function withoutId(ids: readonly string[] | null | undefined, id: string): string[] {
  return (ids ?? []).filter((entry) => entry !== id);
}

/** Every added link must be an existing, live task other than `selfId`. */
async function checkLinksExist(
  db: Database,
  selfId: string | null,
  addedIds: string[],
): Promise<DependencyFailure | null> {
  if (addedIds.length === 0) return null;
  if (selfId && addedIds.includes(selfId)) {
    return { ok: false, kind: 'invalid', message: 'A task cannot depend on or block itself' };
  }
  const rows = await db
    .select({ id: t.id, deletedAt: t.deletedAt })
    .from(t)
    .where(inArray(t.id, addedIds));
  const found = new Map(rows.map((row) => [row.id, row]));
  for (const linkedId of addedIds) {
    const row = found.get(linkedId);
    if (!row || row.deletedAt) {
      return { ok: false, kind: 'invalid', message: `Linked task ${linkedId} not found` };
    }
  }
  return null;
}

async function anyAsync<T>(items: T[], test: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) {
    if (await test(item)) return true;
  }
  return false;
}

/**
 * The reciprocal side of a dependency change: a task this one depends on lists it
 * in `blocks`, and a task it blocks lists it in `dependsOn`. Returns the linked
 * rows to write; nothing is written here.
 */
async function reciprocalLinkUpdates(
  db: Database,
  selfId: string,
  diff: { addedDeps: string[]; removedDeps: string[]; addedBlocks: string[]; removedBlocks: string[] },
): Promise<ReciprocalLink[]> {
  const linkedIds = [
    ...new Set([...diff.addedDeps, ...diff.removedDeps, ...diff.addedBlocks, ...diff.removedBlocks]),
  ];
  if (linkedIds.length === 0) return [];
  const rows = await db
    .select({ id: t.id, blocks: t.blocks, dependsOn: t.dependsOn })
    .from(t)
    .where(inArray(t.id, linkedIds));
  const withSelf = (ids: string[]) => [...new Set([...ids, selfId])];
  const withoutSelf = (ids: string[]) => ids.filter((x) => x !== selfId);
  return rows.map((row) => {
    const set: ReciprocalLink['set'] = {};
    const rowBlocks = (row.blocks as string[]) || [];
    const rowDependsOn = (row.dependsOn as string[]) || [];
    if (diff.addedDeps.includes(row.id)) set.blocks = withSelf(rowBlocks);
    if (diff.removedDeps.includes(row.id)) set.blocks = withoutSelf(rowBlocks);
    if (diff.addedBlocks.includes(row.id)) set.dependsOn = withSelf(rowDependsOn);
    if (diff.removedBlocks.includes(row.id)) set.dependsOn = withoutSelf(rowDependsOn);
    return { id: row.id, set };
  });
}

/**
 * Validate the links a request wants to set on a task that does not exist yet
 * (create): every linked task exists, and no cycle would close. A new task has
 * no incoming edges, so a `dependsOn` edge cannot cycle on its own; a `blocks`
 * edge adds the new task to the blocked task's `dependsOn`, which cycles when
 * the blocked task is reachable from the new task's `dependsOn`.
 */
export async function checkNewTaskLinks(
  db: Database,
  input: { dependsOn?: string[]; blocks?: string[] },
): Promise<DependencyFailure | null> {
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  const blocks = [...new Set(input.blocks ?? [])];
  const missing = await checkLinksExist(db, null, [...dependsOn, ...blocks]);
  if (missing) return missing;
  if (dependsOn.some((id) => blocks.includes(id))) {
    return { ok: false, kind: 'invalid', message: 'Circular dependency detected' };
  }
  const cyclic = await anyAsync(blocks, (blockedId) => detectCycle(db, blockedId, dependsOn));
  return cyclic ? { ok: false, kind: 'invalid', message: 'Circular dependency detected' } : null;
}

/**
 * Validates the newly added links of `id` (existence, cycles) and works out the
 * reciprocal rows. Writes nothing; `commitDependencyUpdate` applies the plan.
 */
export async function planDependencyUpdate(
  db: Database,
  id: string,
  input: { dependsOn?: string[]; blocks?: string[] },
): Promise<DependencyPlan | DependencyFailure> {
  const [currentTask] = await db
    .select({ dependsOn: t.dependsOn, blocks: t.blocks })
    .from(t)
    .where(and(eq(t.id, id), isNull(t.deletedAt)))
    .limit(1);
  if (!currentTask) return { ok: false, kind: 'not-found', message: `Task ${id} not found` };

  const oldDependsOn: string[] = (currentTask.dependsOn as string[]) || [];
  const oldBlocks: string[] = (currentTask.blocks as string[]) || [];
  const newDependsOn = input.dependsOn ? [...new Set(input.dependsOn)] : oldDependsOn;
  const newBlocks = input.blocks ? [...new Set(input.blocks)] : oldBlocks;

  const addedDeps = newDependsOn.filter((dep) => !oldDependsOn.includes(dep));
  const removedDeps = oldDependsOn.filter((dep) => !newDependsOn.includes(dep));
  const addedBlocks = newBlocks.filter((b) => !oldBlocks.includes(b));
  const removedBlocks = oldBlocks.filter((b) => !newBlocks.includes(b));

  const invalidLink = await checkLinksExist(db, id, [...addedDeps, ...addedBlocks]);
  if (invalidLink) return invalidLink;

  // A new dependsOn edge closes a cycle when it leads back to this task. A new
  // blocks edge appends this task to the blocked task's dependsOn, so it closes
  // a cycle when the blocked task is reachable from this task's (new) dependsOn.
  const cyclic =
    (addedDeps.length > 0 && (await detectCycle(db, id, addedDeps))) ||
    (addedBlocks.length > 0 &&
      (await anyAsync(addedBlocks, async (blockedId) =>
        detectCycle(db, blockedId, await waitsForAfter(db, id, newDependsOn, removedDeps)),
      )));
  if (cyclic) return { ok: false, kind: 'invalid', message: 'Circular dependency detected' };

  const diff = { addedDeps, removedDeps, addedBlocks, removedBlocks };
  const reciprocal = await reciprocalLinkUpdates(db, id, diff);
  const rows = await dependencyRowChanges(db, id, diff);
  return { ok: true, dependsOn: newDependsOn, blocks: newBlocks, reciprocal, rows };
}

/**
 * Write the task's own row (its dependency lists plus any other column
 * changes), every reciprocal row and the `task_dependencies` rows the lists
 * imply as one unit, so a failure leaves no one-sided link. `userId` is the
 * creator of new rows.
 */
export async function commitDependencyUpdate(
  db: Database,
  id: string,
  plan: DependencyPlan,
  columns: Record<string, unknown> = {},
  userId: string = SYSTEM_ACTOR,
): Promise<void> {
  const now = new Date();
  await atomically(db, (handle) => [
    ...plan.reciprocal.map((link) =>
      handle.update(t).set({ ...link.set, updatedAt: now }).where(eq(t.id, link.id)),
    ),
    handle
      .update(t)
      .set({ ...columns, dependsOn: plan.dependsOn, blocks: plan.blocks, updatedAt: now })
      .where(and(eq(t.id, id), isNull(t.deletedAt))),
    ...dependencyRowStatements(handle, plan.rows, userId, now),
  ]);
}

/**
 * Writes the links of a task that was just created (the create path inserts the
 * row first, then plans and commits its `dependsOn` / `blocks`). When the links
 * cannot be written, the task is taken back out (soft-deleted, so it never shows
 * up and no `created` event is owed): a failed create leaves no link-less task
 * behind for a client retry to duplicate. Returns the failure to report, or null
 * when the links are in place; an unexpected error is rethrown after the cleanup.
 */
export async function linkCreatedTask(
  db: Database,
  id: string,
  input: { dependsOn?: string[]; blocks?: string[] },
  userId: string = SYSTEM_ACTOR,
): Promise<DependencyFailure | null> {
  const discard = () => softDeleteTaskTree(db, id).catch(() => undefined);
  let failure: DependencyFailure;
  try {
    const plan = await planDependencyUpdate(db, id, input);
    if (plan.ok) {
      await commitDependencyUpdate(db, id, plan, {}, userId);
      return null;
    }
    failure = plan;
  } catch (err) {
    await discard();
    throw err;
  }
  await discard();
  return failure;
}

/**
 * True when `candidateId` is `ancestorId` or sits anywhere below it. Walks up the
 * candidate's parent chain and stops at a root, a repeated id (pre-existing
 * cycle) or a generous depth bound.
 */
async function isDescendantOf(
  db: Database,
  candidateId: string,
  ancestorId: string,
): Promise<boolean> {
  const seen = new Set<string>();
  let cursor: string | null = candidateId;
  for (let depth = 0; cursor && depth < 100; depth++) {
    if (cursor === ancestorId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const [row] = await db
      .select({ parentTaskId: t.parentTaskId })
      .from(t)
      .where(eq(t.id, cursor))
      .limit(1);
    cursor = (row?.parentTaskId as string | null | undefined) ?? null;
  }
  return false;
}

/**
 * Pre-write checks on a task's `projectId` / `parentTaskId`. A project change is
 * a move (sprint / milestone / stage / key / position all reset) and is never a
 * plain column write, so a PATCH may only repeat the current project. A changed
 * parent must be a live task of the same project and not one of the task's own
 * descendants. `id` is null on create. Returns an error message or null.
 */
export async function validateTaskRelations(
  db: Database,
  existing: { projectId: string | null; parentTaskId: string | null } | null,
  id: string | null,
  data: { projectId?: string | null; parentTaskId?: string | null },
): Promise<string | null> {
  const currentProjectId = existing?.projectId ?? null;
  if (existing && data.projectId !== undefined && (data.projectId ?? null) !== currentProjectId) {
    return 'projectId cannot be changed with PATCH';
  }
  // On create the project is the one the task is being created in.
  const projectId = existing ? currentProjectId : (data.projectId ?? null);
  const parentId = data.parentTaskId;
  if (parentId === undefined || parentId === null || parentId === existing?.parentTaskId) return null;
  if (id && parentId === id) return 'A task cannot be its own parent';
  const [parent] = await db
    .select({ projectId: t.projectId, deletedAt: t.deletedAt })
    .from(t)
    .where(eq(t.id, parentId))
    .limit(1);
  if (!parent || parent.deletedAt) return `Parent task ${parentId} not found`;
  if ((parent.projectId ?? null) !== projectId) return 'Parent task must belong to the same project';
  if (id && (await isDescendantOf(db, parentId, id))) {
    return 'Cannot move a task under itself or one of its subtasks';
  }
  return null;
}
