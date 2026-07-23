/**
 * App-API federated search domain client — `POST /api/search`.
 *
 * Mirrors apps/workers/app-api/src/routes/search/index.ts. The response is NOT the
 * standard list envelope: `{ data: SearchResultGroup[], query, permittedTypes }`.
 */

import type { ClientApi } from '../types';
import type { SearchInput, SearchResponse } from '../schemas/search';

export function createSearchApi(api: ClientApi) {
  return {
    search(input: SearchInput): Promise<SearchResponse> {
      return api.post<SearchResponse>('/search', input);
    },
  };
}
