import type { GridColumnDef, GridFilter } from '../types';

export type FilterOperator = GridFilter['operator'];

const GENERIC_OPERATORS: FilterOperator[] = [
  'contains',
  'equals',
  'starts_with',
  'is_empty',
  'is_not_empty',
];

const SELECT_OPERATORS: FilterOperator[] = ['equals', 'not_equals', 'in', 'is_empty', 'is_not_empty'];

/**
 * A single/multi-select column with a fixed option list (Status, Lifecycle
 * Stage, ...). Its filter picks values from those options instead of typing
 * free text: the stored value is the option's key ("active"), not its label.
 */
export function isSelectFilterColumn(
  column: Pick<GridColumnDef<unknown>, 'type' | 'options'> | undefined,
): boolean {
  return (
    !!column &&
    (column.type === 'single-select' || column.type === 'multi-select') &&
    !!column.options &&
    column.options.length > 0
  );
}

/** Operators the filter pill offers for a column, in menu order. */
export function getFilterOperators(
  column: Pick<GridColumnDef<unknown>, 'type' | 'options'> | undefined,
): FilterOperator[] {
  return isSelectFilterColumn(column) ? SELECT_OPERATORS : GENERIC_OPERATORS;
}

export function operatorNeedsValue(operator: FilterOperator | ''): boolean {
  return operator !== 'is_empty' && operator !== 'is_not_empty';
}

/** The filter's selected values as a string list (`in` holds several, the rest one). */
export function filterValueList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((v) => v !== '');
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

/**
 * Re-shapes a filter's value when its operator changes between the one-value
 * operators and `in` (a list), so choosing "is any of" on a filter that already
 * has "Active" keeps Active selected, and going back keeps the first pick.
 */
export function coerceFilterValue(value: unknown, operator: FilterOperator): unknown {
  const list = filterValueList(value);
  if (operator === 'in') return list;
  if (!operatorNeedsValue(operator)) return value;
  return list[0] ?? '';
}

const lower = (v: unknown) => String(v ?? '').toLowerCase();

/**
 * Whether a cell value passes one filter. A filter that is still being built
 * (operator chosen, no value yet) lets every row through rather than hiding
 * them. Array cell values (tags, multi-selects) match when any element does.
 */
export function matchesFilter(value: unknown, filter: Pick<GridFilter, 'operator' | 'value'>): boolean {
  const { operator } = filter;
  const cellValues = Array.isArray(value) ? value.map(lower) : [lower(value)];
  const cellText = Array.isArray(value) ? cellValues.join(',') : cellValues[0]!;

  if (operator === 'is_empty') return !value || cellText.trim() === '';
  if (operator === 'is_not_empty') return !!value && cellText.trim() !== '';

  const wanted = filterValueList(filter.value).map(lower);
  if (wanted.length === 0) return true;
  const [first] = wanted as [string];

  switch (operator) {
    case 'contains':
      return cellText.includes(first);
    case 'equals':
      return cellValues.includes(first);
    case 'not_equals':
      return !cellValues.includes(first);
    case 'in':
      return cellValues.some((v) => wanted.includes(v));
    case 'starts_with':
      return cellText.startsWith(first);
    case 'gt':
      return Number.parseFloat(cellText) > Number.parseFloat(first);
    case 'lt':
      return Number.parseFloat(cellText) < Number.parseFloat(first);
    case 'gte':
      return Number.parseFloat(cellText) >= Number.parseFloat(first);
    case 'lte':
      return Number.parseFloat(cellText) <= Number.parseFloat(first);
    default:
      return true;
  }
}
