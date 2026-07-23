/**
 * Translates a saved DeskView's filter shape (AND-of-OR-groups, see
 * packages/core/db/src/schema/desk-views.ts DeskViewFilter) into the flat
 * `DeskConversationFilters` query params the list endpoint understands.
 *
 * v1 support: exactly one OR-group per field, `eq` operator, mapped onto the
 * matching DeskConversationFilters key. This mirrors the "one OR-group per
 * chosen field is fine for v1" note in .claude/welddesk-intercom-plan.md
 * Phase 2 view-editor-dialog spec. Anything richer (multi-value `in`,
 * `contains`, nested OR groups, unknown fields) is left out of the resulting
 * query rather than thrown — the view still "works", just as a looser filter
 * than what was configured, and callers can inspect `unsupported` to warn.
 *
 * Pure + unit-testable on purpose — no fetch, no React.
 */

import type { DeskConversationFilters, DeskViewFilter, DeskViewFilterCondition } from '@/hooks/queries/use-desk-queries';

const SUPPORTED_FIELDS = new Set<keyof DeskConversationFilters>([
  'state',
  'channel',
  'adminAssigneeId',
  'teamAssigneeId',
  'priority',
  'tag',
  'isTicket',
]);

export interface ViewFilterToQueryResult {
  filters: DeskConversationFilters;
  /** Conditions that couldn't be represented in the flat query shape (v1 gap). */
  unsupported: DeskViewFilterCondition[];
}

function coerceValue(field: string, value: unknown): unknown {
  if (field === 'priority' || field === 'isTicket') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value === 'true';
    return Boolean(value);
  }
  return value;
}

/**
 * `teamAssigneeId` has a sentinel: the view builder writes `null`/`''` for
 * "unassigned" (mirrors the 'unassigned' string sentinel the list endpoint's
 * teamAssigneeId param already uses — see desk-conversations schema).
 */
function normalizeTeamAssignee(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'unassigned';
  return String(value);
}

export function viewFilterToQuery(filter: DeskViewFilter): ViewFilterToQueryResult {
  const filters: DeskConversationFilters = {};
  const unsupported: DeskViewFilterCondition[] = [];

  for (const group of filter.groups) {
    // v1: only the first condition of each OR-group is honored (one
    // OR-group per field). Extra conditions in the same group are treated
    // as unsupported so the gap is visible rather than silently dropped.
    const [first, ...rest] = group.conditions;
    if (!first) continue;

    const field = first.field as keyof DeskConversationFilters;
    if (!SUPPORTED_FIELDS.has(field) || first.operator !== 'eq') {
      unsupported.push(first, ...rest);
      continue;
    }

    if (field === 'teamAssigneeId') {
      filters.teamAssigneeId = normalizeTeamAssignee(first.value);
    } else {
      (filters as Record<string, unknown>)[field] = coerceValue(field, first.value);
    }

    unsupported.push(...rest);
  }

  return { filters, unsupported };
}
