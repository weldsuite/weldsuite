
import { PageLoader } from '@/components/page-loader';
import {
  useWorkflowStats,
  useExecutionTrends,
  useErrorStats,
  usePerformanceMetrics,
  useSlowExecutions,
} from '@/hooks/queries/use-automation-queries';
import { AnalyticsDashboardClient } from './analytics-dashboard-client';

export default function AnalyticsPage() {
  const { data: statsResult, isLoading: isStatsLoading } = useWorkflowStats();
  const { data: trendsResult, isLoading: isTrendsLoading } = useExecutionTrends('day');
  const { data: errorStatsResult, isLoading: isErrorsLoading } = useErrorStats();
  const { data: performanceResult, isLoading: isPerformanceLoading } = usePerformanceMetrics();
  const { data: slowResult, isLoading: isSlowLoading } = useSlowExecutions(10);

  if (isStatsLoading || isTrendsLoading || isErrorsLoading || isPerformanceLoading || isSlowLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <AnalyticsDashboardClient
      stats={statsResult?.data ?? null}
      trends={trendsResult?.data ?? null}
      errorStats={errorStatsResult?.data ?? null}
      performanceMetrics={performanceResult?.data ?? null}
      slowExecutions={slowResult?.data ?? []}
    />
  );
}
