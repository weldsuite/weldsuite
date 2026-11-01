
import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useUser } from '@/lib/auth';
import { useWorkspace } from '@/contexts/workspace-context';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useIdleAwareRefetchInterval } from '@/hooks/use-user-idle';
import { useIsAppInstalled } from '@/hooks/use-is-app-installed';
import { useChatActivityUnread } from '@/hooks/queries/use-weldchat-extras-queries';

const SIDEBAR_BADGES_POLL_MS = 60_000;

export interface SidebarBadgeCounts {
  mail: number;
  helpdesk: number;
  /** Pending WeldCommerce orders. Counted by the endpoint, not shown on the rail. */
  orders: number;
}

export const sidebarBadgeKeys = {
  all: ['sidebar-badges'] as const,
  counts: () => [...sidebarBadgeKeys.all, 'counts'] as const,
};

const defaultCounts: SidebarBadgeCounts = { mail: 0, helpdesk: 0, orders: 0 };

/**
 * Decrement the helpdesk badge count by 1 (e.g. when marking a conversation as read).
 * Can be called from any component that has access to the query client.
 */
export function decrementHelpdeskBadge(queryClient: QueryClient): void {
  queryClient.setQueryData<SidebarBadgeCounts>(sidebarBadgeKeys.counts(), (prev) =>
    prev ? { ...prev, helpdesk: Math.max(0, prev.helpdesk - 1) } : prev
  );
}

/** Refetch the badge counts now, e.g. after mail was marked read or unread. */
export function refreshSidebarBadges(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: sidebarBadgeKeys.counts() });
}

interface UseSidebarBadgesReturn {
  counts: SidebarBadgeCounts;
  isLoading: boolean;
  refresh: () => void;
}

export function useSidebarBadges(): UseSidebarBadgesReturn {
  useUser();
  useWorkspace();
  const { getClient } = useAppApiClient();
  const queryClient = useQueryClient();
  const refetchInterval = useIdleAwareRefetchInterval(sidebarBadgeKeys.counts(), SIDEBAR_BADGES_POLL_MS);

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
          orders: result.data.pendingOrders || 0,
        };
      }
      return defaultCounts;
    },
    // Poll every 60s for counts that don't have real-time updates (task/orders),
    // but not while the user is idle: an unattended visible tab would otherwise
    // keep the workspace database awake. Refreshes once when they come back.
    refetchInterval,
    placeholderData: defaultCounts,
  });

  return {
    counts: data ?? defaultCounts,
    isLoading,
    refresh: () => refreshSidebarBadges(queryClient),
  };
}

/**
 * The unread count shown on an app's rail icon, or `undefined` for apps that
 * have no badge. Keyed on the real app codes, not legacy aliases.
 */
export function railBadgeCountFor(
  appCode: string,
  counts: SidebarBadgeCounts,
  chatUnread: number
): number | undefined {
  switch (appCode) {
    case 'weldmail':
      return counts.mail;
    case 'welddesk':
      return counts.helpdesk;
    case 'weldchat':
      return chatUnread;
    default:
      return undefined;
  }
}

/**
 * Badge counts for the app rails (desktop and mobile). Returns a lookup from
 * app code to its unread count.
 */
export function useAppRailBadges(): (appCode: string) => number | undefined {
  const { counts } = useSidebarBadges();
  // Only talk to chat-api when the workspace has WeldChat: an app a partner
  // licence leaves out answers 403. Shares its query with WeldChat's sidebar.
  const chatInstalled = useIsAppInstalled('weldchat');
  const { data: chatActivity } = useChatActivityUnread(chatInstalled);
  const chatUnread = chatInstalled ? (chatActivity?.data?.count ?? 0) : 0;

  return useCallback(
    (appCode: string) => railBadgeCountFor(appCode, counts, chatUnread),
    [counts, chatUnread]
  );
}
