/**
 * Helpers to shape WeldFlow entity-event payloads for analytics-worker enrichment.
 *
 * Each helper returns the catalog-typed payload for its entity intersected with
 * `Record<string, unknown>`, so the required fields survive being spread into
 * `publishEntityEvent({ data })` while the extra analytics-only fields
 * (durationSeconds, isOverdue, budgetedHours, …) are still permitted.
 *
 * `isTaskOverdue` / `taskAnalyticsPayload` live in `@weldsuite/flow-domain`
 * (re-exported here) because connect-api's WeldConnect `create_task` action
 * publishes the same `project_task` event and needs the identical shape
 * without reaching into this worker's `lib/` folder.
 */

import type { DataFor } from '@weldsuite/entity-events/events';

export { isTaskOverdue, taskAnalyticsPayload } from '@weldsuite/flow-domain/analytics-payload';

/**
 * Fields expected by analytics-worker `project_time_entry` ENTITY_CONFIG.
 * DB stores duration in minutes; worker expects durationSeconds + actualHours + isBillable.
 */
export function timeEntryAnalyticsPayload(input: {
  id: string;
  projectId?: string | null;
  taskId?: string | null;
  userId: string;
  durationMinutes: number;
  billable?: boolean | null;
}): DataFor<'project_time_entry'> & Record<string, unknown> {
  const minutes = Number(input.durationMinutes) || 0;
  return {
    id: input.id,
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    userId: input.userId,
    assigneeId: input.userId,
    duration: minutes,
    durationSeconds: Math.round(minutes * 60),
    actualHours: Math.round((minutes / 60) * 100) / 100,
    isBillable: input.billable !== false,
  };
}

/** Fields expected for project analytics enrichment. */
export function projectAnalyticsPayload(
  project: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): DataFor<'project'> & Record<string, unknown> {
  const merged = { ...project, ...overrides };
  return {
    id: merged.id as string,
    name: merged.name as string,
    status: (merged.status as string | null | undefined) ?? null,
    health: merged.health ?? null,
    priority: (merged.priority as string | null | undefined) ?? null,
    isActive: merged.isActive ?? true,
    progress: merged.progress != null ? Number(merged.progress) : undefined,
    budgetedAmount: merged.budgetedAmount != null ? Number(merged.budgetedAmount) : undefined,
    actualAmount: merged.actualAmount != null ? Number(merged.actualAmount) : undefined,
    budgetedHours: merged.budgetedHours != null ? Number(merged.budgetedHours) : undefined,
    actualHours: merged.actualHours != null ? Number(merged.actualHours) : undefined,
  };
}
