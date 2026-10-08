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
import { useDescribeError } from './sales-tax-error-notice';

interface SendInvoiceDialogProps {
  invoiceId: string;
  contactEmail: string | null;
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
  contactEmail,
  isDraft = false,
  open,
  onOpenChange,
  onTaxError,
}: Readonly<SendInvoiceDialogProps>) {
  const sendInvoice = useSendInvoice();
  const { t } = useI18n();
  const ts = t.accounting.sendInvoice;
  const describeError = useDescribeError();

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
        toast.error(ts.sendFailed, { description: describeError(err) });
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{ts.title}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {contactEmail
            ? ts.sendToEmail.replace('{email}', contactEmail)
            : ts.noEmailFound}
        </p>
        {isDraft && <p className="text-sm text-muted-foreground">{ts.draftWillFinalize}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {ts.cancel}
          </Button>
          <Button onClick={handleSend} disabled={sendInvoice.isPending}>
            {sendInvoice.isPending ? ts.sending : ts.send}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
