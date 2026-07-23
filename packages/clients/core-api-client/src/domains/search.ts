import type { ClientApi } from '../types';
import type { SearchInput, SearchResponse } from '../schemas/search';

export function createSearchApi(api: ClientApi) {
  return {
    search(input: SearchInput): Promise<SearchResponse> {
      return api.post<SearchResponse>('/search', input);
    },
  };
}
