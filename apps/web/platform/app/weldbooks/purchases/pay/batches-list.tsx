/**
 * The SEPA files made so far: each with its status (exported, cancelled, or
 * completed once every bill is paid), its bills as chips, a download and cancel.
 */

import { useState } from 'react';
import { Download, Receipt } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { useCan } from '@weldsuite/permissions/react';
import { RecordLink } from '@/components/object-panel/record-link';
import { useCancelPaymentBatch, usePaymentBatches } from '@/hooks/queries/use-weldbooks-receipts-queries';
import type { BatchStatus, PaymentBatch } from '@/lib/api/domains/weldbooks-receipts';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { downloadBatchFile } from './download-batch-file';
import { batchFileName, batchStatus } from './pay-model';

const STATUS_TONE: Record<BatchStatus, SoftTone> = { exported: 'neutral', cancelled: 'danger', completed: 'success' };

export function BatchCard({ batch }: Readonly<{ batch: PaymentBatch }>) {
  const { t } = useI18n();
  const tb = t.weldbooksReceipts.pay.batches;
  const tp = t.weldbooksReceipts.pay;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const canDownload = useCan('banking:manage');
  const canCancel = useCan('banking:create');
  const cancel = useCancelPaymentBatch();
  const [confirming, setConfirming] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const status = batchStatus(batch);
  const name = batchFileName(batch);

  const download = async () => {
    setDownloading(true);
    try {
      await downloadBatchFile(batch);
    } catch {
      toast.error(tp.downloadFailed);
    } finally {
      setDownloading(false);
    }
  };

  const doCancel = async () => {
    try {
      await cancel.mutateAsync(batch.id);
      setConfirming(false);
    } catch {
      toast.error(tb.cancelFailed);
    }
  };

  return (
    <li data-testid={`batch-${batch.id}`}>
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-0.5">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span className="truncate">{name}</span>
                <SoftBadge tone={STATUS_TONE[status]}>{tb.status[status]}</SoftBadge>
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {tb.summary.replace('{count}', String(batch.paymentCount)).replace('{amount}', formatMoney(batch.totalAmount, 'EUR'))}
                {' · '}
                {tb.executes.replace('{date}', formatDate(batch.executionDate))}
                {batch.bankAccountName ? ` · ${batch.bankAccountName}` : ''}
              </p>
              {status !== 'cancelled' ? (
                <p className="text-xs text-muted-foreground">
                  {tb.paid.replace('{paid}', String(batch.paidBillCount)).replace('{total}', String(batch.billCount))}
                </p>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {canDownload && status !== 'cancelled' ? (
                <Button type="button" variant="outline" size="sm" disabled={downloading} onClick={() => void download()} aria-label={tb.downloadNamed.replace('{name}', name)}>
                  <Download className="h-4 w-4" aria-hidden />
                  {tb.download}
                </Button>
              ) : null}
              {canCancel && status === 'exported' ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                  {tb.cancel}
                </Button>
              ) : null}
            </div>
          </div>

          {batch.bills.length > 0 ? (
            <div className="space-y-1">
              <p className="sr-only">{tb.bills}</p>
              <ul className="flex flex-wrap gap-2">
                {batch.bills.map((bill) => (
                  <li key={bill.billId} className="min-w-0">
                    <RecordLink
                      type="bill"
                      id={bill.billId}
                      icon={Receipt}
                      label={bill.billNumber ?? bill.externalReference ?? tp.colBill}
                      secondary={[bill.contactName, formatMoney(bill.amount, 'EUR')].filter(Boolean).join(' · ')}
                      tone={bill.paid ? 'success' : undefined}
                      statusLabel={bill.paid ? tb.status.completed : undefined}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={tb.cancelTitle}
        description={tb.cancelDescription}
        confirmLabel={tb.cancelConfirm}
        cancelLabel={tb.keep}
        variant="destructive"
        loading={cancel.isPending}
        onConfirm={doCancel}
      />
    </li>
  );
}

type BatchesTexts = ReturnType<typeof useI18n>['t']['weldbooksReceipts']['pay']['batches'];

function BatchesBody({ batches, tb }: Readonly<{ batches: ReturnType<typeof usePaymentBatches>; tb: BatchesTexts }>) {
  if (batches.isError && !batches.data) return <ErrorState message={tb.loadFailed} onRetry={() => void batches.refetch()} />;
  if (!batches.data) return <InlineSpinner />;
  if (batches.data.data.length === 0) return <EmptyText>{tb.empty}</EmptyText>;
  return (
    <ul className="space-y-3">
      {batches.data.data.map((batch) => (
        <BatchCard key={batch.id} batch={batch} />
      ))}
    </ul>
  );
}

export function BatchesList() {
  const { t } = useI18n();
  const tb = t.weldbooksReceipts.pay.batches;
  const batches = usePaymentBatches();

  return (
    <section aria-labelledby="batches-title" className="space-y-3">
      <h2 id="batches-title" className="text-base font-semibold">
        {tb.title}
      </h2>
      <BatchesBody batches={batches} tb={tb} />
    </section>
  );
}
