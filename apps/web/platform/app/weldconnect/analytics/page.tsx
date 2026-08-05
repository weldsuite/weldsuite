
import { PageLoader } from '@/components/page-loader';
import {
  useConnectDashboardStats,
  useExecutionTrends,
  useErrorStats,
  usePerformanceMetrics,
  useSlowExecutions,
} from '@/hooks/queries/use-automation-queries';
import { AnalyticsDashboardClient } from './analytics-dashboard-client';

export default function AnalyticsPage() {
  const { data: dashboardResult, isLoading: isDashboardLoading } = useConnectDashboardStats();
  const { data: trendsResult, isLoading: isTrendsLoading } = useExecutionTrends('day');
  const { data: errorStatsResult, isLoading: isErrorsLoading } = useErrorStats();
  const { data: performanceResult, isLoading: isPerformanceLoading } = usePerformanceMetrics();
  const { data: slowResult, isLoading: isSlowLoading } = useSlowExecutions(10);

  const isLoading = isDashboardLoading || isTrendsLoading || isErrorsLoading || isPerformanceLoading || isSlowLoading;

  const dashboard = dashboardResult?.data;
  const stats = dashboard
    ? {
        totalExecutions: dashboard.executions.total,
        successfulExecutions: dashboard.executions.completed,
        failedExecutions: dashboard.executions.failed,
        pendingExecutions: dashboard.executions.queued + dashboard.executions.running,
      }
    : null;

  const rawPerformance = performanceResult?.data;
  const performanceMetrics = rawPerformance
    ? {
        averageDuration: rawPerformance.averageDuration,
        minDuration: rawPerformance.minDuration,
        maxDuration: rawPerformance.maxDuration,
        totalDuration: rawPerformance.averageDuration * (rawPerformance.completedExecutions || 0),
      }
    : null;

  return (
    <AnalyticsDashboardClient
      isLoading={isLoading}
      stats={stats}
      trends={trendsResult?.data ?? null}
      errorStats={errorStatsResult?.data ?? null}
      performanceMetrics={performanceMetrics}
      slowExecutions={slowResult?.data ?? []}
    />
  );
}
