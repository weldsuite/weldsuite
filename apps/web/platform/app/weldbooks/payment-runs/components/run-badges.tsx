import { Banknote, FileText } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { useI18n } from '@/lib/i18n/provider';
import type { CheckStatus, RunMethod, RunStatus } from '@/lib/api/domains/weldbooks-payment-runs';
import { RowChip, StatusChip, type ChipTone } from '@/components/accounting/weldbooks-row-cells';
import { statusTone } from '../payment-run-utils';

export function RunStatusBadge({ status }: Readonly<{ status: RunStatus }>) {
  const { t } = useI18n();
  return <Badge variant={statusTone(status)}>{t.weldbooksUs.payments.statuses[status]}</Badge>;
}

export function RunMethodBadge({ method }: Readonly<{ method: RunMethod }>) {
  const { t } = useI18n();
  const Icon = method === 'check' ? FileText : Banknote;
  return (
    <Badge variant="outline">
      <Icon aria-hidden />
      {t.weldbooksUs.payments.methods[method]}
    </Badge>
  );
}

export function CheckStatusBadge({ status }: Readonly<{ status: CheckStatus }>) {
  const { t } = useI18n();
  let variant: 'destructive' | 'success' | 'default' | 'warning' = 'warning';
  if (status === 'voided') variant = 'destructive';
  else if (status === 'cleared') variant = 'success';
  else if (status === 'printed') variant = 'default';
  return <Badge variant={variant}>{t.weldbooksUs.payments.checkStatuses[status]}</Badge>;
}

const RUN_STATUS_TONES: Record<RunStatus, ChipTone> = {
  draft: 'gray',
  pending_approval: 'amber',
  approved: 'blue',
  exported: 'indigo',
  completed: 'green',
  cancelled: 'gray',
};

const CHECK_STATUS_TONES: Record<CheckStatus, ChipTone> = {
  to_print: 'amber',
  printed: 'blue',
  cleared: 'green',
  voided: 'red',
};

/** The status of a run as the coloured chip of the list rows. */
export function RunStatusChip({ status }: Readonly<{ status: RunStatus }>) {
  const { t } = useI18n();
  return <StatusChip tone={RUN_STATUS_TONES[status]}>{t.weldbooksUs.payments.statuses[status]}</StatusChip>;
}

/** The method of a run (ACH or check) as the small chip after its title. */
export function RunMethodChip({ method }: Readonly<{ method: RunMethod }>) {
  const { t } = useI18n();
  const Icon = method === 'check' ? FileText : Banknote;
  return (
    <RowChip tone="gray" icon={<Icon aria-hidden />}>
      {t.weldbooksUs.payments.methods[method]}
    </RowChip>
  );
}

/** The status of a check as the coloured chip of the register rows. */
export function CheckStatusChip({ status }: Readonly<{ status: CheckStatus }>) {
  const { t } = useI18n();
  return <StatusChip tone={CHECK_STATUS_TONES[status]}>{t.weldbooksUs.payments.checkStatuses[status]}</StatusChip>;
}
