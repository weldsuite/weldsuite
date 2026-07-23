import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useSendInvoice } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';

interface SendInvoiceDialogProps {
  invoiceId: string;
  contactEmail: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SendInvoiceDialog({
  invoiceId,
  contactEmail,
  open,
  onOpenChange,
}: SendInvoiceDialogProps) {
  const sendInvoice = useSendInvoice();
  const { t } = useI18n();
  const ts = t.accounting.sendInvoice;

  const handleSend = () => {
    sendInvoice.mutate(invoiceId, {
      onSuccess: () => {
        onOpenChange(false);
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
