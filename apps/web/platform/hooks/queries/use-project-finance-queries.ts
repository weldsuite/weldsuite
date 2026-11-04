/**
 * WeldFlow project finance hooks: the figures, the cost lines, the weekly
 * snapshots and the manual forecast (`/api/project-finance`, FLOW-019).
 *
 * Every query lives under `financeKeys.all`. Finance publishes no entity events
 * (the figures are read from other modules), so the pages refetch on mount and
 * a forecast save invalidates the root.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '@weldsuite/api-client';
import { useAppApi, useAppApiClient } from '@/lib/api/use-app-api';
import { projectKeys } from '@/hooks/queries/use-projects-queries';
import type { CostSource, ManualForecastBody } from '@weldsuite/app-api-client/domains/project-finance';

export const financeKeys = {
  all: ['project-finance'] as const,
  figures: (projectId: string) => [...financeKeys.all, 'figures', projectId] as const,
  costs: (projectId: string, filters: CostFilters) => [...financeKeys.all, 'costs', projectId, filters] as const,
  snapshots: (projectId: string) => [...financeKeys.all, 'snapshots', projectId] as const,
  settings: (projectId: string) => [...financeKeys.all, 'settings', projectId] as const,
  pending: (projectId: string) => [...financeKeys.all, 'pending-changes', projectId] as const,
};

export interface CostFilters {
  source?: CostSource;
  from?: string;
  to?: string;
}

/** A 4xx will not heal by retrying (not found, no access). */
function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  return !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 3;
}

export function useProjectFinance(projectId: string) {
  const { projectFinance } = useAppApi();
  return useQuery({
    queryKey: financeKeys.figures(projectId),
    queryFn: async () => (await projectFinance.getFinance(projectId)).data,
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

/** The cost lines, a page at a time. `enabled` stays off for a caller without finance rights. */
export function useProjectCosts(projectId: string, filters: CostFilters, pageSize = 25, enabled = true) {
  const { projectFinance } = useAppApi();
  return useInfiniteQuery({
    queryKey: [...financeKeys.costs(projectId, filters), pageSize],
    queryFn: ({ pageParam }: { pageParam?: string }) =>
      projectFinance.listCosts(projectId, { ...filters, limit: pageSize, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.pagination?.hasMore ? (last.pagination.cursor ?? undefined) : undefined),
    enabled: !!projectId && enabled,
    retry: retryUnlessClientError,
  });
}

export function useFinanceSnapshots(projectId: string) {
  const { projectFinance } = useAppApi();
  return useQuery({
    queryKey: financeKeys.snapshots(projectId),
    queryFn: async () => (await projectFinance.listSnapshots(projectId)).data,
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

export function useFinanceSettings(projectId: string) {
  const { projectFinance } = useAppApi();
  return useQuery({
    queryKey: financeKeys.settings(projectId),
    queryFn: async () => (await projectFinance.getSettings(projectId)).data,
    enabled: !!projectId,
    retry: retryUnlessClientError,
  });
}

export function useSaveForecast(projectId: string) {
  const { projectFinance } = useAppApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ManualForecastBody) => (await projectFinance.saveForecast(projectId, input)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: financeKeys.all });
      void queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
    },
  });
}

/** A change request waiting for approval, as far as the Finance overview reads it. */
export interface PendingChange {
  id: string;
  code: string | null;
  title: string | null;
  /** Decimal string in the project currency; negative when the change saves money. */
  costDelta: number;
}

interface ChangeRow {
  id?: unknown;
  code?: unknown;
  title?: unknown;
  status?: unknown;
  costDelta?: unknown;
}

/**
 * The change requests of the project that wait for approval (`/api/project-changes`,
 * governance). Reads loosely and fails quietly: the overview shows the card only
 * when the governance routes answer.
 */
export function usePendingChanges(projectId: string, enabled = true) {
  const { getClient } = useAppApiClient();
  return useQuery({
    queryKey: financeKeys.pending(projectId),
    queryFn: async (): Promise<PendingChange[]> => {
      const client = await getClient();
      const res = await client.get<{ data?: ChangeRow[] }>(`/project-changes?projectId=${encodeURIComponent(projectId)}&limit=100`);
      return (res.data ?? [])
        .filter((row) => row.status === 'awaiting_approval' && typeof row.id === 'string')
        .map((row) => ({
          id: row.id as string,
          code: typeof row.code === 'string' ? row.code : null,
          title: typeof row.title === 'string' ? row.title : null,
          costDelta: Number(row.costDelta ?? 0) || 0,
        }));
    },
    enabled: !!projectId && enabled,
    retry: false,
    staleTime: 60_000,
  });
}
