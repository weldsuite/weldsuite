import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { useDeleteInvoice } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { useDescribeError } from './sales-tax-error-notice';

interface DiscardCreditMemoDraftProps {
  invoiceId: string;
  invoiceNumber: string | null;
  /** The invoice the credit note credits: its panel opens again once the draft is gone. */
  originalInvoiceId?: string | null;
}

/**
 * "Discard draft" of a credit note that is not finalized yet. The number was given out when the
 * draft was created and stays used, which the confirmation says. Afterwards the original invoice's
 * panel is open again, where the credit note was started.
 */
export function DiscardCreditMemoDraft({ invoiceId, invoiceNumber, originalInvoiceId }: Readonly<DiscardCreditMemoDraftProps>) {
  const { t } = useI18n();
  const tf = t.accounting.invoiceForm;
  const router = useRouter();
  const describeError = useDescribeError();
  const deleteInvoice = useDeleteInvoice();
  const [open, setOpen] = useState(false);

  const discard = async () => {
    try {
      await deleteInvoice.mutateAsync(invoiceId);
    } catch (err) {
      toast.error(tf.discardDraftFailed, { description: describeError(err) });
      return;
    }
    toast.success(tf.draftDiscarded);
    setOpen(false);
    router.push(originalInvoiceId ? `/weldbooks/invoices?stack=invoice:${originalInvoiceId}` : '/weldbooks/credit-notes');
  };

  return (
    <>
      <Button type="button" variant="outline" size="sm" className="shadow-none text-destructive" onClick={() => setOpen(true)}>
        {tf.discardDraft}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tf.discardDraftTitle}
        description={tf.discardDraftDescription.replace('{number}', invoiceNumber ?? '')}
        confirmLabel={tf.discardDraftConfirm}
        variant="destructive"
        loading={deleteInvoice.isPending}
        onConfirm={discard}
      />
    </>
  );
}
