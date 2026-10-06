
import {
  useConnectDashboardStats,
  useExecutionTrends,
  usePerformanceMetrics,
  useSlowExecutions,
} from '@/hooks/queries/use-automation-queries';
import { useWorkflowErrors } from '@/hooks/queries/use-workflow-error-queries';
import { AnalyticsDashboardClient } from './analytics-dashboard-client';
import { summarizeExecutions } from './analytics-utils';

// Every figure here leaves out Test runs and CRM sequences (connect-api applies
// the same `notTestRun` / `notSequenceRun` filters to each endpoint).
const TREND_PERIOD = 'month';

export default function AnalyticsPage() {
  const { data: dashboardResult, isLoading: isDashboardLoading } = useConnectDashboardStats();
  const { data: trendsResult, isLoading: isTrendsLoading } = useExecutionTrends(TREND_PERIOD);
  // Aggregates only (counts, by type, by workflow); the error log pages its own rows.
  const { data: errorStats, isLoading: isErrorsLoading } = useWorkflowErrors({ limit: 1 });
  const { data: performanceResult, isLoading: isPerformanceLoading } = usePerformanceMetrics();
  const { data: slowResult, isLoading: isSlowLoading } = useSlowExecutions(10);

  const isLoading = isDashboardLoading || isTrendsLoading || isErrorsLoading || isPerformanceLoading || isSlowLoading;

  const dashboard = dashboardResult?.data;
  const stats = dashboard ? summarizeExecutions(dashboard.executions) : null;

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
      trendPeriod={TREND_PERIOD}
      errorStats={errorStats ?? null}
      performanceMetrics={performanceMetrics}
      slowExecutions={slowResult?.data ?? []}
    />
  );
}
