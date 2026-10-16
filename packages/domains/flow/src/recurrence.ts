/**
 * Recurring tasks — working out the next due date and spawning the next
 * occurrence when a repeating task is completed.
 *
 * Used by flow-api's task routes (PATCH, /status, /toggle, /position). Pure
 * business logic; no Hono context. The routes own what happens around the new
 * row (entity event, calendar slot, notifications).
 */

import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { syncValuesForEntity } from '@weldsuite/core-domain/custom-field-values';
import { allocateTaskNumber } from './task-numbering';
import { stageForStatus } from './task-stage';

type TaskRow = typeof schema.tasks.$inferSelect;

export interface RepeatConfig {
  frequency: string;
  interval?: number | null;
  unit?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Upper bound on roll-forward steps, so a bad interval can never spin. */
const MAX_ROLL_FORWARD = 1000;

/** `{ months, days }` one repetition step adds, or null for an unknown frequency. */
function stepOf(repeat: RepeatConfig): { months: number; days: number } | null {
  switch (repeat.frequency) {
    case 'daily':
      return { months: 0, days: 1 };
    case 'weekly':
      return { months: 0, days: 7 };
    case 'biweekly':
      return { months: 0, days: 14 };
    case 'monthly':
      return { months: 1, days: 0 };
    case 'yearly':
      return { months: 12, days: 0 };
    case 'custom': {
      const interval = Math.max(1, Math.floor(repeat.interval || 1));
      switch (repeat.unit || 'days') {
        case 'days':
          return { months: 0, days: interval };
        case 'weeks':
          return { months: 0, days: interval * 7 };
        case 'months':
          return { months: interval, days: 0 };
        case 'years':
          return { months: interval * 12, days: 0 };
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

/** The date `anchor` plus `steps` repetitions, clamping a month-end day (Jan 31 + 1 month = Feb 28/29). */
function addSteps(anchor: Date, step: { months: number; days: number }, steps: number): Date {
  if (step.months > 0) {
    const totalMonths = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + step.months * steps;
    const year = Math.floor(totalMonths / 12);
    const month = totalMonths % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const result = new Date(anchor);
    result.setUTCFullYear(year, month, Math.min(anchor.getUTCDate(), lastDay));
    return result;
  }
  return new Date(anchor.getTime() + step.days * steps * DAY_MS);
}

/**
 * Due date of the next occurrence. Counted from the previous due date (or from
 * `now` when the task had none) and rolled forward until it is after `now`, so
 * completing an overdue task never produces a due date that is already past.
 * Each candidate is derived from the original anchor, not the previous
 * candidate, so a month-end clamp does not drift (Jan 31 → Feb 28 → Mar 31).
 */
export function nextOccurrenceDate(
  currentDueDate: Date | string | null | undefined,
  repeat: RepeatConfig,
  now: Date = new Date(),
): Date {
  const anchor = currentDueDate ? new Date(currentDueDate) : new Date(now);
  const step = stepOf(repeat);
  if (!step || Number.isNaN(anchor.getTime())) return anchor;
  let candidate = addSteps(anchor, step, 1);
  for (let steps = 2; candidate.getTime() <= now.getTime() && steps <= MAX_ROLL_FORWARD; steps++) {
    candidate = addSteps(anchor, step, steps);
  }
  return candidate;
}

/**
 * True when a status change completes the task: it lands on `done` from
 * anything else. Re-sending `done`, reordering inside the Done column or a
 * toggle with a stale client status are not completions.
 */
export function isCompletion(oldStatus: unknown, newStatus: unknown): boolean {
  return newStatus === 'done' && oldStatus !== 'done';
}

/** Fields of the completed task the next occurrence is built from. */
export type RecurringSource = Pick<
  TaskRow,
  | 'projectId'
  | 'title'
  | 'description'
  | 'priority'
  | 'type'
  | 'assigneeId'
  | 'assigneeIds'
  | 'reporterId'
  | 'sprintId'
  | 'milestoneId'
  | 'parentTaskId'
  | 'customerId'
  | 'contactId'
  | 'personId'
  | 'startDate'
  | 'dueDate'
  | 'estimatedHours'
  | 'duration'
  | 'storyPoints'
  | 'tags'
  | 'labels'
  | 'isBillable'
  | 'customFields'
> & { repeat: RepeatConfig | null };

/**
 * An open occurrence that already stands in for the next one: same project,
 * title, assignee and parent, still open, due on the computed date. Completing
 * a task, reopening it and completing it again must not stack a second copy.
 */
async function findExistingOccurrence(
  db: Database,
  source: RecurringSource,
  nextDueDate: Date,
): Promise<string | null> {
  const t = schema.tasks;
  const [existing] = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        isNull(t.deletedAt),
        source.projectId ? eq(t.projectId, source.projectId) : isNull(t.projectId),
        eq(t.title, source.title),
        eq(t.dueDate, nextDueDate),
        notInArray(t.status, ['done', 'cancelled']),
        sql`${t.assigneeId} IS NOT DISTINCT FROM ${source.assigneeId ?? null}`,
        sql`${t.parentTaskId} IS NOT DISTINCT FROM ${source.parentTaskId ?? null}`,
        sql`${t.repeat} IS NOT NULL`,
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}

/**
 * Create the next occurrence of a recurring task: a fresh `todo` task with the
 * same fields and links (project, sprint, milestone, parent, CRM company /
 * person), placed in the project's To Do stage. Works for personal and
 * CRM-linked tasks too (no project). Returns the new row, or null when the
 * source has no repeat config, an unusable one, or an open copy already exists.
 */
export async function createNextOccurrence(
  db: Database,
  source: RecurringSource,
  now: Date = new Date(),
): Promise<TaskRow | null> {
  const repeat = source.repeat;
  if (!repeat || !stepOf(repeat)) return null;

  const t = schema.tasks;
  const nextDueDate = nextOccurrenceDate(source.dueDate, repeat, now);
  if (await findExistingOccurrence(db, source, nextDueDate)) return null;

  let nextStartDate: Date | undefined;
  if (source.startDate && source.dueDate) {
    const duration = new Date(source.dueDate).getTime() - new Date(source.startDate).getTime();
    nextStartDate = new Date(nextDueDate.getTime() - duration);
  }

  const projectId = source.projectId ?? null;
  const positionResult = await db
    .select({ maxPosition: sql<number>`coalesce(max(${t.position}), 0)::int` })
    .from(t)
    .where(projectId ? and(eq(t.projectId, projectId), isNull(t.deletedAt)) : isNull(t.deletedAt));
  const nextPosition = (positionResult[0]?.maxPosition || 0) + 1;
  const number = await allocateTaskNumber(db);
  // The completed occurrence sits in the Done stage; the new one starts in To Do.
  const stageId = await stageForStatus(db, { projectId, stageId: null }, 'todo');

  const id = generateId('task');
  await db.insert(t).values({
    id,
    number,
    projectId,
    stageId: stageId ?? null,
    sprintId: source.sprintId,
    milestoneId: source.milestoneId,
    parentTaskId: source.parentTaskId,
    customerId: source.customerId,
    contactId: source.contactId,
    personId: source.personId,
    title: source.title,
    description: source.description,
    status: 'todo',
    priority: source.priority || 'medium',
    type: source.type || 'task',
    assigneeId: source.assigneeId,
    assigneeIds: source.assigneeIds,
    reporterId: source.reporterId,
    startDate: nextStartDate,
    dueDate: nextDueDate,
    estimatedHours: source.estimatedHours,
    duration: source.duration,
    storyPoints: source.storyPoints,
    tags: source.tags,
    labels: source.labels,
    isBillable: source.isBillable,
    repeat,
    customFields: source.customFields,
    position: nextPosition,
    progress: '0',
    createdAt: now,
    updatedAt: now,
  } as typeof t.$inferInsert);

  // Phase 1 dual-write: mirror the customFields blob into the typed values table.
  await syncValuesForEntity(db, 'task', id, source.customFields);

  const [created] = await db.select().from(t).where(eq(t.id, id)).limit(1);
  return created ?? null;
}
