/**
 * CRM search — app-api `POST /api/search`.
 *
 * W5 repoint off api-worker's `GET /crm/search`. Two changes worth knowing if
 * this hook is ever wired up again (nothing imports it today):
 *  - the query moved from a `?q=` querystring to a JSON body (GET → POST);
 *  - the response is the federated search shape (`{ data: groups }`, grouped by
 *    entity type and permission-filtered), not a flat CRM-only result array.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

interface SearchGroupItem {
  id: string;
  type: string;
  title: string;
  subtitle?: string | null;
  snippet?: string | null;
  url: string;
  score?: number | null;
}

interface SearchGroup {
  type: string;
  items: SearchGroupItem[];
}

interface SearchResponse {
  data: SearchGroup[];
  query: string;
  permittedTypes: string[];
}

const crmSearchKeys = {
  all: ['crm', 'search'] as const,
  query: (q: string, limit?: number) => [...crmSearchKeys.all, q, limit] as const,
};

function useCrmSearch(query: string, limit = 15, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: crmSearchKeys.query(query, limit),
    queryFn: async () => {
      const client = await getClient();
      // app-api caps `limit` at 20 per type.
      return client.post<SearchResponse>('/search', { q: query, limit: Math.min(limit, 20) });
    },
    enabled: !!query && enabled,
  });
}
