/** Pure helpers for the filters of a query spec: completeness, toggling, parsing and describing. */

import type { PanelFilter, PanelFilterColumn, PanelFilterOperator } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import type { TranslationsType } from '@/lib/i18n/types';

export type FilterLabels = TranslationsType['weldpanel']['analytics']['filters'];

export const VALUELESS_OPERATORS: readonly PanelFilterOperator[] = ['is_set', 'is_not_set'];

export function operatorNeedsValue(operator: PanelFilterOperator): boolean {
  return !VALUELESS_OPERATORS.includes(operator);
}

/** A filter the API accepts: a cohort needs its id, the rest a key or column and, mostly, a value. */
export function isFilterComplete(filter: PanelFilter): boolean {
  if (filter.source === 'cohort') return filter.cohortId !== '';
  if (filter.source !== 'column' && filter.key === '') return false;
  if (!operatorNeedsValue(filter.operator)) return true;
  const value = filter.value;
  if (value === undefined || value === '') return false;
  return !(Array.isArray(value) && value.length === 0);
}

/** The text of a value in a chip or input: a list shows comma separated. */
export function formatFilterValue(value: string | number | boolean | (string | number)[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * Turns what a person typed into a filter value: a list for `in`, a number for
 * `gt` and `lt` when it looks like one, else the text as typed.
 */
export function parseFilterValue(text: string, operator: PanelFilterOperator): string | number | (string | number)[] | undefined {
  const trimmed = text.trim();
  if (!operatorNeedsValue(operator)) return undefined;
  if (operator === 'in') {
    const parts = trimmed
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    return parts.length > 0 ? parts : undefined;
  }
  if ((operator === 'gt' || operator === 'lt') && trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return trimmed === '' ? undefined : trimmed;
}

/** True when the filter list already says `field is value` (a row someone clicked before). */
export function hasColumnFilter(filters: readonly PanelFilter[], field: PanelFilterColumn, value: string): boolean {
  return filters.some((f) => f.source === 'column' && f.field === field && f.operator === 'eq' && f.value === value);
}

/**
 * Click-to-filter: adds `field is value`, replacing an earlier filter on the
 * same field; clicking the same row again removes it.
 */
export function toggleColumnFilter(filters: readonly PanelFilter[], field: PanelFilterColumn, value: string): PanelFilter[] {
  if (hasColumnFilter(filters, field, value)) {
    return filters.filter((f) => !(f.source === 'column' && f.field === field && f.operator === 'eq' && f.value === value));
  }
  const others = filters.filter((f) => !(f.source === 'column' && f.field === field));
  return [...others, { source: 'column', field, operator: 'eq', value }];
}

/** "Country is NL", "plan is one of pro, team" or "in Trial users". */
export function describeFilter(filter: PanelFilter, labels: FilterLabels, cohortName?: (id: string) => string | undefined): string {
  if (filter.source === 'cohort') {
    const name = cohortName?.(filter.cohortId) ?? labels.cohortMissing;
    return (filter.negate ? labels.notInCohort : labels.inCohort).replace('{name}', name);
  }
  const subject = filter.source === 'column' ? labels.columns[filter.field] : filter.key;
  const operator = labels.operators[filter.operator];
  return operatorNeedsValue(filter.operator) ? `${subject} ${operator} ${formatFilterValue(filter.value)}` : `${subject} ${operator}`;
}

/** A stable id for a chip's key. */
export function filterKey(filter: PanelFilter, index: number): string {
  return `${index}:${JSON.stringify(filter)}`;
}
