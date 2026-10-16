/**
 * Allow-lists for the columns a client may write on projects, milestones,
 * sprints and project labels (mass-assignment guard, TASK-861 / TASK-769).
 *
 * The create/update Zod schemas are `.passthrough()` (they are shared with
 * external-api and mcp-server), so the routes must never spread the validated
 * body into an insert/update. Everything not listed here (`id`, `deletedAt`,
 * audit timestamps, denormalised counters, server-managed lifecycle stamps) is
 * dropped silently.
 */

/** Pick the allow-listed, defined keys of `body`. */
export function pickWritable(body: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/**
 * Turn ISO date strings into `Date`s for timestamp columns (drizzle calls
 * `toISOString()` on the value, so a raw string would throw and surface as a
 * 500; TASK-784). `null` stays `null` (clears the date). Returns the name of the
 * first field that is not a valid date, so the route can answer 400.
 */
export function coerceTimestamps(
  values: Record<string, unknown>,
  fields: readonly string[],
): { ok: true; values: Record<string, unknown> } | { ok: false; field: string } {
  const out = { ...values };
  for (const field of fields) {
    const v = out[field];
    if (v === undefined || v === null || v instanceof Date) continue;
    const date = typeof v === 'string' || typeof v === 'number' ? new Date(v) : null;
    if (!date || Number.isNaN(date.getTime())) return { ok: false, field };
    out[field] = date;
  }
  return { ok: true, values: out };
}

export const PROJECT_TIMESTAMP_FIELDS = ['startDate', 'endDate', 'actualStartDate', 'actualEndDate'] as const;

/**
 * Project columns a client may set. Counters, progress, actuals, ids and audit
 * columns are server-owned (progress and the counters are derived on read, see
 * `@weldsuite/flow-domain/project-stats`).
 */
export const PROJECT_WRITABLE_FIELDS = [
  'name',
  'description',
  'code',
  'key',
  'customerId',
  'counterpartyId',
  'clientId',
  'projectManagerId',
  'leaderId',
  'administrationId',
  'status',
  'priority',
  'type',
  'health',
  'methodology',
  'visibility',
  'startDate',
  'endDate',
  'actualStartDate',
  'actualEndDate',
  'budgetedHours',
  'budgetedAmount',
  'budgetCurrency',
  'billingMethod',
  'hourlyRate',
  'isBillable',
  'isActive',
  'trackTime',
  'categoryId',
  'color',
  'icon',
  'coverImage',
  'settings',
  'whiteboardData',
  'documentData',
  'goalsData',
] as const;

export const MILESTONE_TIMESTAMP_FIELDS = ['dueDate'] as const;

/** Milestone columns a client may set. `completedAt`, progress and the task counters are server-owned. */
export const MILESTONE_WRITABLE_FIELDS = [
  'name',
  'projectId',
  'description',
  'dueDate',
  'status',
  'deliverables',
  'dependsOn',
  'ownerId',
  'responsible',
  'tags',
  'isKeyMilestone',
] as const;

export const SPRINT_TIMESTAMP_FIELDS = ['startDate', 'endDate'] as const;

/** Sprint columns a client may set. `startedAt` / `completedAt` are stamped by the status transition. */
export const SPRINT_WRITABLE_FIELDS = [
  'name',
  'projectId',
  'goal',
  'status',
  'startDate',
  'endDate',
  'velocity',
  'storyPointsCommitted',
  'storyPointsCompleted',
] as const;

export const PROJECT_LABEL_WRITABLE_FIELDS = ['name', 'color', 'projectId'] as const;
