/**
 * Status pills for invoices, bills and VAT returns.
 *
 * Colour mapping matches the platform's WeldBooks tables so a document reads
 * the same on both surfaces. `overdue` is derived, not stored — pass the due
 * date and balance and let `InvoiceStatusBadge` work it out (see lib/date).
 */

import React from 'react';
import { Badge } from '@weldsuite/mobile-ui/components/Badge';
import type { BadgeProps } from '@weldsuite/mobile-ui/components/Badge';
import type { BillStatus, InvoiceStatus, VatReturnStatus } from '@/types/accounting';
import { isOverdue } from '@/lib/date';
import { toNumber } from '@/lib/currency';
import { statusLabel, useI18n } from '@/lib/i18n';

type Variant = NonNullable<BadgeProps['variant']>;

const INVOICE_VARIANTS: Record<InvoiceStatus, Variant> = {
  draft: 'secondary',
  sent: 'default',
  viewed: 'default',
  partially_paid: 'warning',
  paid: 'success',
  overdue: 'destructive',
  cancelled: 'outline',
  uncollectible: 'destructive',
};

const BILL_VARIANTS: Record<BillStatus, Variant> = {
  draft: 'secondary',
  pending: 'warning',
  approved: 'default',
  partially_paid: 'warning',
  paid: 'success',
  overdue: 'destructive',
  rejected: 'destructive',
};

const VAT_VARIANTS: Record<VatReturnStatus, Variant> = {
  draft: 'secondary',
  submitted: 'default',
  accepted: 'success',
  rejected: 'destructive',
};

export function InvoiceStatusBadge({
  status,
  dueDate,
  balanceDue,
  size = 'sm',
}: {
  status: InvoiceStatus;
  dueDate?: string;
  balanceDue?: string | number;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  // app-api never returns `overdue`; derive it so the pill matches the platform.
  const derived: InvoiceStatus =
    (status === 'sent' || status === 'viewed' || status === 'partially_paid') &&
    isOverdue(dueDate, toNumber(balanceDue))
      ? 'overdue'
      : status;

  return (
    <Badge
      variant={INVOICE_VARIANTS[derived] ?? 'secondary'}
      size={size}
      label={statusLabel(t, derived)}
    />
  );
}

export function BillStatusBadge({
  status,
  dueDate,
  balanceDue,
  size = 'sm',
}: {
  status: BillStatus;
  dueDate?: string;
  balanceDue?: string | number;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  const derived: BillStatus =
    (status === 'approved' || status === 'partially_paid') &&
    isOverdue(dueDate, toNumber(balanceDue))
      ? 'overdue'
      : status;

  return (
    <Badge
      variant={BILL_VARIANTS[derived] ?? 'secondary'}
      size={size}
      label={statusLabel(t, derived)}
    />
  );
}

export function VatStatusBadge({
  status,
  size = 'sm',
}: {
  status: VatReturnStatus;
  size?: BadgeProps['size'];
}) {
  const { t } = useI18n();
  return (
    <Badge
      variant={VAT_VARIANTS[status] ?? 'secondary'}
      size={size}
      label={statusLabel(t, status)}
    />
  );
}
