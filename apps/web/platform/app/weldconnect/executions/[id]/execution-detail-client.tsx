
import { useState, useMemo } from 'react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter, Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { localeConfig } from '@/lib/i18n/locales';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Separator } from '@weldsuite/ui/components/separator';
import {
  EntityDetailHeader,
  type StatusBadgeConfig,
  type DetailAction,
} from '@/components/entity-overview';
import {
  CheckCircle,
  SquareCheck,
  XCircle,
  Clock,
  AlertCircle,
  RefreshCw,
  Pause,
  Activity,
  Zap,
  Terminal,
  Download,
  ExternalLink,
  ChevronLeft,
  ChevronDown,
  Radio,
  Bot,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  isActiveExecutionStatus,
  isWorkflowInactiveError,
  useCancelExecution,
  useRetryExecution,
  type WorkflowExecution,
} from '@/hooks/queries/use-automation-queries';
import { useExecutionRealtime } from '@/hooks/realtime/use-execution-realtime';
import {
  formatExecutionDuration,
  getExecutionDuration,
  getStepsProgress,
  isTestExecution,
  shortExecutionId,
  type ExecutionErrorInfo,
} from '../execution-utils';
import { useNow } from '../use-now';

export interface ExecutionStepView {
  id: string;
  name: string;
  type: string;
  status: string;
  duration: number | null;
  startedAt: string | null;
  completedAt: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: ExecutionErrorInfo | null;
}

export interface ExecutionLogEntry {
  id?: string;
  level: string;
  message: string;
  timestamp: string;
  stepName?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ExecutionDetailDto extends Omit<WorkflowExecution, 'error'> {
  steps: ExecutionStepView[];
  input: Record<string, unknown> | null;
  error: ExecutionErrorInfo | null;
}

interface ExecutionDetailClientProps {
  execution: ExecutionDetailDto;
  initialLogs: ExecutionLogEntry[];
}

interface DelegationOutput {
  iterations?: Array<{
    toolResults?: Array<{
      toolCallId?: string;
      toolName?: string;
      result?: unknown;
      error?: string;
      durationMs?: number;
    }>;
  }>;
}

interface DelegationResultPayload {
  agentName?: string;
  status?: string;
  finalContent?: string | null;
  iterationCount?: number;
  totalTokensUsed?: number;
  durationMs?: number;
  error?: string | null;
}

const hasEntries = (obj: Record<string, unknown> | null | undefined) =>
  !!obj && Object.keys(obj).length > 0;

const isWarningLevel = (level: string) => level === 'warning' || level === 'warn';

const logLevelClasses = (level: string) => {
  if (level === 'error') return 'bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800';
  if (isWarningLevel(level)) {
    return 'bg-yellow-50 border-yellow-200 dark:bg-yellow-950/30 dark:border-yellow-800';
  }
  return 'bg-gray-50 border-gray-200 dark:bg-secondary dark:border-border';
};

const logLevelBadgeVariant = (level: string) => {
  if (level === 'error') return 'destructive' as const;
  if (isWarningLevel(level)) return 'default' as const;
  return 'secondary' as const;
};

const getStepStatusIcon = (status: string) => {
  switch (status) {
    case 'success':
    case 'completed':
      return <SquareCheck className="h-4 w-4 text-green-500" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'running':
      return <Activity className="h-4 w-4 text-blue-500 animate-pulse" />;
    case 'pending':
    case 'queued':
      return <Clock className="h-4 w-4 text-yellow-500" />;
    case 'cancelled':
    case 'skipped':
      return <Pause className="h-4 w-4 text-gray-500" />;
    default:
      return <AlertCircle className="h-4 w-4 text-gray-500" />;
  }
};

const stepStatusClassConfig: Record<string, { className: string }> = {
  success: { className: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400' },
  completed: { className: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400' },
  failed: { className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400' },
  running: { className: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-400' },
  pending: { className: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-400' },
  queued: { className: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-400' },
  cancelled: { className: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-border dark:bg-background dark:text-muted-foreground' },
  skipped: { className: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-border dark:bg-background dark:text-muted-foreground' },
};

const getStepStatusBadge = (status: string, labels: Record<string, string>) => {
  const cfg = stepStatusClassConfig[status] || { className: 'border-gray-200 bg-gray-50 text-gray-700' };
  const label = labels[status] || status;
  return <Badge variant="outline" className={`${cfg.className} rounded-sm`}>{label}</Badge>;
};

/**
 * An error message that wraps instead of stretching the layout, with any
 * structured details tucked behind a toggle.
 */
function ExecutionErrorBlock({ error, className }: Readonly<{ error: ExecutionErrorInfo; className?: string }>) {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const hasDetails = error.details !== undefined;

  return (
    <div className={className}>
      {error.message && (
        <p className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap [overflow-wrap:anywhere]">{error.message}</p>
      )}
      {hasDetails && (
        <>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 mt-1 text-xs text-red-700 dark:text-red-300"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((open) => !open)}
          >
            {showDetails ? t.weldconnect.executionDetail.hideDetails : t.weldconnect.executionDetail.showDetails}
          </Button>
          {showDetails && (
            <pre className="mt-2 max-h-[240px] overflow-auto rounded-md bg-white/60 dark:bg-black/20 p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
              {typeof error.details === 'string' ? error.details : JSON.stringify(error.details, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Shows sub-agent delegation results within an ai_agent step's detail view.
 * Extracts delegation tool results (delegate_to_*) from the step output.
 */
function DelegationSection({ step, delegationsLabel, iterationsLabel, tokensLabel }: Readonly<{ step: ExecutionStepView | null; delegationsLabel: string; iterationsLabel: (count: number) => string; tokensLabel: (count: number) => string }>) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!step?.output) return null;

  // Delegations are stored in the iterations' toolResults — the step output is
  // arbitrary AI-agent JSON, so its shape is only known defensively.
  const output = step.output as DelegationOutput;
  const iterations = output.iterations || [];
  const delegations: Array<{
    id: string;
    agentName: string;
    status: string;
    finalContent: string | null;
    iterationCount: number;
    totalTokensUsed: number;
    durationMs: number;
    error: string | null;
  }> = [];

  for (const iteration of iterations) {
    for (const tr of iteration.toolResults || []) {
      if (tr.toolName?.startsWith('delegate_to_') && tr.result && typeof tr.result === 'object') {
        const r = tr.result as DelegationResultPayload;
        delegations.push({
          id: tr.toolCallId || `${tr.toolName}-${delegations.length}`,
          agentName: r.agentName || tr.toolName.replace('delegate_to_', '').replace(/_/g, ' '),
          status: r.status || 'unknown',
          finalContent: r.finalContent || null,
          iterationCount: r.iterationCount || 0,
          totalTokensUsed: r.totalTokensUsed || 0,
          durationMs: r.durationMs || tr.durationMs || 0,
          error: r.error || tr.error || null,
        });
      }
    }
  }

  if (delegations.length === 0) return null;

  const statusColors: Record<string, string> = {
    completed: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400',
    escalated: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-400',
    error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400',
    max_iterations: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-400',
  };

  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">{delegationsLabel}</p>
      <div className="space-y-2">
        {delegations.map((d) => {
          const expanded = expandedId === d.id;
          return (
            <div
              key={d.id}
              className="rounded-lg border border-border overflow-hidden"
            >
              <Button
                variant="ghost"
                className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/50 transition-colors"
                onClick={() => setExpandedId(expanded ? null : d.id)}
              >
                <Bot className="w-4 h-4 text-violet-500 shrink-0" />
                <span className="text-sm font-medium flex-1 truncate">{d.agentName}</span>
                <Badge variant="outline" className={`text-xs rounded-sm shrink-0 ${statusColors[d.status] || ''}`}>
                  {d.status}
                </Badge>
                <span className="text-xs text-muted-foreground shrink-0">{formatExecutionDuration(d.durationMs)}</span>
                <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </Button>
              {expanded && (
                <div className="px-3 pb-3 pt-0 space-y-2 border-t border-border">
                  <div className="flex gap-4 text-xs text-muted-foreground pt-2">
                    <span>{iterationsLabel(d.iterationCount)}</span>
                    <span>{tokensLabel(d.totalTokensUsed)}</span>
                  </div>
                  {d.finalContent && (
                    <pre className="bg-gray-50 dark:bg-secondary p-2 rounded text-xs overflow-auto max-h-[150px] whitespace-pre-wrap">
                      {d.finalContent}
                    </pre>
                  )}
                  {d.error && (
                    <div className="bg-red-50 dark:bg-red-950/30 rounded p-2 text-xs text-red-700 dark:text-red-300">
                      {d.error}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ExecutionDetailClient({ execution, initialLogs }: Readonly<ExecutionDetailClientProps>) {
  const { t, language } = useI18n();
  const st = useTranslations();
  const naLabel = st('sweep.weldconnect.executionDetail.notAvailable');
  const dateTimeFormat = useMemo(
    () => new Intl.DateTimeFormat(localeConfig[language].intlLocale, { dateStyle: 'medium', timeStyle: 'medium' }),
    [language],
  );
  const formatDate = (date: string | Date | null | undefined) => {
    if (!date) return naLabel;
    const value = new Date(date);
    return Number.isNaN(value.getTime()) ? naLabel : dateTimeFormat.format(value);
  };

  const workflowName = execution.workflowName || t.weldconnect.executionDetail.unknownWorkflow;
  const idTail = execution.id.slice(-6);

  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.connect, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.executions, href: '/weldconnect/executions' },
    { label: `${workflowName} #${idTail}` },
  ]);

  const router = useRouter();
  const cancelExecutionMutation = useCancelExecution();
  const retryExecutionMutation = useRetryExecution();
  const isPending = cancelExecutionMutation.isPending || retryExecutionMutation.isPending;
  const [activeTab, setActiveTab] = useState('steps');
  const [expandedSteps, setExpandedSteps] = useState<ReadonlySet<string>>(new Set());

  const toggleStep = (stepId: string) => {
    setExpandedSteps((current) => {
      const next = new Set(current);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  };

  // Subscribe to realtime updates via WeldSuite WorkspaceHub
  const isRunning = isActiveExecutionStatus(execution.status);
  const {
    status: realtimeStatus,
    progress: realtimeProgress,
    isLive,
  } = useExecutionRealtime(execution.id, isRunning);

  // Derive status from realtime data while the run is going; a finished run's own status wins
  const liveStatus = isRunning ? (realtimeStatus || execution.status) : execution.status;

  // Format the live progress display
  const liveProgressDisplay = useMemo(() => {
    if (realtimeProgress?.stepName) {
      return st('sweep.weldconnect.executionDetail.stepProgress', {
        current: realtimeProgress.current,
        total: realtimeProgress.total,
        stepName: realtimeProgress.stepName,
      });
    }
    if (isLive) {
      return t.weldconnect.executionDetail.receivingUpdates;
    }
    return '';
  }, [realtimeProgress, isLive, t, st]);

  const handleCancel = () => {
    if (!confirm(t.weldconnect.executionDetail.cancelConfirm)) {
      return;
    }

    cancelExecutionMutation.mutate(execution.id, {
      onSuccess: () => {
        toast.success(t.weldconnect.executionDetail.toasts.cancelled);
      },
      onError: () => {
        toast.error(t.weldconnect.executionDetail.toasts.cancelFailed);
      },
    });
  };

  const handleRetry = () => {
    retryExecutionMutation.mutate(execution.id, {
      onSuccess: (data) => {
        toast.success(t.weldconnect.executionDetail.toasts.retried);
        // The retry is a new execution that already exists (queued), so open it.
        if (data?.data?.id) {
          router.push(`/weldconnect/executions/${data.data.id}`);
        }
      },
      onError: (err) => {
        toast.error(
          isWorkflowInactiveError(err)
            ? t.weldconnect.executionDetail.toasts.workflowInactive
            : t.weldconnect.executionDetail.toasts.retryFailed,
        );
      },
    });
  };

  const isCurrentlyRunning = isActiveExecutionStatus(liveStatus);
  const isFailed = liveStatus === 'failed';
  const emptyOutputMessage = isCurrentlyRunning
    ? t.weldconnect.executionDetail.executionInProgress
    : t.weldconnect.executionDetail.noOutputData;

  const now = useNow(liveStatus === 'running');
  const duration = getExecutionDuration({ ...execution, status: liveStatus }, now);

  // Status badge configuration
  const statusConfig: Record<string, StatusBadgeConfig> = {
    completed: {
      label: t.weldconnect.executionDetail.statuses.completed,
      icon: CheckCircle,
      className: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400',
    },
    success: {
      label: t.weldconnect.executionDetail.statuses.success,
      icon: CheckCircle,
      className: 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400',
    },
    failed: {
      label: t.weldconnect.executionDetail.statuses.failed,
      icon: XCircle,
      className: 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400',
    },
    running: {
      label: t.weldconnect.executionDetail.statuses.running,
      icon: Activity,
      className: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-400',
    },
    pending: {
      label: t.weldconnect.executionDetail.statuses.pending,
      icon: Clock,
      className: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-400',
    },
    queued: {
      label: t.weldconnect.executionDetail.statuses.queued,
      icon: Clock,
      className: 'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-400',
    },
    cancelled: {
      label: t.weldconnect.executionDetail.statuses.cancelled,
      icon: Pause,
      className: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-border dark:bg-background dark:text-muted-foreground',
    },
    timeout: {
      label: t.weldconnect.executionDetail.statuses.timeout,
      icon: AlertCircle,
      className: 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-400',
    },
  };

  // Quick actions
  const quickActions: DetailAction[] = [
    {
      label: t.weldconnect.executionDetail.viewWorkflow,
      icon: ExternalLink,
      variant: 'outline',
      onClick: () => router.push(`/weldconnect/workflows/${execution.workflowId}`),
    },
    {
      label: t.weldconnect.executionDetail.export,
      icon: Download,
      variant: 'outline',
      onClick: () => {
        const data = JSON.stringify(execution, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `execution-${execution.id}.json`;
        link.click();
      },
    },
  ];

  // Primary actions
  const primaryActions: DetailAction[] = [];

  if (isCurrentlyRunning) {
    primaryActions.push({
      label: t.weldconnect.executionDetail.cancelExecution,
      icon: Pause,
      variant: 'destructive',
      onClick: handleCancel,
      disabled: isPending,
    });
  }

  if (isFailed) {
    primaryActions.push({
      label: t.weldconnect.executionDetail.retryExecution,
      icon: RefreshCw,
      variant: 'default',
      onClick: handleRetry,
      disabled: isPending,
    });
  }

  // Stats: step rows when there are any, the run's own counters before they exist
  const stepRows = execution.steps ?? [];
  const progress = getStepsProgress({ ...execution, status: liveStatus });
  const successfulSteps = stepRows.length > 0
    ? stepRows.filter((s) => s.status === 'success' || s.status === 'completed').length
    : progress.completed;
  const totalSteps = stepRows.length > 0 ? stepRows.length : progress.total;

  // Old runs have no logs: hide the tab instead of offering an empty one
  const hasLogs = initialLogs.length > 0;
  const currentTab = activeTab === 'logs' && !hasLogs ? 'steps' : activeTab;

  const tabs: Array<{ id: string; label: string }> = [
    { id: 'steps', label: t.weldconnect.executionDetail.tabs.steps },
    { id: 'input', label: t.weldconnect.executionDetail.tabs.input },
    { id: 'output', label: t.weldconnect.executionDetail.tabs.output },
    ...(hasLogs
      ? [{ id: 'logs', label: t.weldconnect.executionDetail.tabs.logs.replace('{count}', String(initialLogs.length)) }]
      : []),
  ];

  return (
    <>
      {/* Back button and actions: wrap instead of overflowing on narrow screens */}
      <div className="container mx-auto max-w-[1200px] pt-8 flex flex-wrap items-center justify-between gap-2">
        <Link href="/weldconnect/executions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 -ml-3"
          >
            <ChevronLeft className="h-4 w-4 mr-0.5" />
            {t.weldconnect.executionDetail.backToExecutions}
          </Button>
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {quickActions.map((action) => (
            <Button
              key={action.label}
              variant={action.variant || 'outline'}
              size="icon"
              className="h-8 w-8 shadow-none"
              title={action.label}
              aria-label={action.label}
              onClick={action.onClick}
              disabled={action.disabled}
            >
              <action.icon className="h-4 w-4" />
            </Button>
          ))}
          {primaryActions.map((action) => (
            <Button
              key={action.label}
              variant={action.variant || 'default'}
              onClick={action.onClick}
              disabled={action.disabled}
              className="h-8 text-sm px-3 shadow-none flex items-center gap-1.5"
            >
              <action.icon className="h-4 w-4" />
              <span>{action.label}</span>
            </Button>
          ))}
        </div>
      </div>

      <EntityDetailHeader
        entityId={execution.id}
        entityType={t.weldconnect.executionDetail.entityType}
        title={`${workflowName} #${idTail}`}
        subtitle={`${t.weldconnect.executionDetail.workflowLabel} ${workflowName}`}
        badge={(
          <>
            {isTestExecution(execution) && (
              <Badge variant="outline" className="rounded-md text-xs font-medium text-muted-foreground">
                {t.weldconnect.executions.testBadge}
              </Badge>
            )}
            {execution.parentExecutionId && (
              <span className="text-sm text-muted-foreground">
                {t.weldconnect.executionDetail.retryOf}{' '}
                <Link
                  href={`/weldconnect/executions/${execution.parentExecutionId}`}
                  className="font-mono text-primary hover:underline"
                  title={execution.parentExecutionId}
                >
                  {shortExecutionId(execution.parentExecutionId)}
                </Link>
              </span>
            )}
          </>
        )}
        status={{
          value: liveStatus,
          config: statusConfig,
        }}
      >
        {/* Stats Cards */}
        <>
          <div className="bg-white dark:bg-background rounded-md border border-gray-200 dark:border-border p-4">
            <p className="text-xs text-gray-500 dark:text-muted-foreground font-medium">
              {t.weldconnect.executionDetail.startedAt}
            </p>
            <p className="text-base font-semibold mt-1">
              {formatDate(execution.startedAt || execution.createdAt)}
            </p>
          </div>

          <div className="bg-white dark:bg-background rounded-md border border-gray-200 dark:border-border p-4">
            <p className="text-xs text-gray-500 dark:text-muted-foreground font-medium">
              {t.weldconnect.executionDetail.duration}
            </p>
            <p className="text-base font-semibold mt-1">
              {formatExecutionDuration(duration)}
            </p>
          </div>

          <div className="bg-white dark:bg-background rounded-md border border-gray-200 dark:border-border p-4">
            <p className="text-xs text-gray-500 dark:text-muted-foreground font-medium">
              {t.weldconnect.executionDetail.steps}
            </p>
            <p className="text-base font-semibold mt-1">
              {t.weldconnect.executionDetail.stepsCompleted
                .replace('{successful}', String(successfulSteps))
                .replace('{total}', String(totalSteps))}
            </p>
          </div>

          {isLive && (
            <div className="bg-green-50 dark:bg-green-950/30 rounded-md border border-green-200 dark:border-green-800 p-4">
              <p className="text-xs text-green-600 dark:text-green-400 font-medium flex items-center gap-1.5">
                <Radio className="h-3 w-3 animate-pulse" />
                {t.weldconnect.executionDetail.liveUpdates}
              </p>
              <p className="text-base font-semibold mt-1 text-green-700 dark:text-green-300">
                {liveProgressDisplay}
              </p>
            </div>
          )}
        </>
      </EntityDetailHeader>

      <div className="min-h-screen bg-background">
        <div className="container mx-auto pb-6 max-w-[1200px]">
          <Separator className="mb-[30px]" />

          {/* Tabs */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {tabs.map((tab) => (
                <Button
                  key={tab.id}
                  variant={currentTab === tab.id ? 'default' : 'outline'}
                  onClick={() => setActiveTab(tab.id)}
                  className="h-8 text-sm px-3 shadow-none"
                >
                  {tab.label}
                </Button>
              ))}
            </div>

            {/* Error Banner */}
            {execution.error && (
              <div className="mt-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <XCircle className="h-5 w-5 text-red-500 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-red-900 dark:text-red-100">{t.weldconnect.executionDetail.executionFailed}</p>
                    <ExecutionErrorBlock error={execution.error} className="mt-1" />
                  </div>
                </div>
              </div>
            )}

            {/* Tab Content */}
            <div className="mt-4">
              {currentTab === 'steps' && (
                <div className="space-y-3">
                  {stepRows.length > 0 ? (
                    stepRows.map((step, index: number) => {
                      const expanded = expandedSteps.has(step.id);
                      const hasDetails = hasEntries(step.input) || hasEntries(step.output) || !!step.error;
                      return (
                        <div
                          key={step.id}
                          className="bg-white dark:bg-background rounded-md border border-gray-200 dark:border-border"
                        >
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? t.weldconnect.executionDetail.collapseStep : t.weldconnect.executionDetail.expandStep}: ${step.name}`}
                            className="flex w-full items-start justify-between gap-3 p-4 text-left rounded-md cursor-pointer transition-colors hover:bg-gray-50 dark:hover:bg-secondary"
                            onClick={() => toggleStep(step.id)}
                          >
                            <span className="flex min-w-0 items-start gap-3">
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-100 dark:bg-secondary text-sm font-medium">
                                {index + 1}
                              </span>
                              <span className="block min-w-0">
                                <span className="flex flex-wrap items-center gap-2">
                                  {getStepStatusIcon(step.status)}
                                  <span className="font-medium [overflow-wrap:anywhere]">{step.name}</span>
                                  {getStepStatusBadge(step.status, t.weldconnect.executionDetail.stepStatuses)}
                                </span>
                                <span className="block text-xs text-muted-foreground mt-1">
                                  {t.weldconnect.executionDetail.stepType} <Badge variant="outline" className="text-xs ml-1 rounded-sm">{step.type}</Badge>
                                </span>
                                {step.error && !expanded && (
                                  <span className="mt-2 block text-sm text-red-700 dark:text-red-300 line-clamp-2 [overflow-wrap:anywhere]" title={step.error.message}>
                                    {step.error.message}
                                  </span>
                                )}
                              </span>
                            </span>
                            <span className="flex shrink-0 items-start gap-2">
                              <span className="block text-right text-sm text-muted-foreground">
                                <span className="block font-medium">{formatExecutionDuration(step.duration)}</span>
                                {step.startedAt && (
                                  <span className="hidden sm:block text-xs">{formatDate(step.startedAt)}</span>
                                )}
                              </span>
                              <ChevronDown className={`mt-0.5 h-4 w-4 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
                            </span>
                          </button>

                          {expanded && (
                            <div className="space-y-4 border-t border-gray-200 dark:border-border p-4">
                              {hasEntries(step.input) && (
                                <div>
                                  <p className="text-xs text-muted-foreground mb-2">{t.weldconnect.executionDetail.stepInput}</p>
                                  <pre className="bg-gray-50 dark:bg-secondary p-3 rounded-md text-xs overflow-auto max-h-[240px]">
                                    {JSON.stringify(step.input, null, 2)}
                                  </pre>
                                </div>
                              )}
                              {hasEntries(step.output) && (
                                <div>
                                  <p className="text-xs text-muted-foreground mb-2">{t.weldconnect.executionDetail.stepOutput}</p>
                                  <pre className="bg-gray-50 dark:bg-secondary p-3 rounded-md text-xs overflow-auto max-h-[240px]">
                                    {JSON.stringify(step.output, null, 2)}
                                  </pre>
                                </div>
                              )}
                              <DelegationSection
                                step={step}
                                delegationsLabel={t.weldconnect.executionDetail.delegations}
                                iterationsLabel={(count) => t.weldconnect.executionDetail.iterations.replace('{count}', String(count))}
                                tokensLabel={(count) => t.weldconnect.executionDetail.tokens.replace('{count}', String(count))}
                              />
                              {step.error && (
                                <div className="bg-red-50 dark:bg-red-950/30 rounded-md p-3 border border-red-200 dark:border-red-800">
                                  <p className="text-xs text-muted-foreground mb-1">{t.weldconnect.executionDetail.stepError}</p>
                                  <ExecutionErrorBlock error={step.error} />
                                </div>
                              )}
                              {!hasDetails && (
                                <p className="text-sm text-muted-foreground">{t.weldconnect.executionDetail.noInputOutputData}</p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div className="bg-white dark:bg-background rounded-lg border border-gray-200 dark:border-border p-12 text-center">
                      <Zap className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
                      <p className="text-muted-foreground">{t.weldconnect.executionDetail.noStepsFound}</p>
                    </div>
                  )}
                </div>
              )}

              {currentTab === 'input' && (
                <div className="bg-white dark:bg-background rounded-lg border border-gray-200 dark:border-border p-4">
                  <h3 className="font-semibold text-base mb-4">{t.weldconnect.executionDetail.inputDataTitle}</h3>
                  <p className="text-sm text-muted-foreground mb-4">{t.weldconnect.executionDetail.inputDataDescription}</p>
                  {hasEntries(execution.input) ? (
                    <pre className="bg-gray-50 dark:bg-secondary p-4 rounded-lg text-xs overflow-auto max-h-[600px]">
                      {JSON.stringify(execution.input, null, 2)}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">{t.weldconnect.executionDetail.noInputData}</p>
                  )}
                </div>
              )}

              {currentTab === 'output' && (
                <div className="bg-white dark:bg-background rounded-lg border border-gray-200 dark:border-border p-4">
                  <h3 className="font-semibold text-base mb-4">{t.weldconnect.executionDetail.outputDataTitle}</h3>
                  <p className="text-sm text-muted-foreground mb-4">{t.weldconnect.executionDetail.outputDataDescription}</p>
                  {hasEntries(execution.output) ? (
                    <pre className="bg-gray-50 dark:bg-secondary p-4 rounded-lg text-xs overflow-auto max-h-[600px]">
                      {JSON.stringify(execution.output, null, 2)}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {emptyOutputMessage}
                    </p>
                  )}
                </div>
              )}

              {currentTab === 'logs' && (
                <div className="bg-white dark:bg-background rounded-lg border border-gray-200 dark:border-border p-4">
                  <h3 className="font-semibold text-base mb-4">{t.weldconnect.executionDetail.executionLogsTitle}</h3>
                  <p className="text-sm text-muted-foreground mb-4">{t.weldconnect.executionDetail.executionLogsDescription}</p>
                  {initialLogs.length > 0 ? (
                    <div className="space-y-2 max-h-[600px] overflow-auto">
                      {initialLogs.map((log, index: number) => (
                        <div
                          key={log.id || index}
                          className={`p-3 rounded-lg border ${logLevelClasses(log.level)}`}
                        >
                          <div className="flex items-start gap-3">
                            <Badge
                              variant={logLevelBadgeVariant(log.level)}
                              className="text-xs"
                            >
                              {log.level}
                            </Badge>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-mono break-all">{log.message}</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {formatDate(log.timestamp)}
                                {log.stepName && <span className="ml-2">{st('sweep.weldconnect.executionDetail.logStepLabel', { stepName: log.stepName })}</span>}
                              </p>
                              {log.metadata && Object.keys(log.metadata).length > 0 && (
                                <pre className="text-xs mt-2 bg-white/50 dark:bg-black/20 p-2 rounded overflow-auto">
                                  {JSON.stringify(log.metadata, null, 2)}
                                </pre>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-12">
                      <Terminal className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
                      <p className="text-muted-foreground">{t.weldconnect.executionDetail.noLogsAvailable}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
