import type { PurchaseOrderLine, PurchaseOrderReceipt } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { PackageCheck } from 'lucide-react';
import { getLocale, getTranslations } from '@/lib/i18n';
import { usePurchaseOrderReceipts } from '@/hooks/queries/use-purchasing-queries';
import { formatDate } from '../../lib/numbers';

/** What has arrived on a purchase order, newest receipt first (Kubernetes editions). */
export function ReceiptsTab({ orderId, lines }: Readonly<{ orderId: string; lines: readonly PurchaseOrderLine[] }>) {
  const t = getTranslations('weldstashPurchasing').receipts;
  const locale = getLocale();
  const receipts = usePurchaseOrderReceipts(orderId);
  const lineName = new Map(lines.map((line) => [line.id, line.name]));

  if (receipts.isLoading) return <PageLoader fullScreen={false} />;
  if (receipts.isError) {
    return <ErrorState message={(receipts.error as Error)?.message || t.loadError} onRetry={() => void receipts.refetch()} />;
  }
  const rows: PurchaseOrderReceipt[] = receipts.data ?? [];
  if (rows.length === 0) return <EmptyState icon={PackageCheck} title={t.emptyTitle} description={t.emptyDescription} />;

  return (
    <div className="space-y-4">
      {rows.map((receipt) => (
        <SectionCard
          key={receipt.id}
          title={formatDate(receipt.receivedAt, locale)}
          description={receipt.receivedByName ? t.receivedBy.replace('{name}', receipt.receivedByName) : undefined}
        >
          <ul className="divide-y text-sm">
            {receipt.lines.map((line, index) => (
              <li key={`${line.itemId}-${index}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                <span className="font-medium">{lineName.get(line.itemId) ?? line.itemId}</span>
                <span className="text-muted-foreground tabular-nums">
                  {t.received.replace('{count}', String(line.quantity))}
                  {line.rejected > 0 && ` · ${t.rejected.replace('{count}', String(line.rejected))}`}
                  {line.lotNumber && ` · ${t.lot.replace('{lot}', line.lotNumber)}`}
                  {line.expiryDate && ` · ${t.expires.replace('{date}', formatDate(line.expiryDate, locale))}`}
                </span>
              </li>
            ))}
          </ul>
          {receipt.notes && <p className="mt-3 text-sm text-muted-foreground">{receipt.notes}</p>}
        </SectionCard>
      ))}
    </div>
  );
}
