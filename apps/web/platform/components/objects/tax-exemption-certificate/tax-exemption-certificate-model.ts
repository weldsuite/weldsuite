import type { ChipTone } from '@/components/accounting/weldbooks-row-cells';
import type { CertificateStatus } from '@/lib/api/domains/weldbooks-sales-tax-setup';

/** The tone of a certificate's status chip: a lapsed one is red, a revoked one grey. */
export const CERTIFICATE_STATUS_TONE: Record<CertificateStatus, ChipTone> = {
  valid: 'green',
  pending: 'amber',
  expired: 'red',
  revoked: 'gray',
};
