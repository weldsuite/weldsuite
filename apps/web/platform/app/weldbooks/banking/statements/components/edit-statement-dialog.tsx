import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
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
import { useI18n } from '@/lib/i18n/provider';
import { parseStatementBalance } from '../reconciliation-math';

interface EditStatementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statementDate: string;
  endingBalance: number;
  accountKind: 'bank' | 'credit_card';
  pending: boolean;
  errorMessage: string | null;
  onSave: (values: { statementDate: string; statementEndingBalance: number }) => void;
}

/** Correct the statement date or ending balance of a reconciliation in progress. */
export function EditStatementDialog({
  open,
  onOpenChange,
  statementDate,
  endingBalance,
  accountKind,
  pending,
  errorMessage,
  onSave,
}: Readonly<EditStatementDialogProps>) {
  const { t } = useI18n();
  const te = t.weldbooksUs.banking.worksheet.editStatement;
  const [date, setDate] = useState(statementDate);
  const [ending, setEnding] = useState(endingBalance.toFixed(2));

  useEffect(() => {
    if (open) {
      setDate(statementDate);
      setEnding(endingBalance.toFixed(2));
    }
  }, [open, statementDate, endingBalance]);

  const parsed = parseStatementBalance(ending);

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{te.title}</DialogTitle>
          <DialogDescription>{te.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="edit-statement-date">{te.date}</Label>
            <Input id="edit-statement-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-statement-ending">{accountKind === 'credit_card' ? te.endingBalanceOwed : te.endingBalance}</Label>
            <Input id="edit-statement-ending" inputMode="decimal" value={ending} onChange={(e) => setEnding(e.target.value)} />
          </div>
          {errorMessage ? <p className="text-sm text-destructive" role="alert">{errorMessage}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {te.cancel}
          </Button>
          <Button
            disabled={pending || !date || parsed === null}
            onClick={() => parsed !== null && onSave({ statementDate: date, statementEndingBalance: parsed })}
          >
            {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {te.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
