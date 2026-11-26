import type { ActiveFilter } from '@/components/entity-list';

/**
 * Helpers for lists whose filter pills are applied by the server: they turn the
 * pills the person finished (a field, an operator and a value) into query
 * parameters.
 */

/** The value of the finished pill on `field` with `operator` (default `is`), if there is one. */
export function pillValue(active: ActiveFilter[], field: string, operator = 'is'): string | undefined {
  const pill = active.find((f) => f.field === field && f.operator === operator && f.value !== '');
  return pill?.value;
}

/** The `from` / `to` bounds a date pill on `field` sets (`is` pins both, `after` and `before` one each). */
export function dateBounds(active: ActiveFilter[], field: string): { from?: string; to?: string } {
  const is = pillValue(active, field, 'is');
  return {
    from: is ?? pillValue(active, field, 'after'),
    to: is ?? pillValue(active, field, 'before'),
  };
}

/**
 * Client-side filtering for a list that holds all its rows: keeps the rows that
 * every finished `is` / `is not` pill matches. `accessors` read the value a
 * field is compared on; a pill on a field without one is ignored.
 */
export function applyPillFilters<T>(
  items: T[],
  active: ActiveFilter[],
  accessors: Record<string, (row: T) => string | null | undefined>,
): T[] {
  const pills = active.filter((f) => f.value !== '' && (f.operator === 'is' || f.operator === 'is not') && accessors[f.field]);
  if (pills.length === 0) return items;
  return items.filter((row) =>
    pills.every((f) => (accessors[f.field](row) === f.value) === (f.operator === 'is')),
  );
}

/**
 * Rows an `is not` pill rules out. The server cannot negate a filter, so this
 * runs on the rows loaded so far; `accessors` read the value a field is compared on.
 */
export function applyExclusions<T>(
  items: T[],
  active: ActiveFilter[],
  accessors: Record<string, (row: T) => string | null | undefined>,
): T[] {
  const exclusions = active.filter((f) => f.operator === 'is not' && f.value !== '' && accessors[f.field]);
  if (exclusions.length === 0) return items;
  return items.filter((row) => exclusions.every((f) => accessors[f.field](row) !== f.value));
}
