import { useState } from 'react';
import { useParams } from '@/lib/router';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { PageLoader } from '@/components/page-loader';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  useAccountingInvoice,
  useFinalizeInvoice,
} from '@/hooks/queries/use-accounting-queries';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import {
  generateInvoicePdf,
  downloadPdf,
  type InvoicePdfEntity,
} from '@/lib/weldbooks/invoice-pdf';
import type { InvoiceDetail } from '@/lib/api/domains/weldbooks';
import { RecordPaymentDialog } from '../components/record-payment-dialog';
import { SendInvoiceDialog } from '../components/send-invoice-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

const formatCurrency = (value: string | null | undefined, currency?: string | null) =>
  new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: currency || 'EUR',
  }).format(Number(value ?? 0));

const formatDate = (value: string | null | undefined) => {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('nl-NL', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

function getStatusBadge(status: string, labels: Record<string, string>) {
  switch (status) {
    case 'draft':
      return <Badge variant="outline">{labels.draft}</Badge>;
    case 'sent':
      return <Badge variant="secondary">{labels.sent}</Badge>;
    case 'paid':
      return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">{labels.paid}</Badge>;
    case 'overdue':
      return <Badge variant="destructive">{labels.overdue}</Badge>;
    case 'partial':
      return <Badge variant="secondary">{labels.partial}</Badge>;
    case 'cancelled':
      return <Badge variant="outline">{labels.cancelled}</Badge>;
    case 'finalized':
      return <Badge variant="secondary">{labels.finalized}</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function InvoiceDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { t } = useI18n();
  const st = useTranslations();
  const ti = t.accounting.invoiceDetail;
  const tsl = t.accounting.statusLabels.invoice;

  const { data, isLoading } = useAccountingInvoice(id);
  const finalizeMutation = useFinalizeInvoice();

  const { entityId } = useCurrentAccountingEntity();
  const { data: entity } = useQuery<InvoicePdfEntity | null>({
    queryKey: ['accounting', 'entities', entityId, 'for-pdf'],
    enabled: !!entityId,
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: InvoicePdfEntity } | InvoicePdfEntity>(
        '/accounting-entities/' + entityId,
      );
      return 'data' in res ? res.data : res;
    },
  });

  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    if (!data?.data) return;
    setDownloading(true);
    try {
      const bytes = await generateInvoicePdf(
        data.data as InvoiceDetail,
        entity ?? { name: st('sweep.weldbooks.invoiceDetail.yourCompanyFallback') },
      );
      const filename = ((data.data as InvoiceDetail).invoiceNumber || 'invoice') + '.pdf';
      downloadPdf(bytes, filename);
    } catch (err) {
      console.error('[Invoice] PDF generation failed', err);
      toast.error(ti.failedToPdf);
    } finally {
      setDownloading(false);
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

  const handleFinalize = () => {
    finalizeMutation.mutate(invoice.id);
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-semibold">{invoice.invoiceNumber ?? tsl.fallback}</h1>
          {getStatusBadge(invoice.status, tsl)}
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>{ti.contact}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="font-medium">{invoice.contactName ?? '-'}</p>
            {invoice.contactEmail && (
              <p className="text-sm text-muted-foreground">{invoice.contactEmail}</p>
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
              <span>{formatDate(invoice.issueDate)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">{ti.dueDate}</span>
              <span>{formatDate(invoice.dueDate)}</span>
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

      {/* Line Items */}
      <Card>
        <CardHeader>
          <CardTitle>{ti.lineItems}</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40%]">{ti.description}</TableHead>
                <TableHead className="text-right">{ti.qty}</TableHead>
                <TableHead className="text-right">{ti.unitPrice}</TableHead>
                <TableHead className="text-right">{ti.discount}</TableHead>
                <TableHead className="text-right">{ti.tax}</TableHead>
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
                    {formatCurrency(item.unitPrice, invoice.currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.discountPercent ? `${Number(item.discountPercent)}%` : '-'}
                  </TableCell>
                  <TableCell className="text-right">
                    {item.taxRate ? `${Number(item.taxRate)}%` : '-'}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(item.lineTotalWithTax ?? item.lineTotal, invoice.currency)}
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
                <span>{formatCurrency(invoice.subtotal, invoice.currency)}</span>
              </div>
              {invoice.taxTotal && Number(invoice.taxTotal) !== 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{ti.tax}</span>
                  <span>{formatCurrency(invoice.taxTotal, invoice.currency)}</span>
                </div>
              )}
              <div className="flex justify-between font-semibold border-t pt-2">
                <span>{ti.total}</span>
                <span>{formatCurrency(invoice.total, invoice.currency)}</span>
              </div>
              {invoice.amountPaid && Number(invoice.amountPaid) > 0 && (
                <div className="flex justify-between text-sm text-green-600">
                  <span>{ti.amountPaid}</span>
                  <span>-{formatCurrency(invoice.amountPaid, invoice.currency)}</span>
                </div>
              )}
              {invoice.balanceDue && Number(invoice.balanceDue) > 0 && (
                <div className="flex justify-between font-semibold">
                  <span>{ti.balanceDue}</span>
                  <span>{formatCurrency(invoice.balanceDue, invoice.currency)}</span>
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
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
      />
      <RecordPaymentDialog
        invoiceId={invoice.id}
        balanceDue={invoice.balanceDue ?? '0'}
        open={paymentDialogOpen}
        onOpenChange={setPaymentDialogOpen}
      />
    </div>
  );
}
