/**
 * The header of the invoice panel: the title with its status, the edit and
 * "more" actions (copy link, download PDF, record payment, send, credit note,
 * write-off, cancel), and the row of workflow buttons under the title
 * (finalize, apply credit).
 */

import { Link } from '@tanstack/react-router';
import {
  Ban,
  Banknote,
  Download,
  EllipsisVertical,
  FileMinus,
  HandCoins,
  Link as LinkIcon,
  Pencil,
  ReceiptText,
  SendHorizontal,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { PanelAvatar, useCopyPanelLink } from '@/components/objects/_shared/record-panel-parts';
import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import type { InvoiceCapabilities } from './invoice-capabilities';
import { InvoiceStatusChip } from './invoice-status';
import type { InvoiceStatusDialog } from './use-invoice-workflow';

export function InvoiceAvatar({ isCreditMemo }: Readonly<{ isCreditMemo?: boolean }>) {
  return (
    <PanelAvatar
      icon={isCreditMemo ? FileMinus : ReceiptText}
      className="bg-emerald-100 text-emerald-600 dark:bg-emerald-900 dark:text-emerald-400"
    />
  );
}

export function InvoiceTitle({ invoice }: Readonly<{ invoice?: InvoiceWithTax }>) {
  const { t } = useI18n();
  const { labels } = useJurisdictionLabels();
  if (!invoice) return <div className="h-4 w-32 animate-pulse rounded bg-muted" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate text-[15px] font-medium text-foreground">
        {invoice.invoiceNumber ?? t.accounting.statusLabels.invoice.fallback}
      </span>
      <span className="flex-shrink-0">
        <InvoiceStatusChip status={invoice.status} />
      </span>
      {invoice.type === 'credit_note' ? (
        <span className="flex-shrink-0">
          <StatusChip tone="purple">{labels.creditNote}</StatusChip>
        </span>
      ) : null}
    </div>
  );
}

export function InvoiceHeaderActions({
  invoice,
  caps,
  creatingCreditMemo,
  downloading,
  onCreateCreditMemo,
  onDownload,
  onRecordPayment,
  onSend,
  onStatusDialog,
}: Readonly<{
  invoice?: InvoiceWithTax;
  caps?: InvoiceCapabilities;
  creatingCreditMemo: boolean;
  downloading: boolean;
  onCreateCreditMemo: () => void;
  onDownload: () => void;
  onRecordPayment: () => void;
  onSend: () => void;
  onStatusDialog: (status: Exclude<InvoiceStatusDialog, null>) => void;
}>) {
  const { t } = useI18n();
  const st = useTranslations();
  const ti = t.accounting.invoiceDetail;
  const { labels } = useJurisdictionLabels();
  const copyLink = useCopyPanelLink('/weldbooks/invoices', 'invoice', invoice?.id ?? '');
  if (!invoice || !caps) return null;
  const hasStateActions = caps.canCreateCreditMemo || caps.canWriteOff || caps.canCancel;

  return (
    <div className="flex items-center gap-0.5">
      {caps.isDraft ? (
        <Button
          asChild
          variant="ghost"
          size="icon-sm"
          className="size-7"
        >
          <Link
            to="/weldbooks/invoices/$id/edit"
            params={{ id: invoice.id }}
            title={ti.edit}
            aria-label={ti.edit}
          >
            <Pencil className="h-4 w-4 text-muted-foreground" />
          </Link>
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
            aria-label={ti.moreActions}
          >
            <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void copyLink()}>
            <LinkIcon />
            {st('sweep.entities.copyLink')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDownload} disabled={downloading}>
            <Download />
            {downloading ? ti.generatingPdf : ti.downloadPdf}
          </DropdownMenuItem>
          {caps.canRecordPayment || caps.canSend ? <DropdownMenuSeparator /> : null}
          {caps.canRecordPayment ? (
            <DropdownMenuItem onClick={onRecordPayment}>
              <Banknote />
              {recordPaymentLabel(ti, invoice, caps.isCreditMemo)}
            </DropdownMenuItem>
          ) : null}
          {caps.canSend ? (
            <DropdownMenuItem onClick={onSend}>
              <SendHorizontal />
              {ti.send}
            </DropdownMenuItem>
          ) : null}
          {hasStateActions ? <DropdownMenuSeparator /> : null}
          {caps.canCreateCreditMemo ? (
            <DropdownMenuItem onClick={onCreateCreditMemo} disabled={creatingCreditMemo}>
              <FileMinus />
              {t.weldbooksUs.salesTax.documents.detail.createCreditMemo.replace(
                '{name}',
                labels.creditNote.toLowerCase(),
              )}
            </DropdownMenuItem>
          ) : null}
          {caps.canWriteOff ? (
            <DropdownMenuItem onClick={() => onStatusDialog('uncollectible')}>
              <HandCoins />
              {ti.markUncollectible}
            </DropdownMenuItem>
          ) : null}
          {caps.canCancel ? (
            <DropdownMenuItem variant="destructive" onClick={() => onStatusDialog('cancelled')}>
              <Ban />
              {ti.cancelInvoice}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The label of the main "record payment" button: a credit note is refunded, a written-off invoice recovered. */
export function recordPaymentLabel(
  ti: ReturnType<typeof useI18n>['t']['accounting']['invoiceDetail'],
  invoice: Pick<InvoiceWithTax, 'status'>,
  isCreditMemo: boolean,
): string {
  if (isCreditMemo) return ti.recordRefund;
  return invoice.status === 'uncollectible' ? ti.recordRecovery : ti.recordPayment;
}

/** The workflow buttons the invoice's status and the member's permissions allow (send and record payment sit in the menu). */
export function InvoiceActionBar({
  caps,
  finalizing,
  applyingCredit,
  onFinalize,
  onApplyCredit,
}: Readonly<{
  caps: InvoiceCapabilities;
  finalizing: boolean;
  applyingCredit: boolean;
  onFinalize: () => void;
  onApplyCredit: () => void;
}>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  // Nothing to do from a finalized invoice: no empty bar under the title.
  if (!caps.isDraft && !caps.canApplyCredit) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-1">
      {caps.isDraft ? (
        <Button variant="outline" size="sm" onClick={onFinalize} disabled={finalizing}>
          {finalizing ? ti.finalizing : ti.finalize}
        </Button>
      ) : null}
      {caps.canApplyCredit ? (
        <Button variant="outline" size="sm" onClick={onApplyCredit} disabled={applyingCredit}>
          {applyingCredit ? ti.applyingCredit : ti.applyCredit}
        </Button>
      ) : null}
    </div>
  );
}
