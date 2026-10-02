import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { personKeys, type PersonSummary } from '@/components/objects/person/use-person-data';

/**
 * Looks up the CRM person that owns an email address (`POST
 * /people/resolve-by-emails`). Resolves to the person id, or `null` when nobody
 * in the workspace has that address. Always asks the server (no stale cache): the
 * callers use the answer to decide between "open this person" and "create one",
 * and a stale "nobody" is how duplicates get made. Rejects on a network or
 * server error so each caller can pick its own fallback.
 */
export function useResolvePersonByEmail() {
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  return useCallback(
    async (email: string): Promise<string | null> => {
      const normalized = email.trim().toLowerCase();
      if (!normalized.includes('@')) return null;

      const res = await queryClient.fetchQuery({
        queryKey: personKeys.byEmails([normalized]),
        queryFn: async () => {
          const client = await getClient();
          return client.post<{ data: PersonSummary[] }>('/people/resolve-by-emails', {
            emails: [normalized],
          });
        },
        staleTime: 0,
      });

      const people = res?.data ?? [];
      const match = people.find((p) => p.email?.toLowerCase() === normalized) ?? people[0];
      return match?.id ?? null;
    },
    [getClient, queryClient],
  );
}
