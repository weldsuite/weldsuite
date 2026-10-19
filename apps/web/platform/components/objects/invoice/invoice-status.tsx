import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { useI18n } from '@/lib/i18n/provider';

/** The coloured status chip of an invoice or credit note, worded like the lists. */
export function InvoiceStatusChip({ status }: Readonly<{ status: string }>) {
  const { t } = useI18n();
  const labels = t.accounting.statusLabels.invoice as Record<string, string>;
  return <StatusChip status={status}>{labels[status] ?? status}</StatusChip>;
}
