import { Badge } from '@weldsuite/ui/components/badge';
import type { SignEnvelopeStatus } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning';

const VARIANT: Record<SignEnvelopeStatus, BadgeVariant> = {
  draft: 'secondary',
  sent: 'default',
  in_progress: 'warning',
  completed: 'success',
  declined: 'destructive',
  voided: 'outline',
  expired: 'outline',
};

export function EnvelopeStatusBadge({ status }: Readonly<{ status: SignEnvelopeStatus }>) {
  const { t } = useI18n();
  return <Badge variant={VARIANT[status]}>{t.weldsign.status[status]}</Badge>;
}
