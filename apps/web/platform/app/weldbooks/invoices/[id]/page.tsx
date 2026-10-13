import { useMemo, useState } from 'react';
import { useParams, useRouter } from '@/lib/router';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useAccountingEntity,
  useAccountingInvoice,
  useApplyCreditNote,
  useFinalizeInvoice,
  useUpdateInvoiceStatus,
} from '@/hooks/queries/use-accounting-queries';
import {
  useCommitInvoiceTax,
  useCreateCreditMemo,
  useExemptionCertificates,
} from '@/hooks/queries/use-weldbooks-tax-preview';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import {
  salesTaxErrorCode,
  salesTaxPreviewApi,
  type InvoiceWithTax,
  type TaxSyncResult,
} from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import {
  generateInvoicePdf,
  downloadPdf,
  type InvoicePdfLabels,
} from '@/lib/weldbooks/invoice-pdf';
import { RecordPaymentDialog } from '../components/record-payment-dialog';
import { SendInvoiceDialog } from '../components/send-invoice-dialog';
import { SalesTaxErrorNotice, useDescribeError } from '../components/sales-tax-error-notice';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { exemptCertificateIdsOf } from '@/lib/weldbooks/document-tax';
import { getInvoiceCapabilities } from './invoice-capabilities';
import {
  AttachmentsCard,
  ContactCard,
  CreditMemoNotice,
  CreditNotesCard,
  DatesCard,
  InvoiceHeader,
  LineItemsCard,
  SalesTaxCard,
  StatusChangeDialog,
  TotalsCard,
  useCountryLabel,
  type InvoiceStatusDialog,
} from './invoice-detail-sections';

export default function InvoiceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { t } = useI18n();
  const st = useTranslations();
  const ti = t.accounting.invoiceDetail;
  const td = useDocumentTexts();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const { labels } = useJurisdictionLabels();
  const canUpdate = useCan('invoices:update');
  const canCreate = useCan('invoices:create');
  const describeError = useDescribeError();

  const { data, isLoading } = useAccountingInvoice(id);
  const finalizeMutation = useFinalizeInvoice();
  const statusMutation = useUpdateInvoiceStatus();
  const commitTaxMutation = useCommitInvoiceTax();
  const creditMemoMutation = useCreateCreditMemo();
  const applyCreditMutation = useApplyCreditNote();

  const { entityId } = useCurrentAccountingEntity();
  const { data: entity } = useAccountingEntity(entityId);

  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [statusDialog, setStatusDialog] = useState<InvoiceStatusDialog>(null);
  const [finalizeDialogOpen, setFinalizeDialogOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [openingAttachment, setOpeningAttachment] = useState<number | null>(null);
  /** The last finalize / send that a sales tax rule refused, shown until the next attempt. */
  const [taxError, setTaxError] = useState<unknown>(null);

  const country = useCountryLabel();

  const invoice = data?.data as unknown as InvoiceWithTax | undefined;

  const certificateIds = useMemo(() => exemptCertificateIdsOf(invoice?.taxBreakdown), [invoice?.taxBreakdown]);
  const certificates = useExemptionCertificates(certificateIds);
  const certificateNumbers = certificateIds
    .map((certificateId) => certificates.get(certificateId)?.certificateNumber ?? '')
    .filter((number) => number !== '');

  const pdfLabels = (): InvoicePdfLabels => {
    const tp = t.accounting.invoicePdf;
    return {
      ...tp,
      tax: labels.tax,
      taxId: labels.taxId,
      registrationId: labels.registrationId,
      creditNote: labels.creditNote.toUpperCase(),
      jurisdictionTax: td.pdf.jurisdictionTax,
      exempt: td.exempt,
      // India GST tax invoice
      placeOfSupply: t.weldbooksIn.gst.placeOfSupply,
      hsnSac: t.weldbooksIn.gst.hsnSac,
      outsideIndia: t.weldbooksIn.gst.placeOfSupplyOutside,
    };
  };

  const handleDownload = async () => {
    if (!invoice) return;
    setDownloading(true);
    try {
      // The notice names the certificates; read the ones not loaded yet (a user without tax access just gets no number).
      const numbers = (
        await Promise.all(
          certificateIds.map(
            async (certificateId) =>
              certificates.get(certificateId)?.certificateNumber ??
              (await salesTaxPreviewApi
                .getExemptionCertificate(certificateId)
                .then((res) => res.data.certificateNumber)
                .catch(() => null)),
          ),
        )
      ).filter((number): number is string => Boolean(number));
      const bytes = await generateInvoicePdf(
        invoice,
        entity ?? { name: st('sweep.weldbooks.invoiceDetail.yourCompanyFallback') },
        {
          labels: pdfLabels(),
          formatDate: (v) => formatDate(v, '-'),
          countryName: country,
          certificateNumbers: numbers,
        },
      );
      const filename = (invoice.invoiceNumber || 'invoice') + '.pdf';
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

  if (!invoice) {
    return (
      <div className="flex items-center justify-center p-8">{ti.invoiceNotFound}</div>
    );
  }

  const caps = getInvoiceCapabilities(invoice, canUpdate, canCreate);
  const { isDraft, isCreditMemo } = caps;

  /** A sales tax refusal stays on the page as a notice with links; anything else is a toast. */
  const showFailure = (title: string, err: unknown) => {
    if (salesTaxErrorCode(err)) {
      setTaxError(err);
      return;
    }
    toast.error(title, { description: describeError(err) });
  };

  const handleFinalize = () => {
    setTaxError(null);
    // The button shows "Finalizing..." while it runs; a refusal comes back as a notice or a toast.
    setFinalizeDialogOpen(false);
    finalizeMutation.mutate(invoice.id, {
      onSuccess: (res) => {
        toast.success(ti.finalized);
        const sync = (res as unknown as { data?: { taxSync?: TaxSyncResult | null } })?.data?.taxSync;
        if (sync?.status === 'failed') {
          toast.warning(td.detail.commitFailed, { description: sync.warning });
        }
      },
      onError: (err) => showFailure(ti.finalizeFailed, err),
    });
  };

  const handleRetryCommit = () => {
    commitTaxMutation.mutate(invoice.id, {
      onSuccess: (res) => {
        const sync = res.data;
        if (sync.status === 'failed') {
          toast.error(td.detail.commitFailed, { description: sync.warning });
        } else if (sync.status === 'reversed') {
          toast.success(td.detail.commitReversed);
        } else if (sync.status === 'already_synced') {
          toast.success(td.detail.commitAlready);
        } else if (sync.status === 'not_applicable') {
          toast.info(td.detail.commitNotApplicable);
        } else {
          toast.success(td.detail.commitCommitted);
        }
      },
      onError: (err) => toast.error(td.detail.commitFailed, { description: describeError(err) }),
    });
  };

  const handleCreateCreditMemo = () => {
    creditMemoMutation.mutate(invoice.id, {
      onSuccess: (res) => {
        toast.success(td.detail.creditMemoCreated.replace('{number}', res.data.invoiceNumber));
        // The draft mirrors the invoice: open it to credit part of it, or finalize it as it is.
        router.push(`/weldbooks/invoices/${res.data.id}/edit`);
      },
      onError: (err) => toast.error(td.detail.creditMemoFailed, { description: describeError(err) }),
    });
  };

  const handleApplyCredit = () => {
    applyCreditMutation.mutate(
      { id: invoice.id },
      {
        onSuccess: (res) =>
          toast.success(ti.creditApplied.replace('{amount}', formatMoney(res.data.amount, invoice.currency))),
        onError: (err) => toast.error(ti.applyCreditFailed, { description: describeError(err) }),
      },
    );
  };

  const handleStatusChange = async () => {
    if (!statusDialog) return;
    try {
      const res = await statusMutation.mutateAsync({ id: invoice.id, status: statusDialog });
      // With bad debt VAT relief the write-off says how much VAT comes back through the next return.
      const vatRelief = Number((res?.data as { vatRelief?: number } | undefined)?.vatRelief ?? 0);
      toast.success(
        statusDialog === 'uncollectible' && vatRelief > 0
          ? ti.statusUpdatedVatRelief.replace('{amount}', formatMoney(vatRelief, invoice.currency))
          : ti.statusUpdated,
      );
      setStatusDialog(null);
    } catch (err) {
      // The server explains why, e.g. a finalized invoice needs a credit note.
      toast.error(ti.statusUpdateFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* Header */}
      <InvoiceHeader
        invoice={invoice}
        routeId={id}
        caps={caps}
        pending={{
          downloading,
          finalizing: finalizeMutation.isPending,
          applyingCredit: applyCreditMutation.isPending,
          creatingCreditMemo: creditMemoMutation.isPending,
        }}
        on={{
          onDownload: handleDownload,
          onSend: () => setSendDialogOpen(true),
          onFinalize: () => setFinalizeDialogOpen(true),
          onApplyCredit: handleApplyCredit,
          onRecordPayment: () => setPaymentDialogOpen(true),
          onCreateCreditMemo: handleCreateCreditMemo,
          onStatusDialog: setStatusDialog,
        }}
      />

      {taxError !== null && <SalesTaxErrorNotice error={taxError} invoiceId={invoice.id} />}

      {isCreditMemo && <CreditMemoNotice creditNoteForInvoiceId={invoice.creditNoteForInvoiceId} />}

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <ContactCard invoice={invoice} />
        <DatesCard invoice={invoice} />
      </div>

      <SalesTaxCard
        invoice={invoice}
        isDraft={isDraft}
        canUpdate={canUpdate}
        certificateNumbers={certificateNumbers}
        retrying={commitTaxMutation.isPending}
        onRetryCommit={handleRetryCommit}
      />

      {invoice.attachmentKeys && invoice.attachmentKeys.length > 0 && (
        <AttachmentsCard
          attachmentKeys={invoice.attachmentKeys}
          openingAttachment={openingAttachment}
          onOpen={handleOpenAttachment}
        />
      )}

      {/* Line Items */}
      <LineItemsCard invoice={invoice} />

      {/* Totals */}
      <TotalsCard invoice={invoice} isCreditMemo={isCreditMemo} />

      {/* Credit notes issued against this invoice: once finalized they lower its balance */}
      <CreditNotesCard invoice={invoice} />

      {/* Dialogs */}
      <SendInvoiceDialog
        invoiceId={invoice.id}
        contactEmail={invoice.contactEmail}
        isDraft={isDraft}
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        onTaxError={setTaxError}
      />
      <RecordPaymentDialog
        invoiceId={invoice.id}
        balanceDue={invoice.status === 'uncollectible' ? caps.writtenOffBalance.toFixed(2) : (invoice.balanceDue ?? '0')}
        currency={invoice.currency}
        open={paymentDialogOpen}
        onOpenChange={setPaymentDialogOpen}
        refund={isCreditMemo}
      />
      <ConfirmDialog
        open={finalizeDialogOpen}
        onOpenChange={setFinalizeDialogOpen}
        title={ti.finalizeConfirmTitle}
        description={ti.finalizeConfirmDescription}
        confirmLabel={ti.confirmFinalize}
        cancelLabel={ti.keepDraft}
        loading={finalizeMutation.isPending}
        onConfirm={handleFinalize}
      />
      <StatusChangeDialog
        status={statusDialog}
        loading={statusMutation.isPending}
        onClose={() => setStatusDialog(null)}
        onConfirm={handleStatusChange}
      />
    </div>
  );
}
