/**
 * Project-scoped references on a task: sprint, milestone, pipeline stage and
 * parent task. Each must belong to the task's own project, otherwise a task ends
 * up on another project's board, in its sprint, or leaks that project's stage
 * `systemStatus` into its own status.
 *
 * Pure business logic; no Hono context. flow-api validates every create and
 * every PATCH with it before writing.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export interface TaskReferences {
  parentTaskId?: string | null;
  sprintId?: string | null;
  milestoneId?: string | null;
  stageId?: string | null;
}

/** The reference fields a request body may carry. */
const REFERENCE_FIELDS = ['sprintId', 'milestoneId', 'stageId', 'parentTaskId'] as const;

async function sprintError(db: Database, projectId: string | null, sprintId: string | null | undefined) {
  if (!sprintId) return null;
  if (!projectId) return 'A task without a project cannot be added to a sprint';
  const [sprint] = await db
    .select({ id: schema.sprints.id })
    .from(schema.sprints)
    .where(
      and(
        eq(schema.sprints.id, sprintId),
        eq(schema.sprints.projectId, projectId),
        isNull(schema.sprints.deletedAt),
      ),
    )
    .limit(1);
  return sprint ? null : `Sprint ${sprintId} not found in this project`;
}

async function milestoneError(db: Database, projectId: string | null, milestoneId: string | null | undefined) {
  if (!milestoneId) return null;
  if (!projectId) return 'A task without a project cannot be added to a milestone';
  const [milestone] = await db
    .select({ id: schema.milestones.id })
    .from(schema.milestones)
    .where(
      and(
        eq(schema.milestones.id, milestoneId),
        eq(schema.milestones.projectId, projectId),
        isNull(schema.milestones.deletedAt),
      ),
    )
    .limit(1);
  return milestone ? null : `Milestone ${milestoneId} not found in this project`;
}

async function stageError(db: Database, projectId: string | null, stageId: string | null | undefined) {
  if (!stageId) return null;
  if (!projectId) return 'A task without a project cannot be placed in a pipeline stage';
  const [stage] = await db
    .select({ id: schema.projectPipelineStages.id })
    .from(schema.projectPipelineStages)
    .where(
      and(
        eq(schema.projectPipelineStages.id, stageId),
        eq(schema.projectPipelineStages.projectId, projectId),
        isNull(schema.projectPipelineStages.deletedAt),
      ),
    )
    .limit(1);
  return stage ? null : `Pipeline stage ${stageId} not found in this project`;
}

async function parentTaskError(db: Database, projectId: string | null, parentTaskId: string | null | undefined) {
  if (!parentTaskId) return null;
  const [parent] = await db
    .select({ projectId: schema.tasks.projectId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, parentTaskId), isNull(schema.tasks.deletedAt)))
    .limit(1);
  if (!parent) return `Parent task ${parentTaskId} not found`;
  return (parent.projectId ?? null) === projectId ? null : 'Parent task must belong to the same project';
}

/**
 * Validate the given references against `projectId` (null for a personal / CRM
 * task, which cannot sit in a sprint, milestone or stage). Only references that
 * are set (non-null) are checked; clearing one is always allowed. Returns an
 * error message for the first invalid reference, or null when all are fine.
 */
export async function findInvalidTaskReference(
  db: Database,
  projectId: string | null,
  refs: TaskReferences,
): Promise<string | null> {
  return (
    (await sprintError(db, projectId, refs.sprintId)) ??
    (await milestoneError(db, projectId, refs.milestoneId)) ??
    (await stageError(db, projectId, refs.stageId)) ??
    (await parentTaskError(db, projectId, refs.parentTaskId))
  );
}

/**
 * The references of a PATCH body that actually change the task: set to a value
 * different from the current one. A body that repeats what is stored (clients
 * resend whole forms) must not be re-validated against a sprint that has since
 * been archived.
 */
export function changedTaskReferences(
  existing: TaskReferences,
  data: TaskReferences,
): TaskReferences {
  const changed: TaskReferences = {};
  for (const field of REFERENCE_FIELDS) {
    const next = data[field];
    if (next && next !== existing[field]) changed[field] = next;
  }
  return changed;
}
