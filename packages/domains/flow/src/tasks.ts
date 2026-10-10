/**
 * Task creation — shared between flow-api's task routes
 * (apps/workers/flow-api/src/routes/tasks/index.ts) and the WeldConnect
 * `create_task` action (apps/workers/connect-api's internal workflow-actions
 * route), which has no task service of its own.
 *
 * Pure business logic; no Hono context. Extracted verbatim from flow-api's
 * `insertTask` helper so both callers stay byte-for-byte identical in
 * behaviour (numbering, stage→status, position, assignee normalisation).
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { syncValuesForEntity, type CustomFieldMap } from '@weldsuite/core-domain/custom-field-values';
import { allocateTaskNumber } from './task-numbering';

type TaskRow = typeof schema.tasks.$inferSelect;

export interface CreateTaskResult {
  row: TaskRow;
  /** Normalised assignee ids (from `assigneeId` and/or `assigneeIds`). */
  assigneeIds: string[];
}

/**
 * Insert a task row. `data` is deliberately loose (`Record<string, unknown>`):
 * callers pass through whatever subset of `tasks` columns they have
 * (flow-api's Zod-validated create body, or the WeldConnect action's own
 * narrower field set) and only the keys read below are ever written. The
 * insert values object is cast once at the call site rather than per-field,
 * since the input is untyped by design.
 */
export async function createTask(
  db: Database,
  data: Record<string, unknown>,
  opts: { projectId?: string | null; userId: string },
): Promise<CreateTaskResult> {
  const t = schema.tasks;
  const projectId = (opts.projectId ?? (data.projectId as string | null | undefined) ?? null) as string | null;
  const id = generateId('task');
  const now = new Date();
  const number = await allocateTaskNumber(db);
  const stageId = data.stageId as string | undefined;

  let resolvedStatus: string = (data.status as string | undefined) ?? 'todo';
  if (stageId) {
    const [stage] = await db
      .select({ systemStatus: schema.projectPipelineStages.systemStatus })
      .from(schema.projectPipelineStages)
      .where(eq(schema.projectPipelineStages.id, stageId))
      .limit(1);
    if (stage?.systemStatus) resolvedStatus = stage.systemStatus;
  }

  const positionWhere = projectId
    ? and(eq(t.projectId, projectId), isNull(t.deletedAt))
    : isNull(t.deletedAt);
  const positionResult = await db
    .select({ maxPosition: sql<number>`coalesce(max(${t.position}), 0)::int` })
    .from(t)
    .where(positionWhere);
  const nextPosition = (positionResult[0]?.maxPosition || 0) + 1;

  // A subtask created without an explicit priority inherits its parent's
  // instead of silently becoming "medium" (the column is NOT NULL, so there is
  // no "unset" to store).
  let priority = data.priority as string | undefined;
  const parentTaskId = data.parentTaskId as string | undefined;
  if (!priority && parentTaskId) {
    const [parent] = await db
      .select({ priority: t.priority })
      .from(t)
      .where(and(eq(t.id, parentTaskId), isNull(t.deletedAt)))
      .limit(1);
    priority = parent?.priority ?? undefined;
  }

  const rawAssigneeIds = data.assigneeIds as string[] | undefined;
  const rawAssigneeId = data.assigneeId as string | undefined;
  const assigneeIds: string[] =
    Array.isArray(rawAssigneeIds) && rawAssigneeIds.length > 0
      ? rawAssigneeIds
      : rawAssigneeId
        ? [rawAssigneeId]
        : [];
  const primaryAssigneeId = assigneeIds[0] ?? null;
  const startDate = data.startDate as string | number | Date | undefined;
  const dueDate = data.dueDate as string | number | Date | undefined;
  const customFields = data.customFields as CustomFieldMap | null | undefined;

  await db.insert(t).values({
    id,
    number,
    projectId,
    title: data.title,
    description: data.description,
    status: resolvedStatus,
    stageId,
    priority: priority ?? 'medium',
    type: data.type ?? 'task',
    assigneeId: primaryAssigneeId,
    assigneeIds: assigneeIds.length > 0 ? assigneeIds : null,
    reporterId: data.reporterId || opts.userId,
    sprintId: data.sprintId,
    milestoneId: data.milestoneId,
    parentTaskId: data.parentTaskId,
    startDate: startDate ? new Date(startDate) : undefined,
    dueDate: dueDate ? new Date(dueDate) : undefined,
    estimatedHours: data.estimatedHours,
    duration: data.duration,
    storyPoints: data.storyPoints,
    tags: data.tags,
    labels: data.labels,
    isBillable: data.isBillable ?? true,
    customerId: data.customerId ?? null,
    contactId: data.contactId ?? null,
    personId: data.personId ?? null,
    customFields,
    dependsOn: data.dependsOn,
    blocks: data.blocks,
    repeat: data.repeat ?? null,
    position: nextPosition,
    progress: '0',
    createdAt: now,
    updatedAt: now,
  } as unknown as typeof t.$inferInsert);

  // Phase 1 dual-write: mirror the customFields blob into the typed values table.
  await syncValuesForEntity(db, 'task', id, customFields);

  const [created] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  return { row: (created ?? { id }) as TaskRow, assigneeIds };
}
