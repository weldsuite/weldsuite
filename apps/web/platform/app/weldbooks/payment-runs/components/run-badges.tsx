import { Banknote, FileText } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { useI18n } from '@/lib/i18n/provider';
import type { CheckStatus, RunMethod, RunStatus } from '@/lib/api/domains/weldbooks-payment-runs';
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
