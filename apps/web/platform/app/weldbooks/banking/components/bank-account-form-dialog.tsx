import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import {
  useCreateBankAccountWithDetails,
  useUpdateBankAccountWithDetails,
} from '@/hooks/queries/use-weldbooks-banking-queries';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import {
  BANK_ACCOUNT_TYPES,
  isLiabilityAccountType,
  type BankAccountType,
  type UsBankAccount,
} from '@/lib/api/domains/weldbooks-banking';
import type { Account } from '@/lib/api/domains/weldbooks';
import {
  bankAccountProblems,
  buildBankAccountPayload,
  CREATE_LEDGER_ACCOUNT,
  hasRoutingNumber,
  ledgerAccountsFor,
  NO_LEDGER_ACCOUNT,
  type BankAccountFormValues,
} from './bank-account-model';
import { maskedAccountNumber } from './routing-number';

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'INR', 'CAD'];

interface BankAccountFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When present, the dialog switches to edit mode and pre-fills its fields. */
  bankAccount?: UsBankAccount | null;
}

/** The dialog's values for a new account (`bankAccount` undefined) or an existing one. */
function initialValues(bankAccount: UsBankAccount | null | undefined, currency: string, isUs: boolean): BankAccountFormValues {
  if (bankAccount) {
    return {
      name: bankAccount.name ?? '',
      accountType: bankAccount.accountType ?? 'checking',
      iban: bankAccount.iban ?? '',
      bic: bankAccount.bic ?? '',
      bankName: bankAccount.bankName ?? '',
      accountHolderName: bankAccount.accountHolderName ?? '',
      currency: bankAccount.currency ?? currency,
      ledgerAccountId: bankAccount.ledgerAccountId ?? NO_LEDGER_ACCOUNT,
      isDefault: !!bankAccount.isDefault,
      autoReconcile: bankAccount.autoReconcile !== false,
      routingNumber: bankAccount.routingNumber ?? '',
      accountNumber: '',
      removeAccountNumber: false,
      nextCheckNumber: bankAccount.nextCheckNumber ? String(bankAccount.nextCheckNumber) : '',
    };
  }
  return {
    name: '',
    accountType: 'checking',
    iban: '',
    bic: '',
    bankName: '',
    accountHolderName: '',
    currency,
    ledgerAccountId: isUs ? CREATE_LEDGER_ACCOUNT : NO_LEDGER_ACCOUNT,
    isDefault: false,
    autoReconcile: true,
    routingNumber: '',
    accountNumber: '',
    removeAccountNumber: false,
    nextCheckNumber: '',
  };
}

/**
 * Create or edit a bank account. Doubles as both by toggling on the presence of `bankAccount`.
 * US entities get an account type, routing and account number (the account number is
 * write-only: only its last four digits ever come back); other entities keep IBAN / BIC.
 * On success, the mutation hooks invalidate bank-account list + detail queries so callers
 * don't need to refresh anything manually.
 */
export function BankAccountFormDialog({
  open,
  onOpenChange,
  bankAccount,
}: Readonly<BankAccountFormDialogProps>) {
  const t = useTranslations();
  const { t: i18n } = useI18n();
  const tf = i18n.weldbooksUs.banking.accountForm;
  const accountTypeLabels = i18n.weldbooksUs.banking.accountTypes;
  const isEdit = !!bankAccount;
  const { entityCurrency } = useCurrentEntityCurrency();
  const { code: jurisdictionCode } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(jurisdictionCode);
  // The entity's currency; the first listed one only while the entity is unknown.
  const defaultCurrency = entityCurrency ?? CURRENCIES[0];

  const [values, setValues] = useState<BankAccountFormValues>(() => initialValues(bankAccount, defaultCurrency, isUs));
  const [replacingAccountNumber, setReplacingAccountNumber] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const currencyTouchedRef = useRef(false);
  const set = <K extends keyof BankAccountFormValues>(key: K, value: BankAccountFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  // An entity or account currency outside the common list stays selectable.
  const currencyOptions = values.currency && !CURRENCIES.includes(values.currency) ? [values.currency, ...CURRENCIES] : CURRENCIES;

  const { data: accountsData } = useAccountingAccounts();
  const accounts = useMemo(() => (accountsData?.data ?? []) as Account[], [accountsData]);
  const ledgerOptions = useMemo(() => {
    if (isUs) return ledgerAccountsFor(accounts, values.accountType);
    return accounts.filter((a) => a.type === 'asset' && (a.subtype === 'bank' || a.subtype === 'cash'));
  }, [accounts, isUs, values.accountType]);

  // Reset/prefill whenever the dialog opens or the account changes.
  // The entity's currency is applied in a separate effect so a late-loading
  // entity does not wipe unsaved fields.
  useEffect(() => {
    if (!open) {
      currencyTouchedRef.current = false;
      return;
    }
    setValues(initialValues(bankAccount, defaultCurrency, isUs));
    setReplacingAccountNumber(false);
    setShowProblems(false);
    // Only a (re)opening or another account resets the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bankAccount]);

  useEffect(() => {
    if (!open || bankAccount || currencyTouchedRef.current) return;
    setValues((current) => ({ ...current, currency: defaultCurrency }));
  }, [open, bankAccount, defaultCurrency]);

  // The jurisdiction can arrive after the dialog opened: a new account then starts by creating its ledger account.
  useEffect(() => {
    if (!open || bankAccount) return;
    setValues((current) =>
      isUs && current.ledgerAccountId === NO_LEDGER_ACCOUNT
        ? { ...current, ledgerAccountId: CREATE_LEDGER_ACCOUNT }
        : current,
    );
  }, [open, bankAccount, isUs]);

  const createMutation = useCreateBankAccountWithDetails();
  const updateMutation = useUpdateBankAccountWithDetails();
  const pending = createMutation.isPending || updateMutation.isPending;
  const errorMessage =
    (createMutation.error as Error | null)?.message ??
    (updateMutation.error as Error | null)?.message ??
    null;
  const submitLabel = isEdit
    ? t('sweep.weldbooks.saveChanges')
    : t('sweep.weldbooks.bankAccountForm.createButton');

  const problems = bankAccountProblems(values, { isUs });
  const hasProblem = (problem: (typeof problems)[number]) => showProblems && problems.includes(problem);
  const liability = isLiabilityAccountType(values.accountType);
  const hasStoredNumber = !!bankAccount?.hasAccountNumber && !values.removeAccountNumber;
  const showAccountNumberInput = !hasStoredNumber || replacingAccountNumber;

  const handleSubmit = () => {
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    const payload = buildBankAccountPayload(values, { isUs, isEdit });
    if (isEdit && bankAccount) {
      updateMutation.mutate({ id: bankAccount.id, data: payload }, { onSuccess: () => onOpenChange(false) });
    } else {
      createMutation.mutate(payload, { onSuccess: () => onOpenChange(false) });
    }
  };

  const changeAccountType = (type: BankAccountType) => {
    setValues((current) => {
      // A ledger account chosen for one kind of account may not fit the other.
      const stillFits = ledgerAccountsFor(accounts, type).some((a) => a.id === current.ledgerAccountId);
      const keepsChoice = current.ledgerAccountId === CREATE_LEDGER_ACCOUNT || current.ledgerAccountId === NO_LEDGER_ACCOUNT || stillFits;
      return {
        ...current,
        accountType: type,
        ledgerAccountId: keepsChoice ? current.ledgerAccountId : isEdit ? NO_LEDGER_ACCOUNT : CREATE_LEDGER_ACCOUNT,
      };
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
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
              value={values.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={isUs ? tf.namePlaceholder : 'ABN AMRO Business'}
              aria-invalid={hasProblem('name') || undefined}
              autoFocus
            />
          </div>

          {isUs ? (
            <div>
              <Label htmlFor="ba-type">{tf.typeLabel}</Label>
              <Select value={values.accountType} onValueChange={(v) => changeAccountType(v as BankAccountType)}>
                <SelectTrigger id="ba-type" data-testid="bank-account-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BANK_ACCOUNT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {accountTypeLabels[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {liability ? (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="bank-account-liability-note">
                  {tf.liabilityNote}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ba-iban">{t('sweep.weldbooks.bankAccountForm.ibanLabel')}</Label>
                <Input
                  id="ba-iban"
                  value={values.iban}
                  onChange={(e) => set('iban', e.target.value.toUpperCase())}
                  placeholder="NL91 ABNA 0417 1643 00"
                />
              </div>
              <div>
                <Label htmlFor="ba-bic">{t('sweep.weldbooks.bankAccountForm.bicLabel')}</Label>
                <Input
                  id="ba-bic"
                  value={values.bic}
                  onChange={(e) => set('bic', e.target.value.toUpperCase())}
                  placeholder="ABNANL2A"
                />
              </div>
            </div>
          )}

          {isUs && hasRoutingNumber(values.accountType) ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label htmlFor="ba-routing">{tf.routingLabel}</Label>
                <Input
                  id="ba-routing"
                  inputMode="numeric"
                  maxLength={9}
                  value={values.routingNumber}
                  onChange={(e) => set('routingNumber', e.target.value.replaceAll(/\D/g, ''))}
                  placeholder="021000021"
                  aria-invalid={hasProblem('routingFormat') || hasProblem('routingChecksum') || undefined}
                  autoComplete="off"
                />
                {hasProblem('routingFormat') ? (
                  <p className="mt-1 text-xs text-destructive" role="alert">{tf.routingFormat}</p>
                ) : null}
                {hasProblem('routingChecksum') ? (
                  <p className="mt-1 text-xs text-destructive" role="alert">{tf.routingChecksum}</p>
                ) : null}
              </div>
              <div>
                <Label htmlFor="ba-account-number">{tf.accountNumberLabel}</Label>
                {hasStoredNumber && !replacingAccountNumber ? (
                  <div className="flex items-center gap-2 h-9">
                    <span className="font-mono text-sm" data-testid="stored-account-number">
                      {maskedAccountNumber(bankAccount?.accountNumberLast4)}
                    </span>
                    <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setReplacingAccountNumber(true)}>
                      {tf.replaceAccountNumber}
                    </Button>
                    <Button type="button" variant="link" size="sm" className="h-auto p-0 text-destructive" onClick={() => set('removeAccountNumber', true)}>
                      {tf.removeAccountNumber}
                    </Button>
                  </div>
                ) : null}
                {showAccountNumberInput ? (
                  <Input
                    id="ba-account-number"
                    value={values.accountNumber}
                    onChange={(e) => set('accountNumber', e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    data-1p-ignore
                    aria-invalid={hasProblem('accountNumber') || undefined}
                  />
                ) : null}
                {isEdit && values.removeAccountNumber ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {tf.accountNumberWillBeRemoved}{' '}
                    <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => set('removeAccountNumber', false)}>
                      {tf.keepAccountNumber}
                    </Button>
                  </p>
                ) : null}
                {hasProblem('accountNumber') ? (
                  <p className="mt-1 text-xs text-destructive" role="alert">{tf.accountNumberInvalid}</p>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">{tf.accountNumberHint}</p>
                )}
              </div>
            </div>
          ) : null}

          {isUs && !hasRoutingNumber(values.accountType) ? (
            <div>
              <Label htmlFor="ba-card-number">{tf.cardNumberLabel}</Label>
              {hasStoredNumber && !replacingAccountNumber ? (
                <div className="flex items-center gap-2 h-9">
                  <span className="font-mono text-sm">{maskedAccountNumber(bankAccount?.accountNumberLast4)}</span>
                  <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setReplacingAccountNumber(true)}>
                    {tf.replaceAccountNumber}
                  </Button>
                </div>
              ) : (
                <Input
                  id="ba-card-number"
                  value={values.accountNumber}
                  onChange={(e) => set('accountNumber', e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  aria-invalid={hasProblem('accountNumber') || undefined}
                />
              )}
              <p className="mt-1 text-xs text-muted-foreground">{tf.accountNumberHint}</p>
            </div>
          ) : null}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ba-bank">{t('sweep.weldbooks.bankAccountForm.bankNameLabel')}</Label>
              <Input
                id="ba-bank"
                value={values.bankName}
                onChange={(e) => set('bankName', e.target.value)}
                placeholder={isUs ? 'Chase' : 'ABN AMRO'}
              />
            </div>
            <div>
              <Label htmlFor="ba-holder">{t('sweep.weldbooks.bankAccountForm.accountHolderLabel')}</Label>
              <Input
                id="ba-holder"
                value={values.accountHolderName}
                onChange={(e) => set('accountHolderName', e.target.value)}
                placeholder={isUs ? 'Weld Corp LLC' : 'WeldCorp BV'}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>{t('sweep.weldbooks.currency')}</Label>
              <Select
                value={values.currency}
                onValueChange={(value) => {
                  currencyTouchedRef.current = true;
                  set('currency', value);
                }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {currencyOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c === 'INR' ? t('sweep.weldbooks.bankAccountForm.currencyInr') : c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t('sweep.weldbooks.bankAccountForm.ledgerAccountLabel')}</Label>
              <Select
                value={values.ledgerAccountId === NO_LEDGER_ACCOUNT && !isUs ? '' : values.ledgerAccountId}
                onValueChange={(v) => set('ledgerAccountId', v)}
              >
                <SelectTrigger data-testid="bank-account-ledger">
                  <SelectValue placeholder={t('sweep.weldbooks.reconciliationRuleForm.optionalPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {isUs && !isEdit ? (
                    <>
                      <SelectItem value={CREATE_LEDGER_ACCOUNT}>{tf.ledgerCreate}</SelectItem>
                      <SelectItem value={NO_LEDGER_ACCOUNT}>{tf.ledgerNone}</SelectItem>
                    </>
                  ) : null}
                  {ledgerOptions.length === 0 && !(isUs && !isEdit) ? (
                    <SelectItem value="_none" disabled>{t('sweep.weldbooks.bankAccountForm.noLedgerAccounts')}</SelectItem>
                  ) : (
                    ledgerOptions.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {isUs && !isEdit && values.ledgerAccountId === CREATE_LEDGER_ACCOUNT ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {liability ? tf.ledgerCreateHintLiability : tf.ledgerCreateHintAsset}
                </p>
              ) : null}
            </div>
          </div>

          {isUs && hasRoutingNumber(values.accountType) ? (
            <div className="sm:w-1/2">
              <Label htmlFor="ba-next-check">{tf.nextCheckNumberLabel}</Label>
              <Input
                id="ba-next-check"
                inputMode="numeric"
                value={values.nextCheckNumber}
                onChange={(e) => set('nextCheckNumber', e.target.value.replaceAll(/\D/g, ''))}
                placeholder="1001"
                aria-invalid={hasProblem('nextCheckNumber') || undefined}
              />
              <p className="mt-1 text-xs text-muted-foreground">{tf.nextCheckNumberHint}</p>
            </div>
          ) : null}

          <label className="flex items-center gap-2">
            <Checkbox checked={values.isDefault} onCheckedChange={(v) => set('isDefault', !!v)} />
            <span className="text-sm">{t('sweep.weldbooks.bankAccountForm.makeDefault')}</span>
          </label>

          <label className="flex items-center gap-2">
            <Checkbox checked={values.autoReconcile} onCheckedChange={(v) => set('autoReconcile', !!v)} />
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
          <Button onClick={handleSubmit} disabled={!values.name.trim() || pending}>
            {pending ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" />{t('sweep.weldbooks.saving')}</>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
