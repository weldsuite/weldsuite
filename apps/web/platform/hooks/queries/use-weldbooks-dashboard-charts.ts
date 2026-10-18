import { useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  isDefaultOverview,
  parseDashboardCharts,
  type DashboardChart,
} from '@/app/weldbooks/dashboard/components/custom-charts';
import { preferencesKey, useUserPreferences, type UserPreferences } from './use-settings-queries';

/**
 * The charts of the WeldBooks dashboard overview, in display order, kept in
 * `uiPreferences.weldbooksOverviewCharts` (per user, per workspace; the server
 * merges the key into the stored JSONB). Nothing stored is the default
 * overview. Every write sends the whole list, or `null` when the list is the
 * default again (so it keeps following the default as that changes), and
 * patches the cache first, so adding, editing, moving or removing a chart
 * shows at once; an error rolls it back.
 */
export function useDashboardCharts() {
  const { data, isLoading } = useUserPreferences();
  const { getClient } = useAppApiClient();
  const qc = useQueryClient();
  const charts = useMemo(() => parseDashboardCharts(data?.uiPreferences?.weldbooksOverviewCharts), [data]);

  const mutation = useMutation({
    mutationFn: async (next: DashboardChart[]) => {
      const client = await getClient();
      return client.put<{ data: UserPreferences }>('/user-preferences', {
        uiPreferences: { weldbooksOverviewCharts: isDefaultOverview(next) ? null : next },
      });
    },
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: preferencesKey });
      const previous = qc.getQueryData<UserPreferences>(preferencesKey);
      if (previous) {
        qc.setQueryData<UserPreferences>(preferencesKey, {
          ...previous,
          uiPreferences: { ...previous.uiPreferences, weldbooksOverviewCharts: next },
        });
      }
      return { previous };
    },
    onError: (_err, _next, ctx) => {
      if (ctx?.previous) qc.setQueryData(preferencesKey, ctx.previous);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: preferencesKey });
    },
  });
  const { mutateAsync } = mutation;

  /** Adds the chart at the end, or replaces the one with the same id in place. */
  const saveChart = useCallback(
    (chart: DashboardChart) => {
      const exists = charts.some((c) => c.id === chart.id);
      return mutateAsync(exists ? charts.map((c) => (c.id === chart.id ? chart : c)) : [...charts, chart]);
    },
    [charts, mutateAsync],
  );
  const removeChart = useCallback((id: string) => mutateAsync(charts.filter((c) => c.id !== id)), [charts, mutateAsync]);
  /** Replaces the whole list: a new order, or several removals at once. */
  const setCharts = useCallback((next: DashboardChart[]) => mutateAsync(next), [mutateAsync]);
  /**
   * Undoes a removal: puts `chart` back at `index` in the list as it is now
   * (read from the cache, not this render), so charts removed or changed since
   * stay as they are. A no-op when the chart is already back.
   */
  const restoreChart = useCallback(
    (chart: DashboardChart, index: number) => {
      const current = parseDashboardCharts(
        qc.getQueryData<UserPreferences>(preferencesKey)?.uiPreferences?.weldbooksOverviewCharts,
      );
      if (current.some((c) => c.id === chart.id)) return Promise.resolve();
      const at = Math.min(index, current.length);
      return mutateAsync([...current.slice(0, at), chart, ...current.slice(at)]);
    },
    [qc, mutateAsync],
  );

  return { charts, isLoading, saveChart, removeChart, setCharts, restoreChart, isSaving: mutation.isPending };
}
