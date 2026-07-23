
import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { CustomFieldDefinition } from '@/lib/api/domains/settings';

export type { CustomFieldDefinition } from '@/lib/api/domains/settings';

const customFieldKeys = {
  all: ['custom-fields'] as const,
  list: (entityType?: string) => [...customFieldKeys.all, 'list', entityType] as const,
};

/**
 * Hook to fetch custom field definitions for a given entity type.
 * Backed by app-api `GET /api/custom-fields` (was api-worker
 * `GET /settings/custom-fields`).
 */
export function useCustomFields(entityType?: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: customFieldKeys.list(entityType),
    queryFn: async () => {
      const client = await getClient();
      const query = entityType ? `?entityType=${encodeURIComponent(entityType)}` : '';
      const result = await client.get<{ data: CustomFieldDefinition[] }>(`/custom-fields${query}`);
      return result.data || [];
    },
    enabled,
  });
}
