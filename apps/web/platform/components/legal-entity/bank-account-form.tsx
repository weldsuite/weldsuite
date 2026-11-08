/**
 * Bank account of a legal entity: the add/edit dialog (IBAN and BIC, or
 * routing and account number) and the reveal control. The full account number
 * never comes with the account: it is write-only, shown masked (`•••• 1234`)
 * and only leaves the API through the logged reveal call
 * (`legal_entities:reveal`), shown once.
 */

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Eye, EyeOff } from 'lucide-react';
import {
  BANK_ACCOUNT_TYPES,
  isValidAbaRouting,
  isValidIban,
  type LegalEntityBankAccount,
} from '@weldsuite/app-api-client/schemas/legal-entities';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useCan } from '@weldsuite/permissions/react';
import { useRevealBankAccountNumber, useSaveBankAccount } from '@/hooks/queries/use-legal-entities-queries';
import { currencyOptions } from '@/lib/weldbooks/currencies';
import { useI18n } from '@/lib/i18n/provider';

const NO_ACCOUNT_TYPE = '__none__';

/** `•••• 1234` for an account whose last four digits are known. */
export function maskedAccountNumber(account: Pick<LegalEntityBankAccount, 'hasAccountNumber' | 'accountNumberLast4'>): string | null {
  if (!account.hasAccountNumber) return null;
  return account.accountNumberLast4 ? `•••• ${account.accountNumberLast4}` : '••••';
}

interface RevealAccountNumberProps {
  entityId: string;
  account: LegalEntityBankAccount;
}

/**
 * The masked number with a "Show number" button behind `legal_entities:reveal`.
 * A revealed number lives in component state only and is dropped on hide.
 */
export function RevealAccountNumber({ entityId, account }: Readonly<RevealAccountNumberProps>) {
  const { t } = useI18n();
  const tb = t.settings.legalEntities.bankAccounts;
  const canReveal = useCan('legal_entities:reveal');
  const reveal = useRevealBankAccountNumber(entityId);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const masked = maskedAccountNumber(account);

  if (!masked) return null;

  async function show() {
    setError(null);
    try {
      const result = await reveal.mutateAsync({ accountId: account.id });
      setRevealed(result.accountNumber);
    } catch (err) {
      setError(err instanceof Error ? err.message : tb.revealFailed);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{revealed ?? masked}</span>
        {canReveal &&
          (revealed ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setRevealed(null)}>
              <EyeOff className="mr-2 h-4 w-4" />
              {tb.hide}
            </Button>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={show} disabled={reveal.isPending}>
              <Eye className="mr-2 h-4 w-4" />
              {reveal.isPending ? tb.revealing : tb.reveal}
            </Button>
          ))}
      </div>
      {revealed && <p className="text-xs text-muted-foreground">{tb.revealNote}</p>}
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
    </div>
  );
}

const formSchema = z.object({
  name: z.string(),
  accountHolderName: z.string(),
  bankName: z.string(),
  iban: z.string(),
  bic: z.string(),
  routingNumber: z.string(),
  accountNumber: z.string(),
  currency: z.string(),
  accountType: z.string(),
  isDefault: z.boolean(),
});
type FormValues = z.infer<typeof formSchema>;

function emptyValues(defaultCurrency: string): FormValues {
  return {
    name: '',
    accountHolderName: '',
    bankName: '',
    iban: '',
    bic: '',
    routingNumber: '',
    accountNumber: '',
    currency: defaultCurrency,
    accountType: NO_ACCOUNT_TYPE,
    isDefault: false,
  };
}

interface BankAccountFormProps {
  entityId: string;
  /** The account being edited; null adds a new one. */
  account: LegalEntityBankAccount | null;
  /** The entity's currency: the default currency of a new account. */
  defaultCurrency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BankAccountForm({ entityId, account, defaultCurrency, open, onOpenChange }: Readonly<BankAccountFormProps>) {
  const { t } = useI18n();
  const tb = t.settings.legalEntities.bankAccounts;
  const save = useSaveBankAccount(entityId);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const typeLabels = tb.accountTypes as Record<string, string>;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: emptyValues(defaultCurrency),
  });

  useEffect(() => {
    if (!open) return;
    setSubmitError(null);
    form.reset(
      account
        ? {
            name: account.name,
            accountHolderName: account.accountHolderName ?? '',
            bankName: account.bankName ?? '',
            iban: account.iban ?? '',
            bic: account.bic ?? '',
            routingNumber: account.routingNumber ?? '',
            accountNumber: '',
            currency: account.currency ?? defaultCurrency,
            accountType: account.accountType ?? NO_ACCOUNT_TYPE,
            isDefault: account.isDefault,
          }
        : emptyValues(defaultCurrency),
    );
  }, [open, account, defaultCurrency, form]);

  async function onSubmit(values: FormValues) {
    form.clearErrors();
    let invalid = false;
    const fail = (field: keyof FormValues, message: string) => {
      form.setError(field, { message });
      invalid = true;
    };
    const name = values.name.trim();
    const iban = values.iban.replaceAll(/\s/g, '').toUpperCase();
    const bic = values.bic.trim().toUpperCase();
    const routing = values.routingNumber.trim();
    const accountNumber = values.accountNumber.replaceAll(/[\s-]/g, '');
    if (!name) fail('name', tb.nameRequired);
    if (iban && !isValidIban(iban)) fail('iban', tb.invalidIban);
    if (bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) fail('bic', tb.invalidBic);
    if (routing && !isValidAbaRouting(routing)) fail('routingNumber', tb.invalidRouting);
    if (accountNumber && !/^[0-9A-Za-z]{4,34}$/.test(accountNumber)) fail('accountNumber', tb.invalidAccountNumber);
    if (invalid) return;

    const input = {
      name,
      accountHolderName: values.accountHolderName.trim() || null,
      bankName: values.bankName.trim() || null,
      iban: iban || null,
      bic: bic || null,
      routingNumber: routing || null,
      currency: values.currency,
      accountType: (values.accountType === NO_ACCOUNT_TYPE ? null : values.accountType) as
        | (typeof BANK_ACCOUNT_TYPES)[number]
        | null,
      isDefault: values.isDefault,
      // Write-only: an empty field leaves the stored number untouched.
      ...(accountNumber ? { accountNumber } : {}),
    };
    try {
      if (account) {
        await save.mutateAsync({ id: account.id, update: input });
      } else {
        await save.mutateAsync({ create: input });
      }
      toast.success(tb.saved);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : tb.failed);
    }
  }

  const currencies = currencyOptions(defaultCurrency, account?.currency);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{account ? tb.editTitle : tb.addTitle}</DialogTitle>
          <DialogDescription>{tb.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={submitError} onDismiss={() => setSubmitError(null)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tb.name}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={tb.namePlaceholder} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="accountHolderName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tb.accountHolder}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="bankName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tb.bankName}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tb.currency}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {currencies.map((code) => (
                          <SelectItem key={code} value={code}>
                            {code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="iban"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tb.iban}</FormLabel>
                    <FormControl>
                      <Input {...field} autoComplete="off" className="font-mono" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="bic"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tb.bic}</FormLabel>
                    <FormControl>
                      <Input {...field} autoComplete="off" className="font-mono" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="routingNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tb.routingNumber}</FormLabel>
                    <FormControl>
                      <Input {...field} autoComplete="off" className="font-mono" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="accountNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tb.accountNumber}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        autoComplete="off"
                        className="font-mono"
                        placeholder={account?.hasAccountNumber ? (maskedAccountNumber(account) ?? '') : ''}
                      />
                    </FormControl>
                    {account?.hasAccountNumber && (
                      <p className="text-xs text-muted-foreground">{tb.accountNumberKeep}</p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="accountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{tb.accountType}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NO_ACCOUNT_TYPE}>{tb.noAccountType}</SelectItem>
                        {BANK_ACCOUNT_TYPES.map((value) => (
                          <SelectItem key={value} value={value}>
                            {typeLabels[value] ?? value}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {account && (
              <div className="rounded-md border p-3">
                <RevealAccountNumber entityId={entityId} account={account} />
              </div>
            )}
            <FormField
              control={form.control}
              name="isDefault"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4 space-y-0">
                  <FormLabel>{tb.isDefault}</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {t.common.actions.save}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
