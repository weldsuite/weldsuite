/**
 * What an invoice's status allows you to do to it — finalize, send, record a
 * payment, credit, write off, cancel — with the dialogs those actions ask in
 * and the outcome of each (a toast, or for a sales tax refusal a notice that
 * stays in the panel until the next attempt).
 */

import { useState } from 'react';
import { toast } from 'sonner';
import {
  useApplyCreditNote,
  useFinalizeInvoice,
  useUpdateInvoiceStatus,
} from '@/hooks/queries/use-accounting-queries';
import { useCommitInvoiceTax, useCreateCreditMemo } from '@/hooks/queries/use-weldbooks-tax-preview';
import {
  salesTaxErrorCode,
  type InvoiceWithTax,
  type TaxSyncResult,
} from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useDescribeError } from '@/app/weldbooks/invoices/components/sales-tax-error-notice';

/** The two ways to close an invoice without being paid, each asked for in a dialog. */
export type InvoiceStatusDialog = 'cancelled' | 'uncollectible' | null;

export function useInvoiceWorkflow(invoice: InvoiceWithTax | undefined) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const td = useDocumentTexts();
  const { formatMoney } = useWeldbooksFormat();
  const describeError = useDescribeError();
  const router = useRouter();

  const finalizeMutation = useFinalizeInvoice();
  const statusMutation = useUpdateInvoiceStatus();
  const commitTaxMutation = useCommitInvoiceTax();
  const creditMemoMutation = useCreateCreditMemo();
  const applyCreditMutation = useApplyCreditNote();

  const [sendOpen, setSendOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [statusDialog, setStatusDialog] = useState<InvoiceStatusDialog>(null);
  /** The last finalize / send that a sales tax rule refused, shown until the next attempt. */
  const [taxError, setTaxError] = useState<unknown>(null);

  /** A sales tax refusal stays in the panel as a notice with links; anything else is a toast. */
  const showFailure = (title: string, err: unknown) => {
    if (salesTaxErrorCode(err)) {
      setTaxError(err);
      return;
    }
    toast.error(title, { description: describeError(err) });
  };

  const finalize = () => {
    if (!invoice) return;
    setTaxError(null);
    // The button shows "Finalizing..." while it runs; a refusal comes back as a notice or a toast.
    setFinalizeOpen(false);
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

  const retryCommit = () => {
    if (!invoice) return;
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

  const createCreditMemo = () => {
    if (!invoice) return;
    creditMemoMutation.mutate(invoice.id, {
      onSuccess: (res) => {
        toast.success(td.detail.creditMemoCreated.replace('{number}', res.data.invoiceNumber));
        // The draft mirrors the invoice: open it to credit part of it, or finalize it as it is.
        router.push(`/weldbooks/invoices/${res.data.id}/edit`);
      },
      onError: (err) => toast.error(td.detail.creditMemoFailed, { description: describeError(err) }),
    });
  };

  const applyCredit = () => {
    if (!invoice) return;
    applyCreditMutation.mutate(
      { id: invoice.id },
      {
        onSuccess: (res) =>
          toast.success(ti.creditApplied.replace('{amount}', formatMoney(res.data.amount, invoice.currency))),
        onError: (err) => toast.error(ti.applyCreditFailed, { description: describeError(err) }),
      },
    );
  };

  const changeStatus = async () => {
    if (!invoice || !statusDialog) return;
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

  return {
    sendOpen,
    setSendOpen,
    paymentOpen,
    setPaymentOpen,
    finalizeOpen,
    setFinalizeOpen,
    statusDialog,
    setStatusDialog,
    taxError,
    setTaxError,
    finalizing: finalizeMutation.isPending,
    applyingCredit: applyCreditMutation.isPending,
    creatingCreditMemo: creditMemoMutation.isPending,
    retryingCommit: commitTaxMutation.isPending,
    changingStatus: statusMutation.isPending,
    finalize,
    retryCommit,
    createCreditMemo,
    applyCredit,
    changeStatus,
  };
}
