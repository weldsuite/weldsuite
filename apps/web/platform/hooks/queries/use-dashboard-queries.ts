
import { useQuery } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
// Legacy client retained only for the documented `/crm/customers` GAP below.
import { sidebarBadgeKeys, type SidebarBadgeCounts } from '@/hooks/use-sidebar-badges';

// =============================================================================
// Types
// =============================================================================

interface DashboardStatsData {
  revenue: { total: number; formatted: string; currency: string };
  expenses: { total: number; formatted: string; currency: string };
  profit: { total: number; formatted: string; currency: string };
  cash: { total: number; formatted: string; currency: string };
  invoices: {
    total: number;
    draft: number;
    sent: number;
    paid: number;
    overdue: number;
    partial: number;
    totalAmount: number;
    paidAmount: number;
    outstandingAmount: number;
    overdueAmount: number;
  };
  bills: {
    total: number;
    draft: number;
    pending: number;
    paid: number;
    overdue: number;
    totalAmount: number;
    paidAmount: number;
    outstandingAmount: number;
  };
  accounts: {
    total: number;
    active: number;
    assets: number;
    liabilities: number;
    equity: number;
    revenue: number;
    expense: number;
  };
  recentInvoices: any[];
  recentBills: any[];
}

interface ConversionFunnelStage {
  stage: string;
  count: number;
  value: number;
}

interface LeadSourceEntry {
  source: string;
  count: number;
}

// =============================================================================
// Default Stats
// =============================================================================

function getDefaultStats(): DashboardStatsData {
  return {
    revenue: { total: 0, formatted: '$0.00', currency: 'USD' },
    expenses: { total: 0, formatted: '$0.00', currency: 'USD' },
    profit: { total: 0, formatted: '$0.00', currency: 'USD' },
    cash: { total: 0, formatted: '$0.00', currency: 'USD' },
    invoices: {
      total: 0,
      draft: 0,
      sent: 0,
      paid: 0,
      overdue: 0,
      partial: 0,
      totalAmount: 0,
      paidAmount: 0,
      outstandingAmount: 0,
      overdueAmount: 0,
    },
    bills: {
      total: 0,
      draft: 0,
      pending: 0,
      paid: 0,
      overdue: 0,
      totalAmount: 0,
      paidAmount: 0,
      outstandingAmount: 0,
    },
    accounts: {
      total: 0,
      active: 0,
      assets: 0,
      liabilities: 0,
      equity: 0,
      revenue: 0,
      expense: 0,
    },
    recentInvoices: [],
    recentBills: [],
  };
}

// =============================================================================
// Query Keys
// =============================================================================

const dashboardKeys = {
  all: ['dashboard'] as const,
  stats: () => [...dashboardKeys.all, 'stats'] as const,
  activityTimeline: (params?: { days?: number; limit?: number }) =>
    [...dashboardKeys.all, 'activity-timeline', params] as const,
  conversionFunnel: () => [...dashboardKeys.all, 'conversion-funnel'] as const,
  leadSources: () => [...dashboardKeys.all, 'lead-sources'] as const,
  dashboard: () => [...dashboardKeys.all, 'data'] as const,
  activity: () => [...dashboardKeys.all, 'activity'] as const,
};

// =============================================================================
// Queries
// =============================================================================

interface DashboardActionStats {
  unfulfilledOrders: number;
  openTickets: number;
  activeDeliveries: number;
  unreadMessages: number;
  activeDeals: number;
  activeProjects: number;
}

const defaultActionStats: DashboardActionStats = {
  unfulfilledOrders: 0,
  openTickets: 0,
  activeDeliveries: 0,
  unreadMessages: 0,
  activeDeals: 0,
  activeProjects: 0,
};

/**
 * Derives dashboard action stats from the shared sidebar-badges query.
 * No extra API call — reuses the same cached data as useSidebarBadges().
 */
function useDashboardStats() {
  return useQuery({
    queryKey: sidebarBadgeKeys.counts(),
    // queryFn is already defined by useSidebarBadges — TanStack Query reuses it
    select: (data: SidebarBadgeCounts): DashboardActionStats => ({
      unfulfilledOrders: data.task || 0,
      openTickets: data.helpdesk || 0,
      activeDeliveries: 0,
      unreadMessages: data.mail || 0,
      activeDeals: 0,
      activeProjects: 0,
    }),
    placeholderData: { mail: 0, helpdesk: 0, task: 0 } as SidebarBadgeCounts,
  });
}

function useDashboard() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: dashboardKeys.dashboard(),
    queryFn: async () => {
      const client = await getClient();
      const [chartRes, appsRes] = await Promise.all([
        client.get<{ data: any[] }>('/dashboard/chart').catch(() => ({ data: [] })),
        client.get<{ data: string[] }>('/dashboard/installed-apps').catch(() => ({ data: [] })),
      ]);
      return {
        chartData: chartRes?.data || [],
        installedAppCodes: appsRes?.data || [],
      };
    },
  });
}

function useDashboardActivity() {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: dashboardKeys.activity(),
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: any[] }>('/dashboard/activity').catch(() => ({ data: [] }));
      return { activity: res?.data || [] };
    },
  });
}

/**
 * Fetches the CRM activity timeline. Optionally filters by number of days and
 * limits the result count.
 */
function useActivityTimeline(params?: { days?: number; limit?: number }) {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: dashboardKeys.activityTimeline(params),
    queryFn: async () => {
      const client = await getClient();
      // app-api caps `limit` at 100 and pages by cursor; the old `pageSize=` had no effect.
      const limit = Math.min(params?.limit || 50, 100);
      const response = await client.get<{
        data: any[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>(`/activities?limit=${limit}`);

      let activities = response.data || [];

      if (params?.days) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - params.days);
        activities = activities.filter((a: any) => {
          if (!a.createdAt) return false;
          return new Date(a.createdAt) >= cutoffDate;
        });
      }

      return activities;
    },
  });
}

/**
 * Fetches opportunity stages with counts for a conversion funnel.
 */
function useConversionFunnel() {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: dashboardKeys.conversionFunnel(),
    queryFn: async () => {
      const client = await getClient();
      // app-api caps `limit` at 100 — the funnel now counts the first 100 rows
      // rather than 500. Paging through the cursor would be the full fix.
      const response = await client.get<{
        data: any[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>('/opportunities?limit=100');

      const opportunities = response.data || [];
      const stages = [
        'prospecting',
        'qualification',
        'proposal',
        'negotiation',
        'closed_won',
      ];

      const funnel: ConversionFunnelStage[] = stages.map((stage) => ({
        stage,
        count: opportunities.filter((o: any) => o.stage === stage).length,
        value: opportunities
          .filter((o: any) => o.stage === stage)
          .reduce((sum: number, o: any) => sum + (o.value || 0), 0),
      }));

      return funnel;
    },
  });
}

/**
 * Fetches lead sources grouped by source name.
 */
function useLeadSources() {
  const { getClient } = useAppApiClient();

  return useQuery({
    queryKey: dashboardKeys.leadSources(),
    queryFn: async () => {
      const client = await getClient();
      // app-api caps `limit` at 100 (was pageSize=500 against the legacy worker).
      const response = await client.get<{
        data: any[];
        pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
      }>('/leads?limit=100');

      const leads = response.data || [];
      const sourceMap = new Map<string, number>();

      leads.forEach((lead: any) => {
        const source = lead.source || 'Unknown';
        sourceMap.set(source, (sourceMap.get(source) || 0) + 1);
      });

      const sources: LeadSourceEntry[] = Array.from(sourceMap.entries()).map(
        ([source, count]) => ({
          source,
          count,
        })
      );

      return sources;
    },
  });
}

