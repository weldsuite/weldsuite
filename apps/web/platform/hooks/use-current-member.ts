/**
 * useCurrentMember / useIsGuest
 *
 * Fetches the authenticated user's workspace_member row from
 * `GET /api/team-members/me` (app-api). Drives:
 *   - sidebar module filtering for EXTERNAL_GUEST users
 *   - the "Guest" badge in the chat member list
 *   - any other UI that needs to know "is this user external".
 *
 * Backed by TanStack Query so the result is shared across components and
 * survives navigation. The 5-minute staleTime matches the api-worker
 * memberType KV TTL closely enough; switching workspaces causes a full
 * page reload, which clears the cache.
 */

import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';

export interface CurrentMember {
  id: string;
  userId: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  role: string;
  roleId: string | null;
  permissions: string[] | null;
  status: string;
  memberType: 'INTERNAL' | 'EXTERNAL_GUEST';
}

export function useCurrentMember() {
  const { getClient } = useAppApiClient();
  return useQuery<CurrentMember | null>({
    queryKey: ['current-member'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: CurrentMember }>('/team-members/me');
      return res?.data ?? null;
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

/**
 * Convenience hook: returns true if the current user is an EXTERNAL_GUEST
 * in the active workspace. Returns false while the lookup is in flight —
 * default-deny for "is guest?" would over-restrict the UI on first paint,
 * and the server enforces the real ceiling regardless.
 */
export function useIsGuest(): boolean {
  const { data } = useCurrentMember();
  return data?.memberType === 'EXTERNAL_GUEST';
}
