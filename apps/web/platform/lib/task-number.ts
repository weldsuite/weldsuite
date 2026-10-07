/**
 * Human-friendly task numbers.
 *
 * The backend stores a raw workspace-wide integer on each task (`task.number`).
 * Users see the bare number (e.g. `1042`). Format it here so every surface
 * (WeldFlow + WeldCRM) renders it identically.
 */

/** Format a raw task number for display, e.g. 1042 → "1042". */
export function formatTaskNumber(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  return String(n);
}

/**
 * Parse a user-typed reference back to its raw integer, accepting "1042",
 * "#1042", or the legacy "TASK-1042" / "task-1042". Returns null if it isn't a
 * task-number reference.
 */
export function parseTaskNumber(input: string): number | null {
  const stripped = stripTaskNumberPrefix(input);
  if (!/^\d+$/.test(stripped)) return null;
  return Number(stripped);
}

/**
 * Whether a task's number matches a free-text search query. Accepts the same
 * forms as `parseTaskNumber`, so "#104" and "TASK-104" still find task 1042.
 */
export function taskNumberMatches(n: number | null | undefined, query: string): boolean {
  if (n === null || n === undefined) return false;
  const q = stripTaskNumberPrefix(query);
  return /^\d+$/.test(q) && String(n).includes(q);
}

function stripTaskNumberPrefix(input: string): string {
  return input.trim().replace(/^#/, '').replace(/^task-/i, '');
}
