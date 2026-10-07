/**
 * Human-friendly task numbers.
 *
 * The API returns a raw workspace-wide integer on each task (`task.number`).
 * Users see the bare number (e.g. `1042`), the same as on the web platform
 * (`apps/web/platform/lib/task-number.ts`).
 */

/** Format a raw task number for display, e.g. 1042 → "1042". */
export function formatTaskNumber(n: number | null | undefined): string | undefined {
  if (n === null || n === undefined) return undefined;
  return String(n);
}

/** Joins the non-empty parts of a list-row subtitle, e.g. "12 · Website". */
export function joinSubtitle(...parts: (string | null | undefined)[]): string | undefined {
  const present = parts.filter((p): p is string => !!p);
  return present.length > 0 ? present.join(' · ') : undefined;
}
