import { useQueries, useQuery } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Clock, History, Loader2, RefreshCw, X, XCircle } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useAppApiClient } from '@/lib/api/use-app-api';
import {
  automationKeys,
  EXECUTION_POLL_INTERVAL_MS,
  WELDCONNECT_API,
  type CursorPaginationMeta,
  type WorkflowExecution,
} from '@/hooks/queries/use-automation-queries';
import { ExecutionStatusBadge } from '@/app/weldconnect/executions/components/execution-status-badge';
import {
  formatExecutionDuration,
  getExecutionDuration,
  isTestExecution,
  normalizeExecutionStatus,
} from '@/app/weldconnect/executions/execution-utils';
import { useNow } from '@/app/weldconnect/executions/use-now';
import { getTriggerLabel } from '@/app/weldconnect/trigger-labels';

const RECENT_RUNS = 20;
// "In progress" includes the moment a run is queued before its first step.
const COUNTED_STATUSES = ['completed', 'failed', 'running,queued'] as const;

type ExecutionsPage = { data: WorkflowExecution[]; pagination: CursorPaginationMeta };

interface RunsPanelProps {
  workflowId: string;
  onClose: () => void;
}

/** The editor's "Executions" tab: this workflow's latest runs and their totals. */
export function RunsPanel({ workflowId, onClose }: Readonly<RunsPanelProps>) {
  const { t, language } = useI18n();
  const tr = t.weldconnect.workflowEditorClient.runHistory;
  const { getClient } = useAppApiClient();
  const listUrl = `${WELDCONNECT_API.executions}?workflowId=${encodeURIComponent(workflowId)}`;

  // Both live under the executions prefix, so starting, cancelling or retrying
  // a run anywhere in the app refreshes this panel too.
  const runsQuery = useQuery({
    queryKey: [...automationKeys.executionsPrefix(), 'editor-runs', workflowId],
    queryFn: async () => {
      const client = await getClient();
      return client.get<ExecutionsPage>(`${listUrl}&limit=${RECENT_RUNS}`);
    },
    refetchOnMount: 'always',
    refetchInterval: (query) =>
      query.state.data?.data.some((run) => ['queued', 'running'].includes(normalizeExecutionStatus(run.status)))
        ? EXECUTION_POLL_INTERVAL_MS
        : false,
  });
  const countQueries = useQueries({
    queries: COUNTED_STATUSES.map((status) => ({
      queryKey: [...automationKeys.executionsPrefix(), 'editor-run-count', workflowId, status],
      queryFn: async () => {
        const client = await getClient();
        const page = await client.get<ExecutionsPage>(`${listUrl}&status=${status}&limit=1`);
        return page.pagination.totalCount;
      },
      refetchOnMount: 'always' as const,
    })),
  });

  const runs = runsQuery.data?.data ?? [];
  const totalRuns = runsQuery.data?.pagination.totalCount ?? runs.length;
  const [completed, failed, running] = countQueries.map((query) => query.data);
  const now = useNow(runs.some((run) => normalizeExecutionStatus(run.status) === 'running'));

  const finishedDurations = runs
    .filter((run) => ['completed', 'failed'].includes(run.status))
    .map((run) => getExecutionDuration(run, now))
    .filter((duration): duration is number => duration != null);
  const averageRuntime = finishedDurations.length
    ? finishedDurations.reduce((sum, duration) => sum + duration, 0) / finishedDurations.length
    : null;

  const refetchAll = () => {
    runsQuery.refetch();
    countQueries.forEach((query) => query.refetch());
  };
  const formatStarted = (run: WorkflowExecution) =>
    new Date(run.startedAt ?? run.createdAt).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
  const count = (value: number | undefined) => (value === undefined ? '–' : String(value));

  const stats = [
    { label: tr.completed, value: count(completed), icon: CheckCircle2, tone: 'text-green-600 dark:text-green-400' },
    { label: tr.failed, value: count(failed), icon: XCircle, tone: 'text-red-600 dark:text-red-400' },
    { label: tr.inProgress, value: count(running), icon: RefreshCw, tone: 'text-muted-foreground' },
    { label: tr.avgRuntime, value: formatExecutionDuration(averageRuntime), icon: Clock, tone: 'text-muted-foreground' },
  ];

  return (
    <>
      <div className="pl-4 py-3 pr-3 border-b flex items-center justify-between">
        <h3 className="font-semibold text-sm">{tr.title}</h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={refetchAll}
            disabled={runsQuery.isFetching}
            aria-label={tr.refresh}
            title={tr.refresh}
          >
            <RefreshCw className={runsQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose} aria-label={tr.close} title={tr.close}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 p-4 border-b">
        {stats.map((stat) => (
          <div key={stat.label} className="p-3 rounded-lg bg-muted/50 border border-border">
            <div className="flex items-center justify-between mb-1">
              <span className="text-lg font-semibold tabular-nums">{stat.value}</span>
              <stat.icon className={`w-4 h-4 ${stat.tone}`} />
            </div>
            <p className="text-xs text-muted-foreground">{stat.label}</p>
          </div>
        ))}
      </div>

      {runsQuery.isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {runsQuery.isError && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-sm text-muted-foreground">{tr.loadFailed}</p>
          <Button variant="outline" size="sm" onClick={refetchAll}>{tr.retry}</Button>
        </div>
      )}

      {runsQuery.isSuccess && runs.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center px-4 text-center">
          <History className="w-8 h-8 text-muted-foreground/60 mb-3" />
          <h4 className="text-base font-semibold mb-1">{tr.noRuns}</h4>
          <p className="text-sm text-muted-foreground">{tr.noRunsYet}</p>
        </div>
      )}

      {runs.length > 0 && (
        <>
          <ScrollArea className="flex-1">
            <ul className="p-2">
              {runs.map((run) => (
                <li key={run.id}>
                  <Link
                    href={`/weldconnect/executions/${run.id}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <ExecutionStatusBadge status={run.status} />
                        {isTestExecution(run) && (
                          <span className="text-[11px] font-medium text-muted-foreground border border-border rounded px-1.5 py-0.5">
                            {tr.testRun}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground truncate">
                        {formatStarted(run)} · {getTriggerLabel(t, run.triggerType)} · {formatExecutionDuration(getExecutionDuration(run, now))}
                      </p>
                      {run.error?.message && (
                        <p className="mt-0.5 text-xs text-red-600 dark:text-red-400 line-clamp-2 break-words">{run.error.message}</p>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </ScrollArea>
          <div className="p-3 border-t">
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link href={`/weldconnect/executions?workflowId=${encodeURIComponent(workflowId)}`}>
                {totalRuns > runs.length ? tr.viewAllCount.replace('{count}', String(totalRuns)) : tr.viewAll}
              </Link>
            </Button>
          </div>
        </>
      )}
    </>
  );
}
