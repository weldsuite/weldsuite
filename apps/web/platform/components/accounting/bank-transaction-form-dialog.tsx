import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Loader2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  useAccountingBankAccounts,
  useCreateBankTransaction,
} from '@/hooks/queries/use-accounting-queries';
import type { BankAccount } from '@/lib/api/domains/weldbooks';

interface BankTransactionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the account field is locked to this bank account. */
  bankAccountId?: string;
}

function todayIsoDate(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Manually record a bank transaction (cashbook entry) against a bank account.
 * Amount is always entered as a positive number; direction chooses the sign
 * stored on the ledger (positive = money in, negative = money out).
 */
export function BankTransactionFormDialog({
  open,
  onOpenChange,
  bankAccountId: lockedBankAccountId,
}: BankTransactionFormDialogProps) {
  const t = useTranslations();
  const { data: accountsRes } = useAccountingBankAccounts();
  const accounts = (accountsRes?.data ?? []) as BankAccount[];

  const [bankAccountId, setBankAccountId] = useState('');
  const [date, setDate] = useState(todayIsoDate);
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [counterpartyName, setCounterpartyName] = useState('');
  const [counterpartyIban, setCounterpartyIban] = useState('');
  const [reference, setReference] = useState('');

  useEffect(() => {
    if (!open) return;
    setBankAccountId(lockedBankAccountId ?? '');
    setDate(todayIsoDate());
    setDirection('in');
    setAmount('');
    setDescription('');
    setCounterpartyName('');
    setCounterpartyIban('');
    setReference('');
  }, [open, lockedBankAccountId]);

  const createMutation = useCreateBankTransaction();
  const pending = createMutation.isPending;
  const errorMessage = (createMutation.error as Error | null)?.message ?? null;
  const amountNumber = Number(amount);
  const canSubmit =
    !!bankAccountId &&
    !!date &&
    Number.isFinite(amountNumber) &&
    amountNumber > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const signedAmount = direction === 'out' ? -Math.abs(amountNumber) : Math.abs(amountNumber);
    createMutation.mutate(
      {
        bankAccountId,
        date,
        amount: signedAmount,
        description: description.trim() || undefined,
        counterpartyName: counterpartyName.trim() || undefined,
        counterpartyIban: counterpartyIban.trim() || undefined,
        reference: reference.trim() || undefined,
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('sweep.weldbooks.bankTransactionForm.title')}</DialogTitle>
          <DialogDescription>
            {t('sweep.weldbooks.bankTransactionForm.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {lockedBankAccountId ? null : (
            <div>
              <Label htmlFor="bt-account">{t('sweep.weldbooks.bankTransactionForm.accountLabel')}</Label>
              <Select value={bankAccountId} onValueChange={setBankAccountId}>
                <SelectTrigger id="bt-account">
                  <SelectValue placeholder={t('sweep.weldbooks.bankTransactionForm.selectAccount')} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.length === 0 ? (
                    <SelectItem value="_none" disabled>
                      {t('sweep.weldbooks.bankTransactionForm.noAccounts')}
                    </SelectItem>
                  ) : (
                    accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}{a.iban ? ` — ${a.iban}` : ''}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bt-date">{t('sweep.weldbooks.bankTransactionForm.dateLabel')}</Label>
              <Input
                id="bt-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <Label>{t('sweep.weldbooks.bankTransactionForm.directionLabel')}</Label>
              <Select value={direction} onValueChange={(v) => setDirection(v as 'in' | 'out')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="in">{t('sweep.weldbooks.bankTransactionForm.moneyIn')}</SelectItem>
                  <SelectItem value="out">{t('sweep.weldbooks.bankTransactionForm.moneyOut')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="bt-amount">{t('sweep.weldbooks.bankTransactionForm.amountLabel')}</Label>
            <Input
              id="bt-amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
            />
          </div>

          <div>
            <Label htmlFor="bt-description">{t('sweep.weldbooks.bankTransactionForm.descriptionLabel')}</Label>
            <Input
              id="bt-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('sweep.weldbooks.bankTransactionForm.descriptionPlaceholder')}
            />
          </div>

          <div>
            <Label htmlFor="bt-counterparty">{t('sweep.weldbooks.bankTransactionForm.counterpartyLabel')}</Label>
            <Input
              id="bt-counterparty"
              value={counterpartyName}
              onChange={(e) => setCounterpartyName(e.target.value)}
              placeholder={t('sweep.weldbooks.bankTransactionForm.counterpartyPlaceholder')}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bt-iban">{t('sweep.weldbooks.bankTransactionForm.ibanLabel')}</Label>
              <Input
                id="bt-iban"
                value={counterpartyIban}
                onChange={(e) => setCounterpartyIban(e.target.value.toUpperCase())}
                placeholder="NL91 ABNA 0417 1643 00"
              />
            </div>
            <div>
              <Label htmlFor="bt-reference">{t('sweep.weldbooks.bankTransactionForm.referenceLabel')}</Label>
              <Input
                id="bt-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          </div>
        </div>

        {errorMessage ? (
          <p className="text-sm text-destructive">{errorMessage}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('sweep.weldbooks.cancel')}
          </Button>
          <Button
            data-testid="submit-bank-transaction"
            onClick={handleSubmit}
            disabled={!canSubmit || pending}
          >
            {pending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" />{t('sweep.weldbooks.bankTransactionForm.creating')}</>
            ) : (
              t('sweep.weldbooks.bankTransactionForm.createButton')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
