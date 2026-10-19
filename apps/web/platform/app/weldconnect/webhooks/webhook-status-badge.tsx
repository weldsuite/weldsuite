import { CheckCircle, FileEdit, PauseCircle, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { WebhookStatus } from './webhook-utils';
import { StatusChip, type ChipTone } from '../components/connect-list-row';

const STATUS_STYLES: Record<WebhookStatus, { icon: React.ElementType; tone: ChipTone }> = {
  active: { icon: CheckCircle, tone: 'green' },
  paused: { icon: PauseCircle, tone: 'amber' },
  draft: { icon: FileEdit, tone: 'gray' },
  archived: { icon: XCircle, tone: 'gray' },
  disabled: { icon: XCircle, tone: 'gray' },
};

/** Draft / Paused / Active (or Disabled) pill for a webhook, see `deriveWebhookStatus`. */
export function WebhookStatusBadge({ status, className }: Readonly<{ status: WebhookStatus; className?: string }>) {
  const { t } = useI18n();
  const { icon: Icon, tone } = STATUS_STYLES[status];
  const label = t.weldconnect.webhooks.statuses[status];
  return (
    <span className={cn('inline-flex', className)}>
      <StatusChip tone={tone}>
        <Icon className="h-3 w-3 mr-1" />
        {label}
      </StatusChip>
    </span>
  );
}
