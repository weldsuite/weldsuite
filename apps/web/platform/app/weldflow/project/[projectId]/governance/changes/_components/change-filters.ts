/**
 * The toolbar state of the change requests list: the search text and the
 * Filter button's filters (status, route), applied the way My tasks applies its
 * own: `is` keeps the matches, `is not` drops them.
 */

import type { ActiveFilter } from '@weldsuite/ui/components/filter-pills';
import type { ChangeRequest } from '@weldsuite/app-api-client/domains/flow-approvals';

/** The fields the toolbar's Filter button offers. */
export const CHANGE_FILTER_FIELDS = { status: 'status', route: 'route' } as const;

export interface ChangeFilters {
  search: string;
  filters: ActiveFilter[];
}

export const EMPTY_CHANGE_FILTERS: ChangeFilters = { search: '', filters: [] };

/** A filter the Filter button is still building (no operator or value yet) narrows nothing. */
function isComplete(filter: ActiveFilter): boolean {
  return filter.operator !== '' && filter.value !== '';
}

function fieldValue(change: ChangeRequest, field: string): string | null {
  if (field === CHANGE_FILTER_FIELDS.status) return change.status;
  // A draft has no route yet: it matches no route, so only `is not` keeps it.
  if (field === CHANGE_FILTER_FIELDS.route) return change.route ?? '';
  return null;
}

function matchesFilter(change: ChangeRequest, filter: ActiveFilter): boolean {
  const value = fieldValue(change, filter.field);
  if (value === null) return true;
  return filter.operator === 'is not' ? value !== filter.value : value === filter.value;
}

function searchText(change: ChangeRequest): string {
  return [change.code, change.title, change.description]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();
}

/** The change requests that pass the toolbar's search and filters. */
export function applyChangeFilters(changes: readonly ChangeRequest[], { search, filters }: ChangeFilters): ChangeRequest[] {
  const query = search.trim().toLowerCase();
  const active = filters.filter(isComplete);
  return changes.filter((change) => {
    if (query && !searchText(change).includes(query)) return false;
    return active.every((filter) => matchesFilter(change, filter));
  });
}
