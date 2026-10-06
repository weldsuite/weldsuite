/**
 * WeldFlow task analytics-event payload — shared between flow-api (project
 * task mutation routes, re-exported from
 * apps/workers/flow-api/src/lib/weldflow-analytics-payload.ts) and
 * connect-api (the WeldConnect `create_task` action), so analytics-worker
 * enrichment of `project_task` events never drifts between the two callers
 * that can create a task.
 */

import type { DataFor } from '@weldsuite/entity-events/events';

export function isTaskOverdue(dueDate: Date | string | null | undefined, status: string | null | undefined): boolean {
  if (!dueDate) return false;
  if (status === 'done' || status === 'cancelled') return false;
  const due = dueDate instanceof Date ? dueDate : new Date(dueDate);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < Date.now();
}

/** Fields expected by analytics-worker `project_task` ENTITY_CONFIG. */
export function taskAnalyticsPayload(
  task: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): DataFor<'project_task'> & Record<string, unknown> {
  const merged = { ...task, ...overrides };
  const status = (merged.status as string | undefined) ?? undefined;
  const dueDate = (merged.dueDate as Date | string | null | undefined) ?? null;
  const estimatedHours = merged.estimatedHours != null ? Number(merged.estimatedHours) : undefined;
  const actualHours = merged.actualHours != null ? Number(merged.actualHours) : undefined;
  const progress = merged.progress != null ? Number(merged.progress) : undefined;

  return {
    id: merged.id as string,
    title: merged.title as string,
    number: (merged.number as number | null | undefined) ?? null,
    projectId: (merged.projectId as string | null | undefined) ?? null,
    status: status ?? null,
    priority: (merged.priority as string | null | undefined) ?? null,
    type: merged.type ?? null,
    assigneeId: (merged.assigneeId as string | null | undefined) ?? null,
    estimatedHours: Number.isFinite(estimatedHours) ? estimatedHours : undefined,
    actualHours: Number.isFinite(actualHours) ? actualHours : undefined,
    progress: Number.isFinite(progress) ? progress : undefined,
    isOverdue: isTaskOverdue(dueDate, status),
  };
}
