/**
 * Human-friendly task numbers.
 *
 * The backend stores a raw workspace-wide integer on each task (`task.number`).
 * Users see it prefixed as `TASK-<number>`. Keep the prefix here so every
 * surface (WeldFlow + WeldCRM) renders it identically.
 */
export const TASK_NUMBER_PREFIX = 'TASK-';

/** Format a raw task number for display, e.g. 1042 → "TASK-1042". */
export function formatTaskNumber(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  return `${TASK_NUMBER_PREFIX}${n}`;
}

/**
 * Parse a user-typed reference back to its raw integer, accepting
 * "TASK-1042", "task-1042", "#1042", or "1042". Returns null if it isn't a
 * task-number reference.
 */
export function parseTaskNumber(input: string): number | null {
  const stripped = input.trim().replace(/^#/, '').replace(/^task-/i, '');
  if (!/^\d+$/.test(stripped)) return null;
  return Number(stripped);
}
