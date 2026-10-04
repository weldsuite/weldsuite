import type { WeldPassItem } from '@weldsuite/app-api-client/domains/weldpass-passwords';

/** Items whose title, username or site contain every word of the query. */
export function filterItems(items: WeldPassItem[], query: string): WeldPassItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;

  return items.filter((item) => {
    const haystack = `${item.title} ${item.subtitle ?? ''} ${item.host ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
