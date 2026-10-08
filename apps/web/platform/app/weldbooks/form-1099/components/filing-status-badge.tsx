import { Badge } from '@weldsuite/ui/components/badge';
import type { Form1099FilingStatus } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';

const VARIANT: Record<Form1099FilingStatus, 'secondary' | 'warning' | 'success' | 'outline' | 'default'> = {
  draft: 'secondary',
  reviewed: 'outline',
  generated: 'warning',
  filed: 'success',
  corrected: 'warning',
};

export function FilingStatusBadge({ status }: Readonly<{ status: Form1099FilingStatus }>) {
  const { t } = useI18n();
  return <Badge variant={VARIANT[status]}>{t.weldbooksUs.form1099.filingStatus[status]}</Badge>;
}
