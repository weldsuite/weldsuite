
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter, useSearchParams } from '@/lib/router';
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
  AlertCircle,
  Ban,
  Copy,
  Eye,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  isActiveExecutionStatus,
  isCancellableExecutionStatus,
  isWorkflowInactiveError,
  useCancelExecution,
  useInfiniteExecutions,
  useRetryExecution,
  useWorkflows,
  type WorkflowExecution,
} from '@/hooks/queries/use-automation-queries';
import { useEditorWorkspaceMembers } from '@/hooks/use-workflow-editor-data';
import { PageLoader } from '@/components/page-loader';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig, type GroupConfig, type ActiveFilter } from '@/components/entity-list';
import { getTriggerLabel } from '../../trigger-labels';
import {
  formatExecutionDuration,
  getExecutionDuration,
  getStepsProgress,
  isTestExecution,
  normalizeExecutionStatus,
  shortExecutionId,
} from '../execution-utils';
import {
  apiFiltersFromPills,
  apiQueryFromPills,
  executionsHref,
  filtersFromUrl,
  mergeUrlFilters,
  urlFilterKey,
} from '../executions-filters';
import { useNow } from '../use-now';
import { ExecutionStatusBadge } from './execution-status-badge';

interface ExecutionRow {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  triggerType: string;
  triggeredBy: string | null;
  stepsCompleted: number;
  stepsTotal: number;
  storedDuration: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  isTest: boolean;
}

const progressBarColorByStatus: Record<string, string> = {
  failed: 'bg-red-500',
  timeout: 'bg-orange-500',
  completed: 'bg-green-500',
  running: 'bg-blue-500',
  waiting_for_input: 'bg-amber-500',
};

const STATUS_FILTER_VALUES = [
  'running',
  'queued',
  'waiting_for_input',
  'completed',
  'failed',
  'timeout',
  'cancelled',
  'skipped',
] as const;
// MVP triggers plus `manual`, which Test and retry runs use.
const TRIGGER_FILTER_VALUES = [
  'entity_event',
  'schedule',
  'webhook',
  'workflow_complete',
  'manual',
] as const;

// Format date to relative time
function formatRelativeTime(
  date: string | null,
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

function toRow(execution: WorkflowExecution, workflowName: string): ExecutionRow {
  const { completed, total } = getStepsProgress(execution);
  return {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowName,
    status: normalizeExecutionStatus(execution.status),
    triggerType: execution.triggerType || 'manual',
    triggeredBy: execution.triggeredBy,
    stepsCompleted: completed,
    stepsTotal: total,
    storedDuration: execution.duration,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    createdAt: execution.createdAt,
    isTest: isTestExecution(execution),
  };
}

export function ExecutionsClient() {
  const { t, plural } = useI18n();
  const st = useTranslations();

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.connect, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.executions },
  ]);

  const router = useRouter();
  const searchParams = useSearchParams();
  const urlValues = {
    status: searchParams.get('status'),
    workflowId: searchParams.get('workflowId'),
    triggerType: searchParams.get('triggerType'),
  };
  const urlKey = urlFilterKey(urlValues);

  // The pills are the source of truth for the UI (half-built pills must survive
  // between clicks); the URL mirrors the ones the API understands.
  const [filters, setFilters] = useState<ActiveFilter[]>(() => filtersFromUrl(urlValues));
  const syncedUrlKey = useRef(urlKey);
  useEffect(() => {
    if (urlKey === syncedUrlKey.current) return;
    syncedUrlKey.current = urlKey;
    setFilters((current) =>
      mergeUrlFilters(current, filtersFromUrl({
        status: searchParams.get('status'),
        workflowId: searchParams.get('workflowId'),
        triggerType: searchParams.get('triggerType'),
      })),
    );
  }, [urlKey, searchParams]);

  const handleFiltersChange = useCallback((next: ActiveFilter[]) => {
    setFilters(next);
    const href = executionsHref(next);
    syncedUrlKey.current = urlFilterKey(apiFiltersFromPills(next));
    router.replace(href);
  }, [router]);

  const apiFilters = useMemo(() => apiQueryFromPills(filters), [filters]);
  const executionsQuery = useInfiniteExecutions(apiFilters);
  const workflowsQuery = useWorkflows({ limit: 100 });
  const membersQuery = useEditorWorkspaceMembers();
  const {
    data,
    error,
    isLoading,
    isPlaceholderData,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = executionsQuery;

  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    refetch().finally(() => setIsRefreshing(false));
  }, [refetch]);

  const retryExecutionMutation = useRetryExecution();
  const cancelExecutionMutation = useCancelExecution();
  const { mutate: retryExecution } = retryExecutionMutation;
  const { mutate: cancelExecution } = cancelExecutionMutation;

  const handleRetry = useCallback((executionId: string) => {
    retryExecution(executionId, {
      onSuccess: () => {
        toast.success(t.weldconnect.executions.toasts.retried);
      },
      onError: (err) => {
        toast.error(
          isWorkflowInactiveError(err)
            ? t.weldconnect.executions.toasts.workflowInactive
            : t.weldconnect.executions.toasts.retryFailed,
        );
      },
    });
  }, [retryExecution, t]);

  const handleCancel = useCallback((executionId: string) => {
    cancelExecution(executionId, {
      onSuccess: () => {
        toast.success(t.weldconnect.executions.toasts.cancelled);
      },
      onError: () => {
        toast.error(t.weldconnect.executions.toasts.cancelFailed);
      },
    });
  }, [cancelExecution, t]);

  const handleCopyId = useCallback((executionId: string) => {
    navigator.clipboard.writeText(executionId).then(
      () => toast.success(t.weldconnect.executions.idCopied),
      () => undefined,
    );
  }, [t]);

  const workflowNames = useMemo(
    () => new Map((workflowsQuery.data?.data ?? []).map((w) => [w.id, w.name])),
    [workflowsQuery.data],
  );
  const memberNames = useMemo(
    () => new Map((membersQuery.data ?? []).map((member) => [member.id, member.name])),
    [membersQuery.data],
  );

  const loadedExecutions = useMemo(
    () => (data?.pages ?? []).flatMap((page) => page.data),
    [data],
  );
  const totalCount = data?.pages.at(-1)?.pagination?.totalCount ?? loadedExecutions.length;

  const rows = useMemo(() => {
    const unknownWorkflow = t.weldconnect.executionDetail.unknownWorkflow;
    return loadedExecutions.map((execution) =>
      toRow(execution, execution.workflowName ?? workflowNames.get(execution.workflowId) ?? unknownWorkflow),
    );
  }, [loadedExecutions, workflowNames, t]);

  // "is not" pills cannot be sent to the API, so they narrow the loaded rows here.
  const visibleRows = useMemo(() => {
    const exclusions = filters.filter((f) => f.operator === 'is not' && f.value);
    if (exclusions.length === 0) return rows;
    return rows.filter((row) =>
      exclusions.every((f) => row[f.field as 'status' | 'workflowId' | 'triggerType'] !== f.value),
    );
  }, [rows, filters]);

  const hasActiveRuns = visibleRows.some((row) => isActiveExecutionStatus(row.status));
  const now = useNow(hasActiveRuns);

  const workflowNameFallbacks = useMemo(
    () => new Map(rows.map((row) => [row.workflowId, row.workflowName])),
    [rows],
  );

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: t.weldconnect.executions.filters.status,
      options: STATUS_FILTER_VALUES.map((value) => ({
        value,
        label: t.weldconnect.executions.statuses[value],
      })),
    },
    {
      field: 'triggerType',
      label: t.weldconnect.executions.filters.trigger,
      options: TRIGGER_FILTER_VALUES.map((value) => ({ value, label: getTriggerLabel(t, value) })),
    },
    {
      field: 'workflowId',
      label: t.weldconnect.executions.filters.workflow,
      searchable: true,
      options: (workflowsQuery.data?.data ?? []).map((w) => ({ value: w.id, label: w.name })),
      getDisplayValue: (value: string) =>
        workflowNames.get(value) ?? workflowNameFallbacks.get(value) ?? value,
    },
  ], [t, workflowsQuery.data, workflowNames, workflowNameFallbacks]);

  // Group configs by status
  const groupConfigs: GroupConfig<ExecutionRow>[] = useMemo(() =>
    (['running', 'queued', 'waiting_for_input', 'failed', 'timeout', 'completed', 'cancelled', 'skipped'] as const).map((status, index) => ({
      id: status,
      label: t.weldconnect.executions.statuses[status],
      sortOrder: index + 1,
      filter: (e: ExecutionRow) => e.status === status,
    })),
  [t]);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'workflow', header: t.weldconnect.executions.columns.workflow, width: 'flex-1 min-w-[200px]' },
    { id: 'status', header: t.weldconnect.executions.columns.status, width: 'w-[120px]' },
    { id: 'trigger', header: t.weldconnect.executions.columns.trigger, width: 'w-[120px]' },
    { id: 'progress', header: t.weldconnect.executions.columns.progress, width: 'w-[140px]' },
    { id: 'duration', header: t.weldconnect.executions.columns.duration, width: 'w-[100px]' },
    { id: 'started', header: t.weldconnect.executions.columns.started, width: 'w-[120px]' },
  ], [t]);

  // Render row: a stacked card below md, the table row from md up
  const renderRow = useCallback((execution: ExecutionRow) => {
    const progress =
      execution.stepsTotal > 0
        ? (execution.stepsCompleted / execution.stepsTotal) * 100
        : 0;
    const duration = getExecutionDuration(
      {
        status: execution.status,
        duration: execution.storedDuration,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
      },
      now,
    );
    const isManual = execution.triggerType === 'manual';
    const triggeredByName = isManual && execution.triggeredBy
      ? memberNames.get(execution.triggeredBy)
      : undefined;
    // The retry endpoint only accepts failed runs.
    const canRetry = execution.status === 'failed';
    const canCancel = isCancellableExecutionStatus(execution.status);
    const openDetails = () => router.push(`/weldconnect/executions/${execution.id}`);

    return (
      <div
        key={execution.id}
        role="link"
        tabIndex={0}
        onClick={openDetails}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) {
            openDetails();
          }
        }}
        className="flex flex-wrap items-start md:flex-nowrap md:items-center gap-x-4 gap-y-2 px-3 md:px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        {/* Workflow */}
        <div className="order-1 flex-1 min-w-0 md:min-w-[200px]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-foreground truncate">{execution.workflowName}</span>
            {execution.isTest && (
              <Badge variant="outline" className="shrink-0 rounded-md px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
                {t.weldconnect.executions.testBadge}
              </Badge>
            )}
          </div>
          <span className="text-xs text-gray-500 font-mono" title={execution.id}>{shortExecutionId(execution.id)}</span>
        </div>

        {/* Actions */}
        <div className="order-2 md:order-7 w-[40px] shrink-0 flex justify-end" role="presentation" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t.weldconnect.executions.rowActions}
                className="h-7 w-7 p-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
              >
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={openDetails}>
                <Eye className="mr-0.5 h-4 w-4" />
                {t.weldconnect.executions.actions.viewDetails}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleCopyId(execution.id)}>
                <Copy className="mr-0.5 h-4 w-4" />
                {t.weldconnect.executions.copyId}
              </DropdownMenuItem>
              {canRetry && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={retryExecutionMutation.isPending}
                    onClick={() => handleRetry(execution.id)}
                  >
                    <RefreshCw className="mr-0.5 h-4 w-4" />
                    {t.weldconnect.executions.actions.retry}
                  </DropdownMenuItem>
                </>
              )}
              {canCancel && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={cancelExecutionMutation.isPending}
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

        {/* Run facts: their own row below md, table cells from md up */}
        <div className="order-3 flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 md:contents">
          {/* Status */}
          <div className="md:order-2 md:w-[120px]">
            <ExecutionStatusBadge status={execution.status} />
          </div>

          {/* Trigger */}
          <div className="md:order-3 md:w-[120px] min-w-0">
            <span className="text-sm text-gray-600 dark:text-muted-foreground">{getTriggerLabel(t, execution.triggerType)}</span>
            {triggeredByName && (
              <span className="text-xs text-gray-500 block truncate">{triggeredByName}</span>
            )}
          </div>

          {/* Progress */}
          <div className="md:order-4 md:w-[140px] flex items-center gap-2">
            <span className="text-sm text-gray-600 dark:text-muted-foreground">
              {execution.stepsCompleted}/{execution.stepsTotal}
            </span>
            <div className="w-16 h-1.5 bg-gray-200 dark:bg-accent rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full transition-all',
                  progressBarColorByStatus[execution.status] ?? 'bg-gray-400'
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Duration */}
          <div className="md:order-5 md:w-[100px]">
            <span className="text-sm font-mono text-gray-600 dark:text-muted-foreground">{formatExecutionDuration(duration)}</span>
          </div>

          {/* Started */}
          <div className="md:order-6 md:w-[120px]">
            <span className="text-sm text-gray-500">
              {formatRelativeTime(execution.startedAt ?? execution.createdAt, t.weldconnect.executions.justNow, st)}
            </span>
          </div>
        </div>
      </div>
    );
  }, [
    router,
    handleRetry,
    handleCancel,
    handleCopyId,
    retryExecutionMutation.isPending,
    cancelExecutionMutation.isPending,
    memberNames,
    now,
    st,
    t,
  ]);

  const hasActiveFilters = filters.some((f) => f.value !== '');
  const getFilterValueLabel = (filter: ActiveFilter) => {
    const config = filterConfigs.find((c) => c.field === filter.field);
    return config?.getDisplayValue?.(filter.value)
      ?? config?.options.find((o) => o.value === filter.value)?.label
      ?? filter.value;
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (error && !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center px-4">
        <AlertCircle className="h-10 w-10 text-destructive" />
        <p className="text-lg font-medium">{t.weldconnect.executions.loadError}</p>
        <p className="text-sm text-muted-foreground">{t.weldconnect.executions.loadErrorDescription}</p>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
          {t.weldconnect.executions.tryAgain}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('transition-opacity', isPlaceholderData && 'opacity-60')} aria-busy={isPlaceholderData}>
      {/* The desktop filter pills are hidden below md, so show the applied filters as chips there */}
      {hasActiveFilters && (
        <div className="md:hidden flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border">
          {filters.map((filter, index) => {
            if (!filter.value) return null;
            const fieldLabel = filterConfigs.find((c) => c.field === filter.field)?.label ?? filter.field;
            const valueLabel = `${filter.operator === 'is not' ? '≠ ' : ''}${getFilterValueLabel(filter)}`;
            return (
              <Badge key={filter.id} variant="secondary" className="gap-1 rounded-md pr-1 max-w-full">
                <span className="truncate">{fieldLabel}: {valueLabel}</span>
                <button
                  type="button"
                  aria-label={`${t.weldconnect.executions.filters.removeFilter}: ${fieldLabel}`}
                  className="rounded-sm p-0.5 hover:bg-background/60"
                  onClick={() => handleFiltersChange(filters.filter((_, i) => i !== index))}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      )}

      <EntityList<ExecutionRow>
        items={visibleRows}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={5}
        activeFilters={filters}
        onFiltersChange={handleFiltersChange}
        renderRow={renderRow}
        searchPlaceholder={t.weldconnect.executions.searchPlaceholder}
        searchFields={['workflowName', 'id']}
        actionButtons={
          <Button
            variant="outline"
            size="sm"
            className="h-8"
            onClick={handleRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={cn('h-4 w-4 mr-1', isRefreshing && 'animate-spin')} />
            {t.weldconnect.executions.refresh}
          </Button>
        }
        emptyState={hasActiveFilters
          ? {
              title: t.weldconnect.executions.noResults,
              description: t.weldconnect.executions.noResultsDescription,
              secondaryAction: {
                label: t.weldconnect.executions.filters.allExecutions,
                onClick: () => handleFiltersChange([]),
              },
            }
          : {
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

      {visibleRows.length > 0 && (
        <div className="flex flex-col items-center gap-2 px-4 py-4">
          <span className="text-xs text-muted-foreground">
            {plural(totalCount, t.weldconnect.executions.showingCount).replace('{shown}', String(loadedExecutions.length))}
          </span>
          {hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {isFetchingNextPage ? t.weldconnect.executions.loadingMore : t.weldconnect.executions.loadMore}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
