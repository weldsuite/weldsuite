import type { ActiveFilter } from '@/components/entity-list';

/**
 * Client-side `applyFilters` for an `EntityList` whose filters are all
 * pick-one-value filters ("is" / "is not"): one matcher per filter field says
 * whether an item has the picked value. Filters still being set up (no
 * operator or value yet) and fields without a matcher are skipped.
 */
export function applySelectFilters<T>(
  items: T[],
  filters: ActiveFilter[],
  matchers: Record<string, (item: T, value: string) => boolean>,
): T[] {
  let result = items;
  for (const filter of filters) {
    if (!filter.operator || !filter.value) continue;
    const matches = matchers[filter.field];
    if (!matches) continue;
    const want = filter.operator !== 'is not';
    result = result.filter((item) => matches(item, filter.value) === want);
  }
  return result;
}
