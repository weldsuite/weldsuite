import { Badge } from '@weldsuite/ui/components/badge';
import type { PartnerStatementStatus, PartnerStatus, WorkspaceLicenceStatus } from '@weldsuite/app-api-client/schemas/partners';
import { partnersCopy } from '@/lib/partners-copy';

export function PartnerStatusBadge({ status }: Readonly<{ status: PartnerStatus }>) {
  const t = partnersCopy();
  const variant = status === 'active' ? 'success' : status === 'past_due' ? 'warning' : 'destructive';
  return <Badge variant={variant}>{t.status[status] ?? status}</Badge>;
}

export function LicenceStatusBadge({ status }: Readonly<{ status: WorkspaceLicenceStatus }>) {
  const t = partnersCopy();
  const variant = status === 'active' ? 'success' : status === 'suspended' ? 'warning' : 'secondary';
  return <Badge variant={variant}>{t.licenceStatus[status] ?? status}</Badge>;
}

export function StatementStatusBadge({ status }: Readonly<{ status: PartnerStatementStatus | 'preview' }>) {
  const t = partnersCopy();
  const variant =
    status === 'paid' ? 'success' : status === 'invoiced' ? 'warning' : status === 'void' ? 'secondary' : 'outline';
  return <Badge variant={variant}>{t.statementStatus[status] ?? status}</Badge>;
}
