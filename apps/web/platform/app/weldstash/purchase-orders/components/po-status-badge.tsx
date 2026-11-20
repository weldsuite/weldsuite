import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getTranslations } from '@/lib/i18n';
import { statusTone } from '../lib/po-actions';

/** The status of a purchase order as a soft badge. An unknown status shows as it is. */
export function PoStatusBadge({ status }: Readonly<{ status: string }>) {
  const t = getTranslations('weldstashPurchasing');
  const labels = t.status as Record<string, string>;
  return <SoftBadge tone={statusTone(status)}>{labels[status] ?? status}</SoftBadge>;
}
