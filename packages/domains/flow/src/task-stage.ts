/**
 * Keeping a task's `status` and its board stage (`stageId`) in step.
 *
 * Project boards and lists place a task by `stageId` first and only fall back
 * to matching `status` against a stage's `systemStatus`, so a write that
 * changes one without the other leaves the task in the wrong column. Used by
 * every task-writing API: flow-api's task routes, and the external-api and
 * mcp-server `/v1/tasks` routes.
 *
 * Pure business logic; no Hono context.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { normalizeTaskStatus } from '@weldsuite/app-api-client/schemas/tasks';

/** The status a stage stands for, or undefined for no stage / an unknown one. */
export async function statusFromStage(db: Database, stageId: unknown): Promise<string | undefined> {
  if (!stageId) return undefined;
  const [stage] = await db
    .select({ systemStatus: schema.projectPipelineStages.systemStatus })
    .from(schema.projectPipelineStages)
    .where(eq(schema.projectPipelineStages.id, stageId as string))
    .limit(1);
  return normalizeTaskStatus(stage?.systemStatus) || undefined;
}

/**
 * The stage a task moves to on a status-only change. Project lists group by
 * stageId first, so a task checked off while its stage is still "To Do" would
 * stay in that group. Keeps the current stage when it already maps to the
 * status, else the project's first stage for it; undefined = leave as is.
 */
export async function stageForStatus(
  db: Database,
  task: { projectId: string | null; stageId: string | null },
  status: string,
): Promise<string | undefined> {
  if (!task.projectId) return undefined;
  const stages = await db
    .select({ id: schema.projectPipelineStages.id, systemStatus: schema.projectPipelineStages.systemStatus })
    .from(schema.projectPipelineStages)
    .where(
      and(
        eq(schema.projectPipelineStages.projectId, task.projectId),
        isNull(schema.projectPipelineStages.deletedAt),
      ),
    )
    .orderBy(asc(schema.projectPipelineStages.position));
  const target = normalizeTaskStatus(status);
  const matches = (s: { systemStatus: string | null }) => normalizeTaskStatus(s.systemStatus) === target;
  const current = stages.find((s) => s.id === task.stageId);
  if (current && matches(current)) return undefined;
  return stages.find(matches)?.id;
}

/**
 * Where a task lands when it moves into `projectId` with its status: the
 * project's first stage for that status (statuses normalised, so a legacy
 * `in_review` row still finds a `review` stage), with the status in its stored
 * form. A status the project has no stage for, or none, gets the first stage
 * and that stage's status (`todo` when the project has no stages).
 */
export async function stagePlacement(
  db: Database,
  projectId: string,
): Promise<(status: string | null) => { stageId: string | null; status: string; matched: boolean }> {
  const stages = await db
    .select({ id: schema.projectPipelineStages.id, systemStatus: schema.projectPipelineStages.systemStatus })
    .from(schema.projectPipelineStages)
    .where(
      and(
        eq(schema.projectPipelineStages.projectId, projectId),
        isNull(schema.projectPipelineStages.deletedAt),
      ),
    )
    .orderBy(asc(schema.projectPipelineStages.position));
  const stageByStatus = new Map<string, string>();
  for (const stage of stages) {
    const status = normalizeTaskStatus(stage.systemStatus);
    if (!stageByStatus.has(status)) stageByStatus.set(status, stage.id);
  }
  const fallback = {
    stageId: stages[0]?.id ?? null,
    status: stages[0] ? normalizeTaskStatus(stages[0].systemStatus) : 'todo',
    matched: false,
  };
  return (status) => {
    const target = normalizeTaskStatus(status);
    const stageId = target ? stageByStatus.get(target) : undefined;
    return stageId && target ? { stageId, status: target, matched: true } : fallback;
  };
}

/**
 * Derive the status from a stage change, or the stage from a status-only
 * change, and stamp `completedDate` when the task moves to done. Mutates
 * `update`; returns the status the task ends up with.
 */
export async function applyStatusChange(
  db: Database,
  existing: { projectId: string | null; stageId: string | null; status: string | null },
  data: { stageId?: string | null; status?: string },
  update: Record<string, unknown>,
): Promise<string | null> {
  const stageStatus = await statusFromStage(db, data.stageId);
  if (stageStatus) update.status = stageStatus;
  if (data.stageId === undefined && typeof update.status === 'string') {
    const stageId = await stageForStatus(db, existing, update.status);
    if (stageId) update.stageId = stageId;
  }

  const resolvedStatus = (update.status as string | undefined) ?? existing.status;
  if (resolvedStatus === 'done' && existing.status !== 'done') {
    update.completedDate = new Date();
  }
  return resolvedStatus;
}
