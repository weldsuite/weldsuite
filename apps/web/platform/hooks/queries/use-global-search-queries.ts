/**
 * Global Cmd+K search hook.
 * Calls POST /api/search via app-api.
 *
 * Types deliberately stay on the core-api schema: the app-api schema is
 * structurally identical but adds `knowledge_page` to the entity-type union,
 * which the platform's search UI maps (RESULT_TYPE_LABEL / RESULT_TYPE_ICON,
 * recents) don't cover yet. The UI degrades gracefully at runtime for unknown
 * types (`?? Search` / `?? group.type` fallbacks).
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useAppApi } from '@/lib/api/use-app-api';
import type { SearchEntityType, SearchResponse } from '@weldsuite/core-api-client/schemas/search';

export interface UseGlobalSearchOptions {
  enabled?: boolean;
  limit?: number;
  types?: SearchEntityType[];
}

const globalSearchKeys = {
  all: ['global-search'] as const,
  query: (q: string, types?: SearchEntityType[], limit?: number) =>
    [...globalSearchKeys.all, q, types ?? null, limit ?? 5] as const,
};

export function useGlobalSearch(q: string, opts: UseGlobalSearchOptions = {}) {
  const { search } = useAppApi();
  const trimmed = q.trim();
  const enabled = (opts.enabled ?? true) && trimmed.length > 0;

  return useQuery<SearchResponse>({
    queryKey: globalSearchKeys.query(trimmed, opts.types, opts.limit),
    queryFn: async () =>
      (await search.search({
        q: trimmed,
        types: opts.types,
        limit: opts.limit ?? 5,
      })) as SearchResponse,
    enabled,
    staleTime: 5_000,
    placeholderData: keepPreviousData,
    // Search query strings are high-cardinality and results are stale almost
    // immediately — persisting them would bloat the cache for no benefit.
    meta: { persist: false },
  });
}
