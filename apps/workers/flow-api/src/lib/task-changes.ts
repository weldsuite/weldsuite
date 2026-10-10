/**
 * Field-level diff for a task update, published with the `updated` entity event
 * so the audit trail (and the task panel's History tab) can say what changed:
 * "Status: todo -> in_progress" instead of just "updated 'Task'".
 *
 * Pure: callers resolve assignee names first and pass them in.
 */

import { computeChanges } from '@weldsuite/entity-events';

export type TaskChanges = Record<string, { old: unknown; new: unknown }>;

/** Columns whose changes are worth an audit line, in display order. */
const TRACKED_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'type',
  'dueDate',
  'startDate',
  'labels',
  'tags',
  'repeat',
  'parentTaskId',
  'sprintId',
  'milestoneId',
  'storyPoints',
  'estimatedHours',
  'isBillable',
] as const;

const MAX_TEXT_LENGTH = 120;

function asIso(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

/** Descriptions are rich-text HTML; show a short plain-text excerpt instead. */
function excerpt(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  const text = value.replaceAll(/<[^>]*>/g, ' ').replaceAll(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}...` : text;
}

/** `numeric` columns come back as "2.00" while a PATCH sends "2". */
function asNumber(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? value : n;
}

function normalise(field: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (field === 'estimatedHours') return asNumber(value);
  return asIso(value);
}

function assigneeIdsOf(row: Record<string, unknown>): string[] {
  const ids = row.assigneeIds;
  if (Array.isArray(ids) && ids.length > 0) return ids as string[];
  return typeof row.assigneeId === 'string' && row.assigneeId ? [row.assigneeId] : [];
}

/** Every assignee id an update touches (before and after), for one name lookup. */
export function assigneeIdsInvolved(
  existing: Record<string, unknown>,
  update: Record<string, unknown>,
): string[] {
  if (update.assigneeIds === undefined && update.assigneeId === undefined) return [];
  return [...new Set([...assigneeIdsOf(existing), ...assigneeIdsOf({ ...existing, ...update })])];
}

/**
 * Diff of `existing` against the columns an update writes. `names` maps user id
 * to display name for the assignee line. Returns null when nothing tracked changed.
 */
export function buildTaskChanges(
  existing: Record<string, unknown>,
  update: Record<string, unknown>,
  names: ReadonlyMap<string, string> = new Map(),
): TaskChanges | null {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of TRACKED_FIELDS) {
    if (update[field] === undefined) continue;
    before[field] = normalise(field, existing[field]);
    after[field] = normalise(field, update[field]);
  }
  const changes: TaskChanges = computeChanges(before, after) ?? {};

  if (changes.description) {
    const { old, new: next } = changes.description;
    changes.description = { old: excerpt(old), new: excerpt(next) };
  }

  if (update.assigneeIds !== undefined || update.assigneeId !== undefined) {
    const oldIds = assigneeIdsOf(existing);
    const newIds = assigneeIdsOf({ ...existing, ...update });
    if (oldIds.join(',') !== newIds.join(',')) {
      const label = (ids: string[]) =>
        ids.length > 0 ? ids.map((id) => names.get(id) ?? id).join(', ') : null;
      changes.assigneeName = { old: label(oldIds), new: label(newIds) };
    }
  }

  // A stage move that doesn't change the status (custom stages) is still a change.
  if (!changes.status && update.stageId !== undefined && update.stageId !== existing.stageId) {
    changes.stageId = { old: existing.stageId ?? null, new: update.stageId ?? null };
  }

  return Object.keys(changes).length > 0 ? changes : null;
}
