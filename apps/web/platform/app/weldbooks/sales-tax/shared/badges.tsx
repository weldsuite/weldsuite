import { Badge } from '@weldsuite/ui/components/badge';
import { useI18n } from '@/lib/i18n/provider';
import type { PeriodState } from '@/lib/api/domains/weldbooks-sales-tax-center';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

const PERIOD_STATE_VARIANT: Record<PeriodState, BadgeVariant> = {
  upcoming: 'outline',
  in_progress: 'secondary',
  due: 'warning',
  overdue: 'destructive',
  filed: 'success',
  paid: 'success',
};

const RETURN_STATUS_VARIANT: Record<string, BadgeVariant> = {
  open: 'outline',
  calculated: 'secondary',
  reviewed: 'secondary',
  filed: 'success',
  paid: 'success',
};

/** The state of a filing period: upcoming, in progress, due, overdue, filed or paid. */
export function PeriodStateBadge({ state }: Readonly<{ state: PeriodState }>) {
  const { t } = useI18n();
  const labels = t.weldbooksUs.salesTax.center.periodStates;
  return <Badge variant={PERIOD_STATE_VARIANT[state] ?? 'outline'}>{labels[state] ?? state}</Badge>;
}

/** The status of a return: open, calculated, reviewed, filed or paid. */
export function ReturnStatusBadge({ status }: Readonly<{ status: string }>) {
  const { t } = useI18n();
  const labels = t.weldbooksUs.salesTax.center.returnStatuses as Record<string, string>;
  return <Badge variant={RETURN_STATUS_VARIANT[status] ?? 'outline'}>{labels[status] ?? status}</Badge>;
}
