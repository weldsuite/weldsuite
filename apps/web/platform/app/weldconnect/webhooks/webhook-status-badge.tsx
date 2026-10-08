import { Badge } from '@weldsuite/ui/components/badge';
import { CheckCircle, FileEdit, PauseCircle, XCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import type { WebhookStatus } from './webhook-utils';

const STATUS_STYLES: Record<WebhookStatus, { icon: React.ElementType; className: string }> = {
  active: { icon: CheckCircle, className: 'bg-green-500 text-white hover:bg-green-500' },
  paused: {
    icon: PauseCircle,
    className: 'border-transparent bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400',
  },
  draft: { icon: FileEdit, className: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary' },
  archived: { icon: XCircle, className: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary' },
  disabled: { icon: XCircle, className: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary' },
};

/** Draft / Paused / Active (or Disabled) pill for a webhook, see `deriveWebhookStatus`. */
export function WebhookStatusBadge({ status, className }: Readonly<{ status: WebhookStatus; className?: string }>) {
  const { t } = useI18n();
  const { icon: Icon, className: tone } = STATUS_STYLES[status];
  const label = t.weldconnect.webhooks.statuses[status];
  return (
    <Badge variant="outline" className={cn('text-[11px]', tone, className)}>
      <Icon className="h-3 w-3 mr-1" />
      {label}
    </Badge>
  );
}
