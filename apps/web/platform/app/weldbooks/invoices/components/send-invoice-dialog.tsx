import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useSendInvoice } from '@/hooks/queries/use-accounting-queries';
import { salesTaxErrorCode } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { missingFieldsFromError } from '@/lib/weldbooks/invoice-requirements';
import { useEntityInvoiceDetails } from '@/lib/weldbooks/use-entity-invoice-details';
import { EntityInvoiceDetailsNotice } from './entity-invoice-details';
import { useDescribeError } from './sales-tax-error-notice';

/**
 * "Mark as sent": WeldBooks does not e-mail invoices yet (both backends only set the status and
 * `sentAt`), so the dialog says that instead of promising an email.
 */
interface SendInvoiceDialogProps {
  invoiceId: string;
  /** A draft is finalized (posted) by the server before it is sent. */
  isDraft?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * A sales tax rule refused the finalize that sending a draft starts (address
   * missing, engine down, rates not set up): the page shows it as a notice
   * with links instead of a toast that disappears.
   */
  onTaxError?: (error: unknown) => void;
}

export function SendInvoiceDialog({
  invoiceId,
  isDraft = false,
  open,
  onOpenChange,
  onTaxError,
}: Readonly<SendInvoiceDialogProps>) {
  const sendInvoice = useSendInvoice();
  const { t } = useI18n();
  const ts = t.accounting.sendInvoice;
  const describeError = useDescribeError();
  // Sending a draft finalizes it, which needs the company details every invoice shows.
  const invoiceDetails = useEntityInvoiceDetails();
  const detailsMissing = isDraft && invoiceDetails.missing.length > 0;

  const handleSend = () => {
    onTaxError?.(null);
    sendInvoice.mutate(invoiceId, {
      onSuccess: () => {
        toast.success(ts.sent);
        onOpenChange(false);
      },
      onError: (err) => {
        if (onTaxError && salesTaxErrorCode(err)) {
          onTaxError(err);
          onOpenChange(false);
          return;
        }
        // The company details the server found missing, named in the user's language.
        const missing = missingFieldsFromError(err);
        const description =
          missing.length > 0
            ? t.accounting.entityInvoiceDetails.issueDescription.replace(
                '{fields}',
                missing.map((field) => invoiceDetails.labels[field]).join(', '),
              )
            : describeError(err);
        toast.error(ts.sendFailed, { description });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{ts.title}</DialogTitle>
        </DialogHeader>
        {/* Nothing is e-mailed yet: the action only marks the invoice as sent, and the dialog says so. */}
        <p className="text-sm text-muted-foreground">{ts.notEmailed}</p>
        {isDraft && <p className="text-sm text-muted-foreground">{ts.draftWillFinalize}</p>}
        {isDraft && (
          <EntityInvoiceDetailsNotice
            entity={invoiceDetails.entity}
            missing={invoiceDetails.missing}
            labels={invoiceDetails.labels}
            context="issue"
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {ts.cancel}
          </Button>
          <Button onClick={handleSend} disabled={sendInvoice.isPending || detailsMissing}>
            {sendInvoice.isPending ? ts.sending : ts.send}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
