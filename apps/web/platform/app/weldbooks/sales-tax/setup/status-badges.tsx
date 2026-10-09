import { Badge } from '@weldsuite/ui/components/badge';
import type { AgencyStatus, CertificateStatus } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useSetupTexts } from './setup-texts';

const AGENCY_VARIANT: Record<AgencyStatus, 'success' | 'warning' | 'secondary' | 'outline'> = {
  registered: 'success',
  pending: 'warning',
  monitoring: 'secondary',
  closed: 'outline',
};

export function AgencyStatusBadge({ status }: Readonly<{ status: AgencyStatus }>) {
  const { t } = useSetupTexts();
  return <Badge variant={AGENCY_VARIANT[status] ?? 'outline'}>{t.statuses[status] ?? status}</Badge>;
}

const CERTIFICATE_VARIANT: Record<CertificateStatus, 'success' | 'warning' | 'destructive' | 'outline'> = {
  valid: 'success',
  pending: 'warning',
  expired: 'destructive',
  revoked: 'outline',
};

export function CertificateStatusBadge({ status }: Readonly<{ status: CertificateStatus }>) {
  const { t } = useSetupTexts();
  return <Badge variant={CERTIFICATE_VARIANT[status] ?? 'outline'}>{t.certificates.statuses[status] ?? status}</Badge>;
}
