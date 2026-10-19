import { AlertCircle, Ban, CheckCircle2, Clock, Hourglass, Loader2, SkipForward, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { normalizeExecutionStatus } from '../execution-utils';
import { StatusChip, type ChipTone } from '../../components/connect-list-row';

const statusConfig: Record<string, { icon: React.ElementType; tone: ChipTone }> = {
  queued: {
    icon: Clock,
    tone: 'gray',
  },
  running: {
    icon: Loader2,
    tone: 'blue',
  },
  // Paused on an approval step until someone decides.
  waiting_for_input: {
    icon: Hourglass,
    tone: 'amber',
  },
  completed: {
    icon: CheckCircle2,
    tone: 'green',
  },
  failed: {
    icon: XCircle,
    tone: 'red',
  },
  cancelled: {
    icon: Ban,
    tone: 'amber',
  },
  timeout: {
    icon: AlertCircle,
    tone: 'red',
  },
  skipped: {
    icon: SkipForward,
    tone: 'gray',
  },
};

interface ExecutionStatusBadgeProps {
  status: string;
  className?: string;
}

/** The run-status chip (task-row style) used by the executions list and the dashboard's recent activity. */
export function ExecutionStatusBadge({ status, className }: Readonly<ExecutionStatusBadgeProps>) {
  const { t } = useI18n();
  const normalized = normalizeExecutionStatus(status);
  const config = statusConfig[normalized] ?? statusConfig.queued;
  const Icon = config.icon;
  const label = (t.weldconnect.executions.statuses as Record<string, string>)[normalized] ?? normalized;

  return (
    <span className={cn('inline-flex', className)}>
      <StatusChip tone={config.tone}>
        <Icon className={cn('h-3 w-3 mr-1', normalized === 'running' && 'animate-spin')} />
        {label}
      </StatusChip>
    </span>
  );
}
