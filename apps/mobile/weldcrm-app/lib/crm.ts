/**
 * Pure CRM helpers shared by the screens and the data layer: names, initials,
 * and the task status mapping between the app and `crm_activities`.
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
// Tasks (crm_activities with type 'task')
// ---------------------------------------------------------------------------

export const TASK_STATUSES = ['todo', 'in-progress', 'blocked', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** App task status to `crm_activities.status`. */
export const TASK_TO_ACTIVITY_STATUS: Record<TaskStatus, string> = {
  todo: 'planned',
  'in-progress': 'in_progress',
  blocked: 'deferred',
  done: 'completed',
};

/** `crm_activities.status` to the app's task status. */
export function activityStatusToTaskStatus(status?: string | null): TaskStatus {
  switch (status) {
    case 'in_progress':
      return 'in-progress';
    case 'completed':
      return 'done';
    case 'deferred':
    case 'cancelled':
      return 'blocked';
    default:
      return 'todo';
  }
}

export function isTaskStatus(value: string | null | undefined): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value ?? '');
}

/** The kinds of activity the app can log (a subset of the server's `activityType`). */
export const LOGGABLE_ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note'] as const;
export type LoggableActivityType = (typeof LOGGABLE_ACTIVITY_TYPES)[number];
