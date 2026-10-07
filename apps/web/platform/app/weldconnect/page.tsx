
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
import { mapPeriodToApi } from './components/chart-utils';
import { RecentActivityTable, type ActivityItem } from './components/recent-workflows-table';
import { PageLoader } from '@/components/page-loader';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import type { Translations } from '@weldsuite/i18n/locales';
import type { WorkflowExecution } from '@/hooks/queries/use-automation-queries';
import {
  isActiveExecutionStatus,
  useWorkflowStats,
  useExecutionTrends,
  useRecentExecutions,
} from '@/hooks/queries/use-automation-queries';
import { getTriggerLabel } from './trigger-labels';
import {
  extractExecutionError,
  formatExecutionDuration,
  getExecutionDuration,
  normalizeExecutionStatus,
} from './executions/execution-utils';
import { useNow } from './executions/use-now';

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-purple-500', 'bg-pink-500', 'bg-amber-500', 'bg-emerald-500',
  'bg-cyan-500', 'bg-rose-500', 'bg-indigo-500', 'bg-lime-500', 'bg-violet-500',
];

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.codePointAt(i)! + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function mapExecutionToActivity(execution: WorkflowExecution, t: Translations, now: number): ActivityItem {
  const status = normalizeExecutionStatus(execution.status);

  const workflowName = execution.workflowName || t.weldconnect.executionDetail.unknownWorkflow;

  const description = execution.triggerType
    ? t.weldconnect.recentActivityTable.triggeredVia.replace(
      '{type}',
      getTriggerLabel(t, execution.triggerType),
    )
    : t.weldconnect.recentActivityTable.triggeredManually;

  // A failed run says why; every other run says how long it took (or has taken so far).
  const errorMessage = status === 'failed' ? extractExecutionError(execution.error)?.message : undefined;
  const duration = getExecutionDuration(execution, now);
  const detail = errorMessage || (duration != null ? formatExecutionDuration(duration) : '');

  return {
    id: execution.id,
    workflowId: execution.workflowId,
    status,
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
  const { t, plural } = useI18n();
  const [period, setPeriod] = useState('weekly');
  const apiPeriod = mapPeriodToApi(period);

  const statsQuery = useWorkflowStats();
  const trendsQuery = useExecutionTrends(apiPeriod);
  const recentQuery = useRecentExecutions(8);

  const isLoading = statsQuery.isLoading || trendsQuery.isLoading || recentQuery.isLoading;
  const isError = statsQuery.isError || trendsQuery.isError || recentQuery.isError;

  const stats = statsQuery.data?.data;
  const chartData: ExecutionTrendDataPoint[] = trendsQuery.data?.data?.trends ?? [];
  const recentExecutions = recentQuery.data?.data;
  const now = useNow((recentExecutions ?? []).some((e) => isActiveExecutionStatus(e.status)));
  const activities: ActivityItem[] = useMemo(
    () => (recentExecutions ?? []).map((execution) => mapExecutionToActivity(execution, t, now)),
    [recentExecutions, t, now],
  );

  const handleRetry = () => {
    statsQuery.refetch();
    trendsQuery.refetch();
    recentQuery.refetch();
  };

  const statTitles = t.weldconnect.dashboard.stats;
  const actionItems = [
    {
      title: plural(stats?.activeWorkflows ?? 0, statTitles.activeWorkflows),
      icon: GitBranch,
      href: '/weldconnect/workflows',
    },
    {
      title: plural(stats?.failedExecutions ?? 0, statTitles.failedExecutions),
      icon: Zap,
      href: '/weldconnect/executions?status=failed',
    },
    {
      title: plural(stats?.pendingExecutions ?? 0, statTitles.runningExecutions),
      icon: History,
      href: '/weldconnect/executions?status=running',
    },
    {
      title: plural(stats?.successfulExecutions ?? 0, statTitles.successfulExecutions),
      icon: BarChart3,
      // Analytics is hidden for the MVP (see app/weldconnect/mvp.ts).
      href: '/weldconnect/executions?status=completed',
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
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            {t.weldconnect.dashboard.title}
          </h1>
        </div>

        {/* Interactive Chart: the period selector scopes this chart only */}
        <ChartBarInteractive
          data={chartData}
          period={apiPeriod}
          periodControl={
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-[130px] h-9 shrink-0" aria-label={t.weldconnect.dashboard.periodLabel}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">{t.weldconnect.dashboard.periods.today}</SelectItem>
                <SelectItem value="weekly">{t.weldconnect.dashboard.periods.weekly}</SelectItem>
                <SelectItem value="monthly">{t.weldconnect.dashboard.periods.monthly}</SelectItem>
                <SelectItem value="yearly">{t.weldconnect.dashboard.periods.yearly}</SelectItem>
              </SelectContent>
            </Select>
          }
        />

        {/* CTA Buttons */}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {actionItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href}>
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
