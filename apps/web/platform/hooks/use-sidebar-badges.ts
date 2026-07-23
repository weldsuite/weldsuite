
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { useWorkspace } from '@/contexts/workspace-context';
import { useAppApiClient } from '@/lib/api/use-app-api';

export interface SidebarBadgeCounts {
  mail: number;
  helpdesk: number;
  calendar: number;
}

export const sidebarBadgeKeys = {
  all: ['sidebar-badges'] as const,
  counts: () => [...sidebarBadgeKeys.all, 'counts'] as const,
};

const defaultCounts: SidebarBadgeCounts = { mail: 0, helpdesk: 0, calendar: 0 };

/**
 * Decrement the helpdesk badge count by 1 (e.g. when marking a conversation as read).
 * Can be called from any component that has access to the query client.
 */
export function decrementHelpdeskBadge(queryClient: QueryClient): void {
  queryClient.setQueryData<SidebarBadgeCounts>(sidebarBadgeKeys.counts(), (prev) =>
    prev ? { ...prev, helpdesk: Math.max(0, prev.helpdesk - 1) } : prev
  );
}

interface UseSidebarBadgesReturn {
  counts: SidebarBadgeCounts;
  isLoading: boolean;
  refresh: () => void;
}

export function useSidebarBadges(): UseSidebarBadgesReturn {
  useUser();
  const { currentWorkspace } = useWorkspace();
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();

  // Single shared query — TanStack Query deduplicates across all consumers
  const { data, isLoading } = useQuery({
    queryKey: sidebarBadgeKeys.counts(),
    queryFn: async (): Promise<SidebarBadgeCounts> => {
      const client = await getClient();
      // app-api GET /api/dashboard/sidebar-badges (was api-worker
      // GET /settings/sidebar-badges). Same counter payload, `{ data }` envelope.
      const result = await client.get<{
        data?: { unreadMessages: number; openTickets: number; pendingOrders: number };
      }>('/dashboard/sidebar-badges');
      if (result.data) {
        return {
          mail: result.data.unreadMessages || 0,
          helpdesk: result.data.openTickets || 0,
          calendar: result.data.pendingOrders || 0,
        };
      }
      return defaultCounts;
    },
    // Poll every 60s for counts that don't have real-time updates (task/orders)
    refetchInterval: 60000,
    placeholderData: defaultCounts,
  });

  return {
    counts: data ?? defaultCounts,
    isLoading,
    refresh: () => queryClient.invalidateQueries({ queryKey: sidebarBadgeKeys.counts() }),
  };
}
