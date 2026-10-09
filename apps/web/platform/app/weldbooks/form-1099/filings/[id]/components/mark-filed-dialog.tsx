import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useMarkForm1099Filed } from '@/hooks/queries/use-weldbooks-1099-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

interface MarkFiledDialogProps {
  filingId: string;
  formLabel: string;
  correction: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Records that the IRIS upload was accepted: the confirmation (receipt) number and the date. */
export function MarkFiledDialog({ filingId, formLabel, correction, open, onOpenChange }: Readonly<MarkFiledDialogProps>) {
  const { t } = useI18n();
  const tm = t.weldbooksUs.form1099.markFiled;
  const { today } = useWeldbooksFormat();
  const markFiled = useMarkForm1099Filed(filingId);
  const [confirmation, setConfirmation] = useState('');
  const [filedAt, setFiledAt] = useState('');
  const [touched, setTouched] = useState(false);
  // Reset when the dialog opens, not whenever the formatter is rebuilt.
  const todayRef = useRef(today);
  todayRef.current = today;

  useEffect(() => {
    if (open) {
      setConfirmation('');
      setFiledAt(todayRef.current());
      setTouched(false);
    }
  }, [open]);

  const missing = confirmation.trim() === '';

  const submit = async () => {
    setTouched(true);
    if (missing) return;
    try {
      await markFiled.mutateAsync({ confirmationNumber: confirmation.trim(), filedAt: filedAt || undefined });
      toast.success(tm.done);
      onOpenChange(false);
    } catch (err) {
      toast.error(tm.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{(correction ? tm.titleCorrection : tm.title).replace('{form}', formLabel)}</DialogTitle>
          <DialogDescription>{tm.description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="filed-confirmation">{tm.confirmation} *</Label>
            <Input
              id="filed-confirmation"
              value={confirmation}
              maxLength={255}
              autoComplete="off"
              aria-invalid={touched && missing}
              aria-describedby="filed-confirmation-help"
              onChange={(event) => setConfirmation(event.target.value)}
            />
            <p id="filed-confirmation-help" className="text-xs text-muted-foreground">
              {tm.confirmationHelp}
            </p>
            {touched && missing ? <p className="text-sm text-destructive">{tm.confirmationRequired}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="filed-date">{tm.filedOn}</Label>
            <Input id="filed-date" type="date" value={filedAt} onChange={(event) => setFiledAt(event.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tm.cancel}
            </Button>
            <Button type="submit" disabled={markFiled.isPending}>
              {markFiled.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
              {tm.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
