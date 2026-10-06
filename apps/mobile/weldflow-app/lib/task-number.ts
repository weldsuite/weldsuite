/**
 * Human-friendly task numbers.
 *
 * The API returns a raw workspace-wide integer on each task (`task.number`).
 * Users see it as `TASK-<number>`, the same as on the web platform
 * (`apps/web/platform/lib/task-number.ts`).
 */

export const TASK_NUMBER_PREFIX = 'TASK-';

/** Format a raw task number for display, e.g. 1042 → "TASK-1042". */
export function formatTaskNumber(n: number | null | undefined): string | undefined {
  if (n === null || n === undefined) return undefined;
  return `${TASK_NUMBER_PREFIX}${n}`;
}

/** Joins the non-empty parts of a list-row subtitle, e.g. "TASK-12 · Website". */
export function joinSubtitle(...parts: (string | null | undefined)[]): string | undefined {
  const present = parts.filter((p): p is string => !!p);
  return present.length > 0 ? present.join(' · ') : undefined;
}
