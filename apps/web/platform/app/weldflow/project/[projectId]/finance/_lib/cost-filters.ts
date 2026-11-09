/** The Costs toolbar's filter pills as the costs API's filters. */

import { COST_SOURCES, type CostSource } from '@weldsuite/app-api-client/schemas/project-finance';
import type { ActiveFilter } from '@weldsuite/ui/components/list-toolbar';
import type { CostFilters } from '@/hooks/queries/use-project-finance-queries';

export const COST_FILTER_FIELDS = { source: 'source', date: 'date' } as const;

export interface CostQuery {
  /** What the API filters on: one source, and an inclusive date range. */
  filters: CostFilters;
  /** A source to leave out ("is not"), which the API cannot do: dropped from the loaded lines. */
  excludedSource?: CostSource;
}

function isSource(value: string): value is CostSource {
  return (COST_SOURCES as readonly string[]).includes(value);
}

/** `YYYY-MM-DD` moved by whole days. */
function shiftDay(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/**
 * Pills without a value yet are skipped. The API's dates are inclusive, so
 * "after" starts the day after and "before" ends the day before; several date
 * pills narrow the range together.
 */
export function toCostQuery(active: readonly ActiveFilter[]): CostQuery {
  const query: CostQuery = { filters: {} };
  for (const filter of active) {
    if (!filter.value) continue;
    if (filter.field === COST_FILTER_FIELDS.source && isSource(filter.value)) {
      if (filter.operator === 'is not') query.excludedSource = filter.value;
      else query.filters.source = filter.value;
    } else if (filter.field === COST_FILTER_FIELDS.date) {
      const { from, to } = query.filters;
      let start: string | undefined;
      let end: string | undefined;
      if (filter.operator === 'after') start = shiftDay(filter.value, 1);
      else if (filter.operator === 'before') end = shiftDay(filter.value, -1);
      else if (filter.operator === 'is') {
        start = filter.value;
        end = filter.value;
      }
      if (start && (!from || start > from)) query.filters.from = start;
      if (end && (!to || end < to)) query.filters.to = end;
    }
  }
  return query;
}
