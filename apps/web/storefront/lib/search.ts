/** Query parameters of the listing pages, checked: anything else is dropped. */

const SORTS = ['name', '-name', 'price', '-price', 'newest'] as const;
export type SortParam = (typeof SORTS)[number];

export interface ListingSearch {
  sort?: SortParam;
  cursor?: string;
  q?: string;
  error?: string;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined;
}

export function listingSearch(search: Record<string, unknown>): ListingSearch {
  const sort = typeof search.sort === 'string' && (SORTS as readonly string[]).includes(search.sort) ? (search.sort as SortParam) : undefined;
  const out: ListingSearch = {};
  if (sort) out.sort = sort;
  const cursor = text(search.cursor, 500);
  if (cursor) out.cursor = cursor;
  const q = text(search.q, 200);
  if (q) out.q = q;
  const error = text(search.error, 60);
  if (error) out.error = error;
  return out;
}

/** One string parameter, at most `max` characters. */
export function param(search: Record<string, unknown>, name: string, max = 200): string | undefined {
  return text(search[name], max);
}
