import { AlertTriangle, CheckCircle2, Clock, Unlink, XCircle, type LucideIcon } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import type { BankFeedConnectionStatus } from '@/lib/api/domains/weldbooks-bank-feeds';
import { STATUS_BADGE_VARIANT } from './feed-utils';
import { useFeedTexts } from './feed-texts';

const STATUS_ICON: Record<BankFeedConnectionStatus, LucideIcon> = {
  active: CheckCircle2,
  reauth_required: AlertTriangle,
  expiring: Clock,
  revoked: XCircle,
  disconnected: Unlink,
  error: XCircle,
};

/** Health of a bank connection: one badge per status, color and icon never the only signal. */
export function ConnectionStatusBadge({
  status,
  className,
}: Readonly<{ status: BankFeedConnectionStatus; className?: string }>) {
  const { t } = useFeedTexts();
  const Icon = STATUS_ICON[status];
  return (
    <Badge variant={STATUS_BADGE_VARIANT[status]} data-status={status} className={className}>
      <Icon aria-hidden="true" />
      {t.status[status]}
    </Badge>
  );
}
