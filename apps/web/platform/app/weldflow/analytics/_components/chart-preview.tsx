import { useQuery } from '@tanstack/react-query';
import { analyticsApi, type ChartDataPoint } from '@/app/weldflow/lib/api-client';
import { useI18n } from '@/lib/i18n/provider';
import { AnalyticsChartView } from './analytics-chart';

export interface ChartPreviewQuery {
  entity: string;
  metric: string;
  timeRange: string;
  groupBy: string;
  aggregation: string;
  sortOrder: string;
  limit?: number;
  /** Project builders scope the preview like the saved project report will be. */
  projectId?: string;
}

/** Loads the real data for the chart being configured in the builder. */
export function useChartPreviewData(reportId: string | null, query: ChartPreviewQuery) {
  const { entity, metric, timeRange, groupBy, aggregation, sortOrder, limit, projectId } = query;
  return useQuery({
    queryKey: ['weldflow', 'analytics', 'chart-preview', reportId, entity, metric, timeRange, groupBy, aggregation, sortOrder, limit, projectId],
    queryFn: async () => {
      const result = await analyticsApi.getChartsData(reportId ?? '', [
        { chartId: 'preview', entity, metric, timeRange, groupBy, aggregation, sortOrder, limit, projectId },
      ]);
      if (!result.success) throw new Error(result.error || 'Failed to load preview data');
      return result.data?.preview ?? [];
    },
    enabled: !!reportId && !!entity && !!metric,
    staleTime: 30_000,
  });
}

interface ChartPreviewProps {
  reportId: string | null;
  query: ChartPreviewQuery;
  chartType: string;
  color: string;
  showLegend: boolean;
  smoothCurve: boolean;
  fillArea: boolean;
  showDataLabels: boolean;
}

function Message({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="flex h-72 items-center justify-center text-sm text-muted-foreground text-center px-6">{children}</div>;
}

/** Preview of the chart being built, drawn from the workspace's real data. */
export function ChartPreview({
  reportId,
  query,
  chartType,
  color,
  showLegend,
  smoothCurve,
  fillArea,
  showDataLabels,
}: Readonly<ChartPreviewProps>) {
  const { t } = useI18n();
  const { data, isLoading, isError } = useChartPreviewData(reportId, query);

  if (!query.entity || !query.metric) return <Message>{t.projects.analyticsBuilder.previewSelectData}</Message>;
  if (isLoading) return <Message>{t.projects.analyticsReports.loadingData}</Message>;
  if (isError) return <Message>{t.projects.analyticsBuilder.previewFailed}</Message>;

  const points: ChartDataPoint[] = data ?? [];
  if (points.length === 0) return <Message>{t.projects.analyticsReports.noDataAvailable}</Message>;

  return (
    <AnalyticsChartView
      points={points}
      chartType={chartType}
      color={color}
      showLegend={showLegend}
      smoothCurve={smoothCurve}
      fillArea={fillArea}
      showDataLabels={showDataLabels}
    />
  );
}

