import type { GroupConfig } from '@/components/entity-list';

/**
 * Appends a catch-all group holding every item the other groups don't match.
 *
 * `EntityList` drops an item that matches no group, so a task whose status no
 * stage maps to, whose priority nobody listed or whose assignee has left would
 * silently vanish from a grouped list.
 */
export function withOtherGroup<T>(groups: GroupConfig<T>[], label: string): GroupConfig<T>[] {
  if (groups.length === 0) return groups;
  return [
    ...groups,
    {
      id: 'other',
      label,
      sortOrder: Math.max(...groups.map((g) => g.sortOrder)) + 1,
      filter: (item: T) => !groups.some((g) => g.filter(item)),
    },
  ];
}
