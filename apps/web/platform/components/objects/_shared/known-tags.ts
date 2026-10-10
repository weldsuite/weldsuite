/**
 * Tag suggestions for the object panels' Tags row.
 *
 * Tags are free-form strings stored on each company / person; there is no tag
 * catalogue endpoint. The suggestions are therefore the tags the other records
 * already carry, read from the list queries TanStack Query has cached (the
 * Companies / People tables, which the panel opens on top of). Most used first,
 * so the tag a team actually uses is the one offered.
 */

import type { QueryClient, QueryKey } from '@tanstack/react-query';

type Rows = ReadonlyArray<{ tags?: unknown } | null | undefined>;

interface ListLikeData {
  /** Plain list: `{ data: rows[] }`. */
  data?: unknown;
  /** Infinite list: `{ pages: [{ data: rows[] }] }`. */
  pages?: ReadonlyArray<{ data?: unknown } | null | undefined>;
}

function countTagsIn(rows: unknown, counts: Map<string, number>): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows as Rows) {
    const tags = row?.tags;
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      const trimmed = tag.trim();
      if (trimmed) counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    }
  }
}

/**
 * Distinct tags across every cached list under `listKey` (e.g. `companyKeys.lists()`),
 * most used first, ties alphabetical.
 */
export function collectKnownTags(queryClient: QueryClient, listKey: QueryKey): string[] {
  const counts = new Map<string, number>();
  for (const [, cached] of queryClient.getQueriesData<ListLikeData>({ queryKey: listKey })) {
    if (!cached) continue;
    countTagsIn(cached.data, counts);
    for (const page of cached.pages ?? []) countTagsIn(page?.data, counts);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

export interface TagOption {
  /** An existing tag offered as a suggestion. */
  kind: 'existing';
  tag: string;
}

export interface CreateTagOption {
  /** The typed text, offered as a brand-new tag. */
  kind: 'create';
  tag: string;
}

/**
 * What the Tags editor lists under the input for the current draft: matching
 * tags that aren't already on the record (capped), then an explicit
 * "Create '…'" row when the draft isn't an existing tag. Matching is
 * case-insensitive; an exact (case-insensitive) match of an existing tag is
 * offered as that tag rather than as a duplicate under a different spelling.
 */
export function buildTagOptions(
  draft: string,
  suggestions: readonly string[],
  applied: readonly string[],
  limit = 6,
): Array<TagOption | CreateTagOption> {
  const query = draft.trim();
  const needle = query.toLowerCase();
  const appliedLower = new Set(applied.map((tag) => tag.toLowerCase()));

  const matching = suggestions.filter(
    (tag) => !appliedLower.has(tag.toLowerCase()) && tag.toLowerCase().includes(needle),
  );
  const options: Array<TagOption | CreateTagOption> = matching
    .slice(0, limit)
    .map((tag) => ({ kind: 'existing', tag }));

  const alreadyKnown =
    appliedLower.has(needle) || suggestions.some((tag) => tag.toLowerCase() === needle);
  if (query && !alreadyKnown) options.push({ kind: 'create', tag: query });
  return options;
}
