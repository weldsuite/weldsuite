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

/** The inclusive days a date pill allows: "after" starts the day after, "before" ends the day before. */
function dateBounds(filter: ActiveFilter): { start?: string; end?: string } {
  switch (filter.operator) {
    case 'after':
      return { start: shiftDay(filter.value, 1) };
    case 'before':
      return { end: shiftDay(filter.value, -1) };
    case 'is':
      return { start: filter.value, end: filter.value };
    default:
      return {};
  }
}

/** Narrows the range to a date pill's: the later start and the earlier end win. */
function narrowDates(filters: CostFilters, filter: ActiveFilter): void {
  const { start, end } = dateBounds(filter);
  if (start && (!filters.from || start > filters.from)) filters.from = start;
  if (end && (!filters.to || end < filters.to)) filters.to = end;
}

/** A source pill: "is" for the API, "is not" left for the loaded lines. */
function applySource(query: CostQuery, filter: ActiveFilter): void {
  const source = filter.value;
  if (!isSource(source)) return;
  if (filter.operator === 'is not') query.excludedSource = source;
  else query.filters.source = source;
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
    if (filter.field === COST_FILTER_FIELDS.source) applySource(query, filter);
    else if (filter.field === COST_FILTER_FIELDS.date) narrowDates(query.filters, filter);
  }
  return query;
}
