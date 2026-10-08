import { useState } from 'react';
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
import { useReversePayrollImport } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { PayrollImport } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { errorMessage, fill } from '../../fixed-assets/text';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface ReverseDialogProps {
  payroll: Pick<PayrollImport, 'id' | 'payDate'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReversed?: () => void;
}

/** Reverse an imported payroll: a reversing entry on the chosen date (the pay date by default); the import stays on the list as reversed. */
export function ReversePayrollDialog({ payroll, open, onOpenChange, onReversed }: Readonly<ReverseDialogProps>) {
  const { t } = useI18n();
  const tr = t.weldbooksUs.assets.payroll.reverse;
  const common = t.weldbooksUs.assets.common;
  const { formatDate } = useWeldbooksFormat();
  const reverse = useReversePayrollImport();
  const [date, setDate] = useState(payroll.payDate);
  const [error, setError] = useState<string | null>(null);
  const dateValid = ISO_DATE.test(date);

  const submit = async () => {
    if (!dateValid) return;
    setError(null);
    try {
      await reverse.mutateAsync({ id: payroll.id, date });
      toast.success(tr.reversed);
      onOpenChange(false);
      onReversed?.();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (reverse.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{fill(tr.title, { date: formatDate(payroll.payDate) })}</DialogTitle>
          <DialogDescription>{tr.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reverse-date">{tr.date}</Label>
          <Input id="reverse-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          <p className="text-xs text-muted-foreground">{tr.dateHelp}</p>
          {!dateValid ? (
            <p className="text-sm text-destructive" role="alert">
              {tr.invalidDate}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert" data-testid="reverse-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={reverse.isPending}>
            {common.cancel}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void submit()} disabled={!dateValid || reverse.isPending} data-testid="reverse-submit">
            {reverse.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {tr.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
