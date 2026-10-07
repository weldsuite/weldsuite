import { Badge } from '@weldsuite/ui/components/badge';
import { AlertCircle, Ban, CheckCircle2, Clock, Loader2, SkipForward, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { normalizeExecutionStatus } from '../execution-utils';

const statusConfig: Record<string, { icon: React.ElementType; className: string }> = {
  queued: {
    icon: Clock,
    className: 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground',
  },
  running: {
    icon: Loader2,
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
  timeout: {
    icon: AlertCircle,
    className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
  },
  skipped: {
    icon: SkipForward,
    className: 'bg-gray-100 text-gray-800 dark:bg-secondary dark:text-muted-foreground',
  },
};

interface ExecutionStatusBadgeProps {
  status: string;
  className?: string;
}

/** The run-status pill used by the executions list and the dashboard's recent activity. */
export function ExecutionStatusBadge({ status, className }: Readonly<ExecutionStatusBadgeProps>) {
  const { t } = useI18n();
  const normalized = normalizeExecutionStatus(status);
  const config = statusConfig[normalized] ?? statusConfig.queued;
  const Icon = config.icon;
  const label = (t.weldconnect.executions.statuses as Record<string, string>)[normalized] ?? normalized;

  return (
    <Badge
      variant="outline"
      className={cn('text-xs font-medium rounded-md border-transparent inline-flex items-center', config.className, className)}
    >
      <Icon className={cn('h-3 w-3 mr-1', normalized === 'running' && 'animate-spin')} />
      {label}
    </Badge>
  );
}
