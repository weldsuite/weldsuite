
import { useMemo, useState } from 'react';
import { GitBranch, Zap, History, BarChart3, ChevronRight, AlertCircle } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Button } from '@weldsuite/ui/components/button';
import { ChartBarInteractive, type ExecutionTrendDataPoint } from './components/chart-bar-interactive';
import { RecentActivityTable, type ActivityItem, type ActivityType } from './components/recent-workflows-table';
import { PageLoader } from '@/components/page-loader';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import type { Translations } from '@weldsuite/i18n/locales';
import type { WorkflowExecution } from '@/hooks/queries/use-automation-queries';
import {
  useWorkflowStats,
  useExecutionTrends,
  useRecentExecutions,
} from '@/hooks/queries/use-automation-queries';

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-amber-500', 'bg-emerald-500',
  'bg-cyan-500', 'bg-rose-500', 'bg-indigo-500', 'bg-lime-500', 'bg-violet-500',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

// The trends endpoint only recognizes 'day' | 'week' | 'month' (anything else
// falls back to 'week' server-side) — map the UI's period selector to the
// closest supported bucket.
function mapPeriodToApi(period: string): string {
  switch (period) {
    case 'today': return 'day';
    case 'monthly': return 'month';
    case 'yearly': return 'month';
    case 'weekly':
    default: return 'week';
  }
}

function mapExecutionToActivity(execution: WorkflowExecution, t: Translations): ActivityItem {
  const type: ActivityType =
    execution.status === 'completed' ? 'workflow_executed'
      : execution.status === 'failed' ? 'execution_failed'
        : 'automation_triggered';

  const workflowName = execution.workflowName || t.weldconnect.executionDetail.unknownWorkflow;

  const triggerLabels: Record<string, string> = {
    entity_event: t.weldconnect.triggerEmptyState.entityEvent,
    schedule: t.weldconnect.triggerEmptyState.schedule,
    webhook: t.weldconnect.triggerEmptyState.webhook,
    manual: t.weldconnect.triggerEmptyState.manual,
  };
  const description = execution.triggerType
    ? t.weldconnect.recentActivityTable.triggeredVia.replace(
      '{type}',
      triggerLabels[execution.triggerType] || execution.triggerType,
    )
    : t.weldconnect.recentActivityTable.triggeredManually;

  const detail = execution.duration != null
    ? formatDuration(execution.duration)
    : (execution.error?.message ?? '');

  return {
    id: execution.id,
    type,
    customerName: workflowName,
    customerInitial: workflowName.charAt(0).toUpperCase() || '?',
    avatarColor: getAvatarColor(workflowName),
    description,
    detail,
    timestamp: new Date(execution.startedAt || execution.createdAt),
    href: `/weldconnect/executions/${execution.id}`,
  };
}

export default function WeldConnectDashboard() {
  const { t } = useI18n();
  const [period, setPeriod] = useState('weekly');

  const statsQuery = useWorkflowStats();
  const trendsQuery = useExecutionTrends(mapPeriodToApi(period));
  const recentQuery = useRecentExecutions(8);

  const isLoading = statsQuery.isLoading || trendsQuery.isLoading || recentQuery.isLoading;
  const isError = statsQuery.isError || trendsQuery.isError || recentQuery.isError;

  const stats = statsQuery.data?.data;
  const chartData: ExecutionTrendDataPoint[] = trendsQuery.data?.data?.trends ?? [];
  const activities: ActivityItem[] = useMemo(
    () => (recentQuery.data?.data ?? []).map((execution) => mapExecutionToActivity(execution, t)),
    [recentQuery.data, t],
  );

  const handleRetry = () => {
    statsQuery.refetch();
    trendsQuery.refetch();
    recentQuery.refetch();
  };

  const actionItems = [
    {
      title: t.weldconnect.dashboard.stats.activeWorkflows.replace('{count}', String(stats?.activeWorkflows ?? 0)),
      icon: GitBranch,
      href: '/weldconnect/workflows',
    },
    {
      title: t.weldconnect.dashboard.stats.failedExecutions.replace('{count}', String(stats?.failedExecutions ?? 0)),
      icon: Zap,
      href: '/weldconnect/executions?status=failed',
    },
    {
      title: t.weldconnect.dashboard.stats.pendingTasks.replace('{count}', String(stats?.pendingExecutions ?? 0)),
      icon: History,
      href: '/weldconnect/executions?status=running',
    },
    {
      title: t.weldconnect.dashboard.stats.successfulExecutions.replace('{count}', String(stats?.successfulExecutions ?? 0)),
      icon: BarChart3,
      href: '/weldconnect/analytics',
    },
  ];

  if (isLoading) {
    return <PageLoader label={t.weldconnect.dashboard.loading} fullScreen={false} />;
  }

  if (isError) {
    return (
      <div className="min-h-full bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center px-4">
          <AlertCircle className="h-10 w-10 text-destructive" />
          <p className="text-sm text-muted-foreground">{t.weldconnect.dashboard.loadError}</p>
          <Button variant="outline" size="sm" onClick={handleRetry}>
            {t.weldconnect.dashboard.retry}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background">
      <div className="container mx-auto p-4 md:p-8 max-w-[1600px] space-y-4 md:space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
              {t.weldconnect.dashboard.title}
            </h1>
          </div>

          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="w-[140px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="today">{t.weldconnect.dashboard.periods.today}</SelectItem>
              <SelectItem value="weekly">{t.weldconnect.dashboard.periods.weekly}</SelectItem>
              <SelectItem value="monthly">{t.weldconnect.dashboard.periods.monthly}</SelectItem>
              <SelectItem value="yearly">{t.weldconnect.dashboard.periods.yearly}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Interactive Chart */}
        <ChartBarInteractive data={chartData} />

        {/* CTA Buttons */}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {actionItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.title} href={item.href}>
                <div className="group relative overflow-hidden rounded-lg border bg-card p-3 transition-all hover:bg-accent/50">
                  <div className="flex items-center gap-3">
                    <div className="rounded-md bg-muted p-1.5 flex-shrink-0">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-tight">{item.title}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {/* Recent Activity */}
        <RecentActivityTable activities={activities} />
      </div>
    </div>
  );
}
