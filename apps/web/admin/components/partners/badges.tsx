import { Badge } from '@weldsuite/ui/components/badge';
import type { PartnerStatementStatus, PartnerStatus, WorkspaceLicenceStatus } from '@weldsuite/app-api-client/schemas/partners';
import { partnersCopy } from '@/lib/partners-copy';

type BadgeVariant = 'success' | 'warning' | 'destructive' | 'secondary' | 'outline';

const PARTNER_STATUS_VARIANT: Record<PartnerStatus, BadgeVariant> = {
  active: 'success',
  past_due: 'warning',
  suspended: 'destructive',
};

const LICENCE_STATUS_VARIANT: Record<WorkspaceLicenceStatus, BadgeVariant> = {
  active: 'success',
  suspended: 'warning',
  ended: 'secondary',
};

/** Statuses not listed (draft, final) fall back to the outline variant. */
const STATEMENT_STATUS_VARIANT: Partial<Record<PartnerStatementStatus | 'preview', BadgeVariant>> = {
  paid: 'success',
  invoiced: 'warning',
  void: 'secondary',
  preview: 'outline',
};

export function PartnerStatusBadge({ status }: Readonly<{ status: PartnerStatus }>) {
  const t = partnersCopy();
  const variant = PARTNER_STATUS_VARIANT[status] ?? 'destructive';
  return <Badge variant={variant}>{t.status[status] ?? status}</Badge>;
}

export function LicenceStatusBadge({ status }: Readonly<{ status: WorkspaceLicenceStatus }>) {
  const t = partnersCopy();
  const variant = LICENCE_STATUS_VARIANT[status] ?? 'secondary';
  return <Badge variant={variant}>{t.licenceStatus[status] ?? status}</Badge>;
}

export function StatementStatusBadge({ status }: Readonly<{ status: PartnerStatementStatus | 'preview' }>) {
  const t = partnersCopy();
  const variant = STATEMENT_STATUS_VARIANT[status] ?? 'outline';
  return <Badge variant={variant}>{t.statementStatus[status] ?? status}</Badge>;
}
