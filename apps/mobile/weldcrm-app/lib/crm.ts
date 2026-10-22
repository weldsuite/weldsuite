/**
 * Pure CRM helpers shared by the screens and the data layer: names, initials,
 * and the task statuses, priorities and repeat options.
 */

export interface NameParts {
  displayName?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  email?: string | null;
}

/** The best name a person or company row has, falling back to the email. */
export function resolveName(parts: NameParts, fallback = ''): string {
  const joined = [parts.firstName, parts.lastName].filter(Boolean).join(' ');
  return (
    parts.displayName?.trim() ||
    parts.fullName?.trim() ||
    joined.trim() ||
    parts.name?.trim() ||
    parts.email?.trim() ||
    fallback
  );
}

/** "JD" for "Jane Doe"; one letter for a single word, "?" for nothing. */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => Array.from(word)[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
  return letters || '?';
}

// ---------------------------------------------------------------------------
// Tasks (flow-api `tasks`, the same statuses as the platform's task dialog)
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'testing', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: string | null | undefined): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value ?? '');
}

/**
 * A stored status to one the app knows. The column is free text: older rows
 * say `in-progress` / `in_review` / `blocked`, and project stages can add
 * their own, which show as To Do.
 */
export function normalizeTaskStatus(status: string | null | undefined): TaskStatus {
  switch (status) {
    case 'in-progress':
      return 'in_progress';
    case 'in_review':
      return 'review';
    case 'blocked':
      return 'backlog';
    case 'completed':
      return 'done';
    default:
      return isTaskStatus(status) ? status : 'todo';
  }
}

/** The priorities the platform's dialog offers; `urgent` is shown but never set. */
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number] | 'urgent';

export const REPEAT_FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly', 'yearly'] as const;
export type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number] | 'custom';

export interface TaskRepeat {
  frequency: RepeatFrequency;
  interval?: number;
  unit?: 'days' | 'weeks' | 'months' | 'years';
}

/**
 * The repeat to save. The form only picks a frequency, and a PATCH replaces
 * `repeat` whole, so an unchanged frequency keeps the stored rule (a web
 * task's "every 3 weeks" keeps its interval and unit).
 */
export function repeatInput(frequency: RepeatFrequency | null, original?: TaskRepeat): TaskRepeat | null {
  if (!frequency) return null;
  if (original?.frequency === frequency) return original;
  return { frequency };
}

/** The kinds of activity the app can log (a subset of the server's `activityType`). */
export const LOGGABLE_ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note'] as const;
export type LoggableActivityType = (typeof LOGGABLE_ACTIVITY_TYPES)[number];
