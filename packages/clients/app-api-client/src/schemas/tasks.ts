import { z } from 'zod';

/**
 * The built-in task statuses. `review` is the one value for "In review": the
 * default WeldFlow board stage stores it as its `systemStatus`, and the board
 * places a task by matching its status against that. Project stages can add
 * custom statuses, so `tasks.status` itself stays free text.
 */
export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Older spellings still accepted on input and stored as their current value. */
const LEGACY_TASK_STATUSES: Readonly<Record<string, TaskStatus>> = { in_review: 'review' };

/** The stored form of a task status: legacy spellings (`in_review`) map to `review`. */
export function normalizeTaskStatus(status: string): string;
export function normalizeTaskStatus(status: string | null | undefined): string | null | undefined;
export function normalizeTaskStatus(status: string | null | undefined): string | null | undefined {
  if (status == null) return status;
  return LEGACY_TASK_STATUSES[status] ?? status;
}

/**
 * Every stored spelling of a status, for filters that must also match rows
 * written before `in_review` was normalised: `review` → `['review', 'in_review']`.
 */
export function taskStatusAliases(status: string): string[] {
  const canonical = normalizeTaskStatus(status);
  const legacy = Object.keys(LEGACY_TASK_STATUSES).filter((k) => LEGACY_TASK_STATUSES[k] === canonical);
  return [canonical, ...legacy];
}

/** A task status in a request body, normalised on the way in. */
export const taskStatusSchema = z.string().max(30).transform((s) => normalizeTaskStatus(s));

const repeatSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom']),
  interval: z.number().optional(),
  unit: z.enum(['days', 'weeks', 'months', 'years']).optional(),
});

export const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  projectId: z.string().nullish(),
  sprintId: z.string().nullish(),
  milestoneId: z.string().nullish(),
  parentTaskId: z.string().nullish(),
  stageId: z.string().nullish(),
  assigneeId: z.string().nullish(),
  assigneeIds: z.array(z.string()).optional(),
  reporterId: z.string().nullish(),
  status: taskStatusSchema.optional(),
  priority: z.string().max(20).optional(),
  type: z.string().max(50).optional(),
  dueDate: z.string().optional(),
  startDate: z.string().optional(),
  estimateMinutes: z.number().int().optional(),
  estimatedHours: z.string().optional(),
  duration: z.number().optional(),
  storyPoints: z.number().optional(),
  labels: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  customerId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  // CRM person link (new Companies/People model; `contactId` is the legacy
  // equivalent kept during the migration). Used when a task is created from a
  // person panel (WeldCRM) — see `personId` filter support in the list route.
  personId: z.string().nullable().optional(),
  isBillable: z.boolean().optional(),
  dependsOn: z.array(z.string()).optional(),
  blocks: z.array(z.string()).optional(),
  repeat: repeatSchema.nullable().optional(),
  customFields: z.record(z.any()).nullable().optional(),
  metadata: z.unknown().optional(),
}).passthrough();
// PATCH body. An explicit allow-list, not `createTaskSchema.partial()`: the create
// schema is `.passthrough()`, which let a PATCH write any `tasks` column (`id`,
// `number`, `key`, `reporterId`, `deletedAt`, ...). Unknown keys are stripped (not
// rejected) so clients that still send extras, e.g. the CRM task hooks, keep
// working. `projectId`, `dependsOn` and `blocks` are accepted here but handled
// specially server-side (move guard, cycle detection + reciprocal sync).
export const updateTaskSchema = z.object({
  title: createTaskSchema.shape.title.optional(),
  description: createTaskSchema.shape.description,
  status: createTaskSchema.shape.status,
  priority: createTaskSchema.shape.priority,
  type: createTaskSchema.shape.type,
  stageId: createTaskSchema.shape.stageId,
  sprintId: createTaskSchema.shape.sprintId,
  milestoneId: createTaskSchema.shape.milestoneId,
  parentTaskId: createTaskSchema.shape.parentTaskId,
  assigneeId: createTaskSchema.shape.assigneeId,
  // Clients send null to clear every assignee.
  assigneeIds: z.array(z.string()).nullish(),
  customerId: createTaskSchema.shape.customerId,
  contactId: createTaskSchema.shape.contactId,
  personId: createTaskSchema.shape.personId,
  startDate: createTaskSchema.shape.startDate,
  dueDate: createTaskSchema.shape.dueDate,
  estimatedHours: createTaskSchema.shape.estimatedHours,
  // Clients send null to clear the time estimate.
  duration: z.number().nullable().optional(),
  storyPoints: createTaskSchema.shape.storyPoints,
  labels: createTaskSchema.shape.labels,
  tags: createTaskSchema.shape.tags,
  isBillable: createTaskSchema.shape.isBillable,
  repeat: createTaskSchema.shape.repeat,
  customFields: createTaskSchema.shape.customFields,
  projectId: createTaskSchema.shape.projectId,
  dependsOn: createTaskSchema.shape.dependsOn,
  blocks: createTaskSchema.shape.blocks,
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

// Move a task (and its subtasks) to another project. Project-scoped references
// (sprint / milestone / stage / key / board position) are cleared & reset
// server-side to the destination project's defaults.
export const moveTaskSchema = z.object({
  projectId: z.string().min(1),
});
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;
