import { eachDayOfInterval, isWeekend, startOfDay } from 'date-fns';

/** Hours per working day assumed for a scheduled task that has no estimate. */
export const DEFAULT_TASK_HOURS_PER_DAY = 2;

export interface TaskLoadInput {
  startDate?: string | null;
  dueDate?: string | null;
  estimatedHours?: number | string | null;
}

export interface TaskLoad {
  /** False when the task has neither a start nor a due date: it carries no load. */
  scheduled: boolean;
  startAt: Date;
  endAt: Date;
  /** Hours added to each working day in the range. */
  hoursPerDay: number;
  /** The range holds no working day (e.g. Saturday only), so weekends count for it. */
  weekendOnly: boolean;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Spread a task's estimated hours over the working days (Mon-Fri) of its date range.
 *
 * - Weekends are not capacity days, so they get no load (unless the whole range is a weekend).
 * - The per-day load is not capped: a task needing 20h in one day shows as overload.
 * - A task with no dates at all is `scheduled: false` and carries no load; it is listed
 *   separately instead of inventing a week of work starting today.
 * - A task with one date counts for that day only.
 */
export function spreadTaskLoad(input: TaskLoadInput, now: Date = new Date()): TaskLoad {
  const start = parseDate(input.startDate);
  const due = parseDate(input.dueDate);
  if (!start && !due) {
    return { scheduled: false, startAt: now, endAt: now, hoursPerDay: 0, weekendOnly: false };
  }

  const first = (start ?? due) as Date;
  const second = (due ?? start) as Date;
  const [startAt, endAt] = first.getTime() <= second.getTime() ? [first, second] : [second, first];

  const days = eachDayOfInterval({ start: startOfDay(startAt), end: startOfDay(endAt) });
  const workingDays = days.filter((day) => !isWeekend(day)).length;
  const weekendOnly = workingDays === 0;
  const loadDays = weekendOnly ? days.length : workingDays;

  // The API returns numeric columns as strings ("0.50"), so coerce before dividing.
  const estimatedHours = Number(input.estimatedHours) || 0;
  const hoursPerDay = estimatedHours > 0 ? estimatedHours / loadDays : DEFAULT_TASK_HOURS_PER_DAY;

  return { scheduled: true, startAt, endAt, hoursPerDay, weekendOnly };
}

export interface LoadedTask extends TaskLoad {
  id: string;
  assigneeId: string;
}

/** Hours the member's scheduled tasks put on `date`. Weekends carry no load. */
export function dailyLoad<T extends LoadedTask>(
  memberId: string,
  tasks: readonly T[],
  date: Date,
): { totalHours: number; tasks: T[] } {
  const day = startOfDay(date).getTime();
  const weekend = isWeekend(date);
  const memberTasks = tasks.filter(
    (task) =>
      task.scheduled &&
      task.assigneeId === memberId &&
      (!weekend || task.weekendOnly) &&
      day >= startOfDay(task.startAt).getTime() &&
      day <= startOfDay(task.endAt).getTime(),
  );
  const totalHours = memberTasks.reduce((sum, task) => sum + task.hoursPerDay, 0);
  return { totalHours, tasks: memberTasks };
}

export type LoadCategory = 'overloaded' | 'optimal' | 'underloaded';

/**
 * Bucket for the "Workload" filter, from the member's load today against their daily
 * capacity: over 100% is overloaded, under 50% is underloaded, anything between is optimal.
 */
export function loadCategory(hoursToday: number, capacityPerDay: number): LoadCategory {
  const utilization = capacityPerDay > 0 ? hoursToday / capacityPerDay : 0;
  if (utilization > 1) return 'overloaded';
  if (utilization < 0.5) return 'underloaded';
  return 'optimal';
}
