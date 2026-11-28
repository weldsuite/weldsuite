/**
 * "Payment pending": a bill that is in an exported SEPA file and has no bank
 * line yet. It is derived (the bill keeps its status), so the chip overlays the
 * pending set (`GET /payment-batches/pending-bills`). Nothing is drawn where the
 * edition has no SEPA files or the bill is not pending.
 */

import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { usePendingBillMap } from '@/hooks/queries/use-weldbooks-receipts-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** A bill that is already paid, void or rejected has nothing pending, whatever the batch says. */
const SETTLED: ReadonlySet<string> = new Set(['paid', 'void', 'cancelled', 'rejected']);

export function PaymentPendingChip({ billId, status }: Readonly<{ billId: string; status?: string | null }>) {
  const { t } = useI18n();
  const pending = usePendingBillMap().get(billId);
  const { formatDate } = useWeldbooksFormat();
  if (!pending || (status && SETTLED.has(status))) return null;
  return (
    <span title={t.weldbooksReceipts.pending.hint.replace('{date}', formatDate(pending.executionDate))} data-testid="payment-pending-chip">
      <StatusChip tone="amber">{t.weldbooksReceipts.pending.chip}</StatusChip>
    </span>
  );
}
