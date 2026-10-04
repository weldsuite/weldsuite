/**
 * Task label helpers.
 *
 * `tasks.labels` holds label IDs: the platform resolves them by ID and the
 * server's `labelIds` filter matches on them. Older builds of this app wrote
 * label names instead, so a stored entry can be either.
 */

import type { ProjectLabel } from '@/types/weldflow';

/**
 * Maps the entries stored on a task to label IDs.
 *
 * An entry that is a known label ID stays as it is. An entry that is a label
 * name (written by an older build) becomes that label's ID. Anything else is
 * kept untouched, so saving before the label list has loaded, or with a label
 * this user can't see, never drops it from the task.
 */
export function resolveLabelIds(stored: readonly string[], labels: readonly ProjectLabel[]): string[] {
  const ids = new Set(labels.map((l) => l.id));
  const idByName = new Map<string, string>();
  for (const l of labels) {
    if (!idByName.has(l.name)) idByName.set(l.name, l.id);
  }

  const resolved: string[] = [];
  for (const entry of stored) {
    const id = ids.has(entry) ? entry : (idByName.get(entry) ?? entry);
    if (!resolved.includes(id)) resolved.push(id);
  }
  return resolved;
}

/** The label objects for the given IDs, in the order of `labels`. */
export function labelsForIds(labelIds: readonly string[], labels: readonly ProjectLabel[]): ProjectLabel[] {
  return labels.filter((l) => labelIds.includes(l.id));
}
