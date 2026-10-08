import { useState } from 'react';
import { useParams } from '@/lib/router';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { MoreHorizontal } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  useAccountingEntity,
  useAccountingInvoice,
  useFinalizeInvoice,
  useUpdateInvoiceStatus,
} from '@/hooks/queries/use-accounting-queries';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import {
  generateInvoicePdf,
  downloadPdf,
  type InvoicePdfLabels,
} from '@/lib/weldbooks/invoice-pdf';
import type { InvoiceDetail } from '@/lib/api/domains/weldbooks';
import { RecordPaymentDialog } from '../components/record-payment-dialog';
import { SendInvoiceDialog } from '../components/send-invoice-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { normalizeAccountingAddress } from '@/lib/weldbooks/address';
import { formatPostalAddressLines } from '@/components/address/postal-address';
import { countryName } from '@/components/address/countries';

function getStatusBadge(status: string, labels: Record<string, string>) {
  switch (status) {
    case 'draft':
      return <Badge variant="outline">{labels.draft}</Badge>;
    case 'sent':
      return <Badge variant="secondary">{labels.sent}</Badge>;
    case 'paid':
      return (
        <Badge className="bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900/40 dark:text-green-300">
          {labels.paid}
        </Badge>
      );
    case 'overdue':
      return <Badge variant="destructive">{labels.overdue}</Badge>;
    case 'partial':
      return <Badge variant="secondary">{labels.partial}</Badge>;
    case 'cancelled':
      return <Badge variant="outline">{labels.cancelled}</Badge>;
    case 'finalized':
      return <Badge variant="secondary">{labels.finalized}</Badge>;
    case 'uncollectible':
      return <Badge variant="outline">{labels.uncollectible}</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

/** Statuses after which the invoice can no longer be cancelled or written off. */
const CLOSED_STATUSES = new Set(['cancelled', 'paid', 'uncollectible']);
const OPEN_BALANCE_STATUSES = new Set(['sent', 'partial', 'overdue', 'finalized']);

export default function InvoiceDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { t, language } = useI18n();
  const st = useTranslations();
  const ti = t.accounting.invoiceDetail;
  const tsl = t.accounting.statusLabels.invoice;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { labels } = useJurisdictionLabels();
  const canUpdate = useCan('invoices:update');

  const { data, isLoading } = useAccountingInvoice(id);
  const finalizeMutation = useFinalizeInvoice();
  const statusMutation = useUpdateInvoiceStatus();

  const { entityId } = useCurrentAccountingEntity();
  const { data: entity } = useAccountingEntity(entityId);

  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [statusDialog, setStatusDialog] = useState<'cancelled' | 'uncollectible' | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [openingAttachment, setOpeningAttachment] = useState<number | null>(null);

  const country = (code: string) => countryName(code, language || 'en');

  const pdfLabels = (): InvoicePdfLabels => {
    const tp = t.accounting.invoicePdf;
    return {
      ...tp,
      tax: labels.tax,
      taxId: labels.taxId,
      registrationId: labels.registrationId,
    };
  };

  const handleDownload = async () => {
    if (!data?.data) return;
    setDownloading(true);
    try {
      const bytes = await generateInvoicePdf(
        data.data as InvoiceDetail,
        entity ?? { name: st('sweep.weldbooks.invoiceDetail.yourCompanyFallback') },
        { labels: pdfLabels(), formatDate: (v) => formatDate(v, '-'), countryName: country },
      );
      const filename = ((data.data as InvoiceDetail).invoiceNumber || 'invoice') + '.pdf';
      downloadPdf(bytes, filename);
    } catch {
      toast.error(ti.failedToPdf);
    } finally {
      setDownloading(false);
    }
  };

  const handleOpenAttachment = async (index: number, fallbackName: string) => {
    setOpeningAttachment(index);
    try {
      const { blob, filename } = await accountingApi.getInvoiceAttachment(id, index);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = filename || fallbackName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(ti.failedToOpenAttachment);
    } finally {
      setOpeningAttachment(null);
    }
  };

  if (isLoading) return <PageLoader fullScreen={false} />;

  const invoice = data?.data as InvoiceDetail | undefined;

  if (!invoice) {
    return (
      <div className="flex items-center justify-center p-8">{ti.invoiceNotFound}</div>
    );
  }

  const isDraft = invoice.status === 'draft';
  const canSend = isDraft || invoice.status === 'finalized';
  const canRecordPayment =
    invoice.status === 'sent' ||
    invoice.status === 'partial' ||
    invoice.status === 'overdue';
  const canCancel = canUpdate && !CLOSED_STATUSES.has(invoice.status);
  const canWriteOff =
    canUpdate && OPEN_BALANCE_STATUSES.has(invoice.status) && Number(invoice.balanceDue ?? 0) > 0;

  const handleFinalize = () => {
    finalizeMutation.mutate(invoice.id, {
      onSuccess: () => toast.success(ti.finalized),
      onError: (err) => toast.error(ti.finalizeFailed, { description: err instanceof Error ? err.message : undefined }),
    });
  };

  const handleStatusChange = async () => {
    if (!statusDialog) return;
    try {
      await statusMutation.mutateAsync({ id: invoice.id, status: statusDialog });
      toast.success(ti.statusUpdated);
      setStatusDialog(null);
    } catch (err) {
      // The server explains why, e.g. a finalized invoice needs a credit note.
      toast.error(ti.statusUpdateFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const billingLines = formatPostalAddressLines(normalizeAccountingAddress(invoice.billingAddress), {
    countryName: country,
  });
  const shippingLines = formatPostalAddressLines(normalizeAccountingAddress(invoice.shippingAddress), {
    countryName: country,
  });

  const renderTaxLines = () => {
    if (invoice.taxBreakdown && invoice.taxBreakdown.length > 0) {
      return invoice.taxBreakdown.map((row, idx) => (
        <div key={`${row.taxRateName}-${idx}`} className="flex justify-between text-sm">
          <span className="text-muted-foreground">{row.taxRateName}</span>
          <span>{formatMoney(row.taxAmount, invoice.currency)}</span>
        </div>
      ));
    }
    if (invoice.taxTotal && Number(invoice.taxTotal) !== 0) {
      return (
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{labels.tax}</span>
          <span>{formatMoney(invoice.taxTotal, invoice.currency)}</span>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold">{invoice.invoiceNumber ?? tsl.fallback}</h1>
          {getStatusBadge(invoice.status, tsl)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={handleDownload} disabled={downloading}>
            {downloading ? ti.generatingPdf : ti.downloadPdf}
          </Button>
          {isDraft && (
            <Button variant="outline" asChild>
              <Link to="/weldbooks/invoices/$id/edit" params={{ id }}>{ti.edit}</Link>
            </Button>
          )}
          {canSend && (
            <Button variant="outline" onClick={() => setSendDialogOpen(true)}>
              {ti.send}
            </Button>
          )}
          {isDraft && (
            <Button
              variant="outline"
              onClick={handleFinalize}
              disabled={finalizeMutation.isPending}
            >
              {finalizeMutation.isPending ? ti.finalizing : ti.finalize}
            </Button>
          )}
          {canRecordPayment && (
            <Button onClick={() => setPaymentDialogOpen(true)}>{ti.recordPayment}</Button>
          )}
          {(canCancel || canWriteOff) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={ti.moreActions}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canWriteOff && (
                  <DropdownMenuItem onClick={() => setStatusDialog('uncollectible')}>
                    {ti.markUncollectible}
                  </DropdownMenuItem>
                )}
                {canCancel && (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setStatusDialog('cancelled')}
                  >
                    {ti.cancelInvoice}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{ti.contact}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <p className="font-medium">{invoice.contactName ?? '-'}</p>
              {invoice.contactEmail && (
                <p className="text-sm text-muted-foreground">{invoice.contactEmail}</p>
              )}
            </div>
            {(billingLines.length > 0 || shippingLines.length > 0) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                {billingLines.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase text-muted-foreground">{ti.billTo}</p>
                    {billingLines.map((line) => <p key={line}>{line}</p>)}
                  </div>
                )}
                {shippingLines.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase text-muted-foreground">{ti.shipTo}</p>
                    {shippingLines.map((line) => <p key={line}>{line}</p>)}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{ti.dates}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{ti.issueDate}</span>
              <span>{formatDate(invoice.issueDate, '-')}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{ti.dueDate}</span>
              <span>{formatDate(invoice.dueDate, '-')}</span>
            </div>
            {invoice.reference && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{ti.reference}</span>
                <span>{invoice.reference}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {invoice.attachmentKeys && invoice.attachmentKeys.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{ti.originalDocuments}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {invoice.attachmentKeys.map((key, index) => {
              const name = key.split('/').pop() || ti.attachmentFallback.replace('{n}', String(index + 1));
              return (
                <Button
                  key={`${key}-${index}`}
                  variant="outline"
                  size="sm"
                  disabled={openingAttachment === index}
                  onClick={() => handleOpenAttachment(index, name)}
                >
                  {openingAttachment === index ? ti.generatingPdf : `${ti.openAttachment}: ${name}`}
                </Button>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Line Items */}
      <Card>
        <CardHeader>
          <CardTitle>{ti.lineItems}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40%]">{ti.description}</TableHead>
                <TableHead className="text-right">{ti.qty}</TableHead>
                <TableHead className="text-right">{ti.unitPrice}</TableHead>
                <TableHead className="text-right">{ti.discount}</TableHead>
                <TableHead className="text-right">{labels.tax}</TableHead>
                <TableHead className="text-right">{ti.total}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.items?.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.description}</TableCell>
                  <TableCell className="text-right">
                    {item.quantity ?? '-'}
                    {item.unit ? ` ${item.unit}` : ''}
                  </TableCell>
                  <TableCell className="text-right">
                    {formatMoney(item.unitPrice, invoice.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.discountPercent ? `${Number(item.discountPercent)}%` : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.taxRate ? `${Number(item.taxRate)}%` : '-'}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatMoney(item.lineTotalWithTax ?? item.lineTotal, invoice.currency)}
                  </TableCell>
                </TableRow>
              ))}
              {(!invoice.items || invoice.items.length === 0) && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {ti.noLineItems}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Totals */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex justify-end">
            <div className="w-full max-w-xs space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{ti.subtotal}</span>
                <span>{formatMoney(invoice.subtotal, invoice.currency)}</span>
              </div>
              {renderTaxLines()}
              <div className="flex justify-between font-semibold border-t pt-2">
                <span>{ti.total}</span>
                <span>{formatMoney(invoice.total, invoice.currency)}</span>
              </div>
              {invoice.amountPaid && Number(invoice.amountPaid) > 0 && (
                <div className="flex justify-between text-sm text-green-600 dark:text-green-400">
                  <span>{ti.amountPaid}</span>
                  <span>-{formatMoney(invoice.amountPaid, invoice.currency)}</span>
                </div>
              )}
              {invoice.balanceDue && Number(invoice.balanceDue) > 0 && (
                <div className="flex justify-between font-semibold">
                  <span>{ti.balanceDue}</span>
                  <span>{formatMoney(invoice.balanceDue, invoice.currency)}</span>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Dialogs */}
      <SendInvoiceDialog
        invoiceId={invoice.id}
        contactEmail={invoice.contactEmail}
        isDraft={isDraft}
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
      />
      <RecordPaymentDialog
        invoiceId={invoice.id}
        balanceDue={invoice.balanceDue ?? '0'}
        open={paymentDialogOpen}
        onOpenChange={setPaymentDialogOpen}
      />
      <ConfirmDialog
        open={statusDialog !== null}
        onOpenChange={(open) => {
          if (!open) setStatusDialog(null);
        }}
        title={statusDialog === 'uncollectible' ? ti.uncollectibleTitle : ti.cancelInvoiceTitle}
        description={statusDialog === 'uncollectible' ? ti.uncollectibleDescription : ti.cancelInvoiceDescription}
        confirmLabel={statusDialog === 'uncollectible' ? ti.confirmUncollectible : ti.confirmCancel}
        cancelLabel={ti.keepInvoice}
        variant="destructive"
        loading={statusMutation.isPending}
        onConfirm={handleStatusChange}
      />
    </div>
  );
}
