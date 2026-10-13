/**
 * The list pages use the platform's filter pills (field, then "is" or "is not",
 * then a value). The API filters on one value per field, so "is" goes to the
 * server and "is not" is applied to the rows already loaded.
 */

import { useCallback, useState } from 'react';
import type { ActiveFilter, FilterConfig } from '@/components/panel-entity-list';

export interface FilterOption {
  value: string;
  label: string;
}

/** A pick-one-value filter pill. */
export function selectFilterConfig(field: string, label: string, options: FilterOption[]): FilterConfig {
  return { field, label, options, filterType: 'select' };
}

/** What a field's pill asks for: a value to send to the server, or one to leave out. */
export function readFilter(filters: ActiveFilter[], field: string): { is?: string; isNot?: string } {
  // A pill still being set up has no value yet; it filters nothing.
  const active = filters.find((filter) => filter.field === field && filter.value !== '');
  if (!active) return {};
  return active.operator === 'is not' ? { isNot: active.value } : { is: active.value };
}

/** Sets (or clears, for `undefined`) a field's filter, e.g. from a plain select. */
export function writeFilter(
  filters: ActiveFilter[],
  field: string,
  value: string | undefined,
): ActiveFilter[] {
  const others = filters.filter((filter) => filter.field !== field);
  return value === undefined ? others : [...others, { id: `${field}-select`, field, operator: 'is', value }];
}

/**
 * The pill state of a list with one filtered field. `filters` and `setFilters`
 * go to the list's pills; `value` is what the server is asked for, `excluded` a
 * value to hide from the rows, and `setValue` lets a plain select drive the same state.
 */
export function useSelectFilter(field: string) {
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const { is, isNot } = readFilter(filters, field);
  const setValue = useCallback(
    (value: string | undefined) => setFilters((current) => writeFilter(current, field, value)),
    [field],
  );
  return { filters, setFilters, value: is, excluded: isNot, setValue };
}
