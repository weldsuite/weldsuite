/**
 * The search and the Filter button of the decision log: which decisions pass,
 * and the values the Decider filter offers.
 */

import type { ActiveFilter } from '@weldsuite/ui/components/filter-pills';
import type { Decision, DecisionStatus } from '@weldsuite/app-api-client/domains/project-governance';

export const DECISION_STATUSES: readonly DecisionStatus[] = ['proposed', 'decided', 'superseded'];

/** The decider filter value for decisions with nobody named. */
export const NO_DECIDER = '__none__';

/** The fields the toolbar's Filter button offers. */
export const FILTER_FIELDS = { status: 'status', decider: 'decider' } as const;

/**
 * The person a decision names: who has to decide while it is proposed, who
 * decided it afterwards. It is what the Decider column shows.
 */
export function deciderOf(decision: Pick<Decision, 'status' | 'deciderId' | 'decidedBy'>): string | null {
  return decision.status === 'proposed' ? decision.deciderId : decision.decidedBy;
}

/** The people the decisions name, each once, for the decider filter. */
export function deciderIdsOf(decisions: readonly Pick<Decision, 'status' | 'deciderId' | 'decidedBy'>[]): string[] {
  const ids = new Set<string>();
  for (const decision of decisions) {
    const id = deciderOf(decision);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** A filter the Filter button is still building (no operator or value yet) narrows nothing. */
function isComplete(filter: ActiveFilter): boolean {
  return filter.operator !== '' && filter.value !== '';
}

function filterValue(decision: Decision, field: string): string | null {
  if (field === FILTER_FIELDS.status) return decision.status;
  if (field === FILTER_FIELDS.decider) return deciderOf(decision) ?? NO_DECIDER;
  return null;
}

/** `is` keeps the matches, `is not` drops them; a field that is not known narrows nothing. */
function matchesFilter(decision: Decision, filter: ActiveFilter): boolean {
  const value = filterValue(decision, filter.field);
  if (value === null) return true;
  return filter.operator === 'is not' ? value !== filter.value : value === filter.value;
}

function searchText(decision: Decision): string {
  return `${decision.code} ${decision.title} ${decision.context ?? ''}`.toLowerCase();
}

/** The decisions that pass the search (code, title, context) and every filter. */
export function applyDecisionFilters(decisions: readonly Decision[], search: string, filters: readonly ActiveFilter[]): Decision[] {
  const query = search.trim().toLowerCase();
  const active = filters.filter(isComplete);
  return decisions.filter((decision) => {
    if (query && !searchText(decision).includes(query)) return false;
    return active.every((filter) => matchesFilter(decision, filter));
  });
}
