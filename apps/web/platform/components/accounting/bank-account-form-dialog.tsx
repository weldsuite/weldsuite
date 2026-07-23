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
import { Checkbox } from '@weldsuite/ui/components/checkbox';
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
  useCreateBankAccount,
  useUpdateBankAccount,
  useAccountingAccounts,
} from '@/hooks/queries/use-accounting-queries';
import type { BankAccount } from '@/lib/api/domains/weldbooks';

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN'];

interface BankAccountFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When present, the dialog switches to edit mode and pre-fills its fields. */
  bankAccount?: BankAccount | null;
}

/**
 * Create or edit a bank account. Doubles as both by toggling on the presence of `bankAccount`.
 * On success, the mutation hooks invalidate bank-account list + detail queries so callers
 * don't need to refresh anything manually.
 */
export function BankAccountFormDialog({
  open,
  onOpenChange,
  bankAccount,
}: BankAccountFormDialogProps) {
  const t = useTranslations();
  const isEdit = !!bankAccount;

  const [name, setName] = useState('');
  const [iban, setIban] = useState('');
  const [bic, setBic] = useState('');
  const [bankName, setBankName] = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [ledgerAccountId, setLedgerAccountId] = useState<string>('');
  const [isDefault, setIsDefault] = useState(false);
  const [autoReconcile, setAutoReconcile] = useState(true);

  // Bank ledger accounts from the CoA — filtered to asset/bank subtype
  const { data: accountsData } = useAccountingAccounts();
  const ledgerOptions = (accountsData?.data ?? []).filter(
    (a: any) => a.type === 'asset' && (a.subtype === 'bank' || a.subtype === 'cash'),
  );

  // Reset/prefill whenever the dialog opens or the account changes
  useEffect(() => {
    if (!open) return;
    if (bankAccount) {
      setName(bankAccount.name ?? '');
      setIban(bankAccount.iban ?? '');
      setBic(bankAccount.bic ?? '');
      setBankName(bankAccount.bankName ?? '');
      setAccountHolderName(bankAccount.accountHolderName ?? '');
      setCurrency(bankAccount.currency ?? 'EUR');
      setLedgerAccountId(bankAccount.ledgerAccountId ?? '');
      setIsDefault(!!bankAccount.isDefault);
      setAutoReconcile(bankAccount.autoReconcile !== false);
    } else {
      setName('');
      setIban('');
      setBic('');
      setBankName('');
      setAccountHolderName('');
      setCurrency('EUR');
      setLedgerAccountId('');
      setIsDefault(false);
      setAutoReconcile(true);
    }
  }, [open, bankAccount]);

  const createMutation = useCreateBankAccount();
  const updateMutation = useUpdateBankAccount();
  const pending = createMutation.isPending || updateMutation.isPending;
  const errorMessage =
    (createMutation.error as Error | null)?.message ??
    (updateMutation.error as Error | null)?.message ??
    null;

  const handleSubmit = () => {
    const payload = {
      name,
      iban: iban || undefined,
      bic: bic || undefined,
      bankName: bankName || undefined,
      accountHolderName: accountHolderName || undefined,
      currency,
      ledgerAccountId: ledgerAccountId || undefined,
      isDefault,
      autoReconcile,
    };
    if (isEdit && bankAccount) {
      updateMutation.mutate(
        { id: bankAccount.id, data: payload },
        { onSuccess: () => onOpenChange(false) },
      );
    } else {
      createMutation.mutate(payload, { onSuccess: () => onOpenChange(false) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t('sweep.weldbooks.bankAccountForm.editTitle') : t('sweep.weldbooks.bankAccountForm.newTitle')}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? t('sweep.weldbooks.bankAccountForm.editDescription')
              : t('sweep.weldbooks.bankAccountForm.newDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="ba-name">{t('sweep.weldbooks.name')}</Label>
            <Input
              id="ba-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ABN AMRO Business"
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ba-iban">{t('sweep.weldbooks.bankAccountForm.ibanLabel')}</Label>
              <Input
                id="ba-iban"
                value={iban}
                onChange={(e) => setIban(e.target.value.toUpperCase())}
                placeholder="NL91 ABNA 0417 1643 00"
              />
            </div>
            <div>
              <Label htmlFor="ba-bic">{t('sweep.weldbooks.bankAccountForm.bicLabel')}</Label>
              <Input
                id="ba-bic"
                value={bic}
                onChange={(e) => setBic(e.target.value.toUpperCase())}
                placeholder="ABNANL2A"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ba-bank">{t('sweep.weldbooks.bankAccountForm.bankNameLabel')}</Label>
              <Input
                id="ba-bank"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                placeholder="ABN AMRO"
              />
            </div>
            <div>
              <Label htmlFor="ba-holder">{t('sweep.weldbooks.bankAccountForm.accountHolderLabel')}</Label>
              <Input
                id="ba-holder"
                value={accountHolderName}
                onChange={(e) => setAccountHolderName(e.target.value)}
                placeholder="WeldCorp BV"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('sweep.weldbooks.currency')}</Label>
              <Select value={currency} onValueChange={setCurrency}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('sweep.weldbooks.bankAccountForm.ledgerAccountLabel')}</Label>
              <Select value={ledgerAccountId} onValueChange={setLedgerAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder={t('sweep.weldbooks.reconciliationRuleForm.optionalPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {ledgerOptions.length === 0 ? (
                    <SelectItem value="_none" disabled>{t('sweep.weldbooks.bankAccountForm.noLedgerAccounts')}</SelectItem>
                  ) : (
                    ledgerOptions.map((a: any) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          <label className="flex items-center gap-2">
            <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(!!v)} />
            <span className="text-sm">{t('sweep.weldbooks.bankAccountForm.makeDefault')}</span>
          </label>

          <label className="flex items-center gap-2">
            <Checkbox checked={autoReconcile} onCheckedChange={(v) => setAutoReconcile(!!v)} />
            <span className="text-sm">
              {t('sweep.weldbooks.bankAccountForm.autoReconcileLabel')}
            </span>
          </label>
        </div>

        {errorMessage ? (
          <p className="text-sm text-destructive">{errorMessage}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t('sweep.weldbooks.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!name || pending}>
            {pending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" />{t('sweep.weldbooks.saving')}</>
            ) : isEdit ? (
              t('sweep.weldbooks.saveChanges')
            ) : (
              t('sweep.weldbooks.bankAccountForm.createButton')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
