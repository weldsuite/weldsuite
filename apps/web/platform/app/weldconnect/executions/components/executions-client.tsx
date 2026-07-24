
import { useState, useMemo, useCallback } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  EllipsisVertical,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  RefreshCw,

  Eye,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { useRetryExecution, useCancelExecution } from '@/hooks/queries/use-automation-queries';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter } from '@/components/entity-list';

interface Execution {
  id: string;
  workflowId: string;
  workflowName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  triggerType: string;
  triggeredBy?: string;
  stepsCompleted: number;
  stepsTotal: number;
  duration?: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface ExecutionsClientProps {
  initialExecutions: Execution[];
}

// Status badge class configurations (labels are resolved inside the component)
const statusClassConfig: Record<string, { icon: React.ElementType; className: string }> = {
  pending: {
    icon: Clock,
    className: 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground',
  },
  running: {
    icon: Play,
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  },
  completed: {
    icon: CheckCircle2,
    className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  },
  failed: {
    icon: XCircle,
    className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  },
  cancelled: {
    icon: Ban,
    className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400',
  },
};

// Format duration in milliseconds to human-readable format
function formatDuration(ms?: number): string {
  if (!ms) return '—';

  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;

  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  return `${hours}h ${minutes}m`;
}

// Format date to relative time
function formatRelativeTime(
  date: Date | null,
  justNowLabel: string,
  translate: (path: string, params?: Record<string, unknown>) => string,
): string {
  if (!date) return '—';

  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return justNowLabel;
  if (diffMins < 60) return translate('sweep.weldconnect.executionsClient.minutesAgoShort', { count: diffMins });
  if (diffMins < 1440) return translate('sweep.weldconnect.executionsClient.hoursAgoShort', { count: Math.floor(diffMins / 60) });
  return translate('sweep.weldconnect.executionsClient.daysAgoShort', { count: Math.floor(diffMins / 1440) });
}

export function ExecutionsClient({ initialExecutions }: ExecutionsClientProps) {
  const { t } = useI18n();
  const st = useTranslations();

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.executions },
  ]);

  const router = useRouter();
  const [executions, setExecutions] = useState<Execution[]>(initialExecutions);
  const retryExecutionMutation = useRetryExecution();
  const cancelExecutionMutation = useCancelExecution();

  const handleRetry = useCallback((executionId: string) => {
    retryExecutionMutation.mutate(executionId, {
      onSuccess: () => {
        toast.success(t.weldconnect.executions.toasts.retried);
      },
      onError: () => {
        toast.error(t.weldconnect.executions.toasts.retryFailed);
      },
    });
  }, [retryExecutionMutation, t.weldconnect.executions.toasts.retried, t.weldconnect.executions.toasts.retryFailed]);

  const handleCancel = useCallback((executionId: string) => {
    cancelExecutionMutation.mutate(executionId, {
      onSuccess: () => {
        setExecutions((prev) =>
          prev.map((e) => (e.id === executionId ? { ...e, status: 'cancelled' as const } : e))
        );
        toast.success(t.weldconnect.executions.toasts.cancelled);
      },
      onError: () => {
        toast.error(t.weldconnect.executions.toasts.cancelFailed);
      },
    });
  }, [cancelExecutionMutation, t.weldconnect.executions.toasts.cancelled, t.weldconnect.executions.toasts.cancelFailed]);

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: t.weldconnect.executions.filters.status,
      options: [
        { value: 'running', label: t.weldconnect.executions.statuses.running },
        { value: 'completed', label: t.weldconnect.executions.statuses.completed },
        { value: 'failed', label: t.weldconnect.executions.statuses.failed },
        { value: 'pending', label: t.weldconnect.executions.statuses.pending },
        { value: 'cancelled', label: t.weldconnect.executions.statuses.cancelled },
      ],
    },
    {
      field: 'triggerType',
      label: t.weldconnect.executions.filters.trigger,
      options: [
        { value: 'manual', label: t.weldconnect.workflows.triggerTypes.manual },
        { value: 'schedule', label: t.weldconnect.workflows.triggerTypes.schedule },
        { value: 'webhook', label: t.weldconnect.workflows.triggerTypes.webhook },
      ],
    },
  ], [t]);

  // Group configs by status
  const groupConfigs: GroupConfig<Execution>[] = useMemo(() => [
    {
      id: 'running',
      label: t.weldconnect.executions.statuses.running,
      sortOrder: 1,
      filter: (e) => e.status === 'running',
    },
    {
      id: 'pending',
      label: t.weldconnect.executions.statuses.pending,
      sortOrder: 2,
      filter: (e) => e.status === 'pending',
    },
    {
      id: 'failed',
      label: t.weldconnect.executions.statuses.failed,
      sortOrder: 3,
      filter: (e) => e.status === 'failed',
    },
    {
      id: 'completed',
      label: t.weldconnect.executions.statuses.completed,
      sortOrder: 4,
      filter: (e) => e.status === 'completed',
    },
    {
      id: 'cancelled',
      label: t.weldconnect.executions.statuses.cancelled,
      sortOrder: 5,
      filter: (e) => e.status === 'cancelled',
    },
  ], [t]);

  // Apply filters
  const applyFilters = useCallback((items: Execution[], filters: ActiveFilter[]) => {
    let result = items;

    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;

      if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(e => e.status === filter.value)
          : result.filter(e => e.status !== filter.value);
      } else if (filter.field === 'triggerType') {
        result = filter.operator === 'is'
          ? result.filter(e => e.triggerType?.toLowerCase() === filter.value)
          : result.filter(e => e.triggerType?.toLowerCase() !== filter.value);
      }
    });

    return result;
  }, []);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'workflow', header: t.weldconnect.executions.columns.workflow, width: 'flex-1 min-w-[200px]' },
    { id: 'status', header: t.weldconnect.executions.columns.status, width: 'w-[120px]' },
    { id: 'trigger', header: t.weldconnect.executions.columns.trigger, width: 'w-[120px]' },
    { id: 'progress', header: t.weldconnect.executions.columns.progress, width: 'w-[140px]' },
    { id: 'duration', header: t.weldconnect.executions.columns.duration, width: 'w-[100px]' },
    { id: 'started', header: t.weldconnect.executions.columns.started, width: 'w-[120px]' },
  ], [t]);

  // Render status icon
  const renderStatusIcon = (status: string) => {
    const iconClass = cn("h-3 w-3 mr-1", status === 'running' && 'animate-spin');
    switch (status) {
      case 'pending':
        return <Clock className={iconClass} />;
      case 'running':
        return <Play className={iconClass} />;
      case 'completed':
        return <CheckCircle2 className={iconClass} />;
      case 'failed':
        return <XCircle className={iconClass} />;
      case 'cancelled':
        return <Ban className={iconClass} />;
      default:
        return <Clock className={iconClass} />;
    }
  };

  // Render row
  const renderRow = useCallback((execution: Execution) => {
    const config = statusClassConfig[execution.status] || statusClassConfig.pending;
    const statusLabel = (t.weldconnect.executions.statuses as Record<string, string>)[execution.status] || execution.status;
    const progress =
      execution.stepsTotal > 0
        ? (execution.stepsCompleted / execution.stepsTotal) * 100
        : 0;

    return (
      <div
        key={execution.id}
        onClick={() => router.push(`/weldconnect/executions/${execution.id}`)}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        {/* Workflow */}
        <div className="flex-1 min-w-[200px]">
          <span className="text-sm font-medium text-gray-900 dark:text-foreground block">{execution.workflowName}</span>
          <span className="text-xs text-gray-500">ID: {execution.id.slice(0, 8)}...</span>
        </div>

        {/* Status */}
        <div className="w-[120px]">
          <Badge variant="outline" className={cn("text-xs font-medium rounded-md border-transparent inline-flex items-center", config.className)}>
            {renderStatusIcon(execution.status)}
            {statusLabel}
          </Badge>
        </div>

        {/* Trigger */}
        <div className="w-[120px]">
          <span className="text-sm text-gray-600 dark:text-muted-foreground capitalize">{execution.triggerType}</span>
          {execution.triggeredBy && (
            <span className="text-xs text-gray-500 block truncate">{execution.triggeredBy}</span>
          )}
        </div>

        {/* Progress */}
        <div className="w-[140px] flex items-center gap-2">
          <span className="text-sm text-gray-600 dark:text-muted-foreground">
            {execution.stepsCompleted}/{execution.stepsTotal}
          </span>
          <div className="w-16 h-1.5 bg-gray-200 dark:bg-accent rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full transition-all',
                execution.status === 'failed'
                  ? 'bg-red-500'
                  : execution.status === 'completed'
                    ? 'bg-green-500'
                    : execution.status === 'running'
                      ? 'bg-blue-500'
                      : 'bg-gray-400'
              )}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Duration */}
        <div className="w-[100px]">
          <span className="text-sm font-mono text-gray-600 dark:text-muted-foreground">{formatDuration(execution.duration)}</span>
        </div>

        {/* Started */}
        <div className="w-[120px]">
          <span className="text-sm text-gray-500">{formatRelativeTime(execution.startedAt, t.weldconnect.executions.justNow, st)}</span>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => router.push(`/weldconnect/executions/${execution.id}`)}>
                <Eye className="mr-0.5 h-4 w-4" />
                {t.weldconnect.executions.actions.viewDetails}
              </DropdownMenuItem>
              {execution.status === 'failed' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleRetry(execution.id)}>
                    <RefreshCw className="mr-0.5 h-4 w-4" />
                    {t.weldconnect.executions.actions.retry}
                  </DropdownMenuItem>
                </>
              )}
              {execution.status === 'running' && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => handleCancel(execution.id)}
                    className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                  >
                    <Ban className="mr-0.5 h-4 w-4" />
                    {t.weldconnect.executions.actions.cancel}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [
    router,
    handleRetry,
    handleCancel,
    st,
    t.weldconnect.executions.actions.cancel,
    t.weldconnect.executions.actions.retry,
    t.weldconnect.executions.actions.viewDetails,
    t.weldconnect.executions.justNow,
    t.weldconnect.executions.statuses,
  ]);

  return (
    <EntityList<Execution>
      items={executions}
      isLoading={false}
      error={null}
      headerColumns={headerColumns}
      filters={filterConfigs}
      groups={groupConfigs}
      maxFilters={5}
      applyFilters={applyFilters}
      renderRow={renderRow}
      searchPlaceholder={t.weldconnect.executions.searchPlaceholder}
      searchFields={['workflowName', 'id']}
      actionButtons={
        <Button
          variant="outline"
          size="sm"
          className="h-8"
        >
          <RefreshCw className="h-4 w-4 mr-1" />
          {t.weldconnect.executions.refresh}
        </Button>
      }
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              {/* Vertical timeline spine */}
              <line x1="38" y1="24" x2="38" y2="96" className="stroke-gray-200 dark:stroke-border" strokeWidth="1" />

              {/* Node 1 - completed */}
              <circle cx="38" cy="30" r="6" className="fill-white dark:fill-secondary stroke-gray-200 dark:stroke-border" strokeWidth="0.8" />
              <path d="M35 30L37 32.5L41.5 27.5" className="stroke-gray-300 dark:stroke-muted-foreground" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="52" y="28" width="38" height="3" rx="1.5" className="fill-gray-200 dark:fill-border" opacity="0.6" />

              {/* Node 2 - completed */}
              <circle cx="38" cy="56" r="6" className="fill-white dark:fill-secondary stroke-gray-200 dark:stroke-border" strokeWidth="0.8" />
              <path d="M35 56L37 58.5L41.5 53.5" className="stroke-gray-300 dark:stroke-muted-foreground" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="52" y="54" width="30" height="3" rx="1.5" className="fill-gray-200 dark:fill-border" opacity="0.5" />

              {/* Node 3 - empty */}
              <circle cx="38" cy="82" r="6" className="fill-white dark:fill-secondary stroke-gray-200 dark:stroke-border" strokeWidth="0.8" strokeDasharray="2.5 2.5" />
              <rect x="52" y="80" width="24" height="3" rx="1.5" className="fill-gray-200 dark:fill-border" opacity="0.25" />
            </svg>
          </EmptyStateIllustration>
        ),
        title: t.weldconnect.executions.noExecutions,
        description: t.weldconnect.executions.noExecutionsDescription,
      }}
      noResultsState={{
        title: t.weldconnect.executions.noResults,
        description: t.weldconnect.executions.noResultsDescription,
      }}
    />
  );
}
