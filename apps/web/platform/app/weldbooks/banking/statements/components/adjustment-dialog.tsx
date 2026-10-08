import { useEffect, useMemo, useState } from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { ledgerCategoryAccounts } from '@/components/accounting/categorize-bank-transaction-panel';
import { useI18n } from '@/lib/i18n/provider';
import type { Account } from '@/lib/api/domains/weldbooks';
import { adjustmentDirection } from '../reconciliation-math';

interface AdjustmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Statement ending balance minus the cleared balance; never zero here. */
  difference: number;
  accounts: readonly Account[];
  formatAmount: (amount: number) => string;
  accountKind: 'bank' | 'credit_card';
  pending: boolean;
  errorMessage: string | null;
  onConfirm: (adjustment: { accountId: string; memo?: string }) => void;
}

/**
 * Finish a reconciliation that is off by a small amount by posting the
 * difference to an account the user chooses (bank charges, interest earned, a
 * rounding account). The dialog is the confirmation: it states the amount and
 * where it goes before anything is posted.
 */
export function AdjustmentDialog({
  open,
  onOpenChange,
  difference,
  accounts,
  formatAmount,
  accountKind,
  pending,
  errorMessage,
  onConfirm,
}: Readonly<AdjustmentDialogProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.banking.worksheet.adjustment;
  const [accountId, setAccountId] = useState('');
  const [memo, setMemo] = useState('');
  const options = useMemo(() => ledgerCategoryAccounts([...accounts]), [accounts]);

  useEffect(() => {
    if (open) {
      setAccountId('');
      setMemo('');
    }
  }, [open]);

  const amount = formatAmount(Math.abs(difference));
  const direction = ta.directions[adjustmentDirection(accountKind, difference)];

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{ta.title}</DialogTitle>
          <DialogDescription>{ta.description.replace('{amount}', amount)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="rounded-md bg-muted/50 p-3 text-sm" data-testid="adjustment-effect">
            {direction.replace('{amount}', amount)}
          </p>
          <div className="space-y-1">
            <Label htmlFor="adjustment-account">{ta.account}</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger id="adjustment-account" data-testid="adjustment-account">
                <SelectValue placeholder={ta.accountPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {options.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{ta.accountHint}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adjustment-memo">{ta.memo}</Label>
            <Input id="adjustment-memo" value={memo} maxLength={255} onChange={(e) => setMemo(e.target.value)} placeholder={ta.memoPlaceholder} />
          </div>
          {errorMessage ? <p className="text-sm text-destructive" role="alert">{errorMessage}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {ta.cancel}
          </Button>
          <Button
            disabled={!accountId || pending}
            onClick={() => onConfirm({ accountId, ...(memo.trim() ? { memo: memo.trim() } : {}) })}
            data-testid="confirm-adjustment"
          >
            {pending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {ta.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
