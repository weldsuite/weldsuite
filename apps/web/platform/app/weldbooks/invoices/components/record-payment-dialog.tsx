import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useBankAccounts,
  useRecordBillPaymentWithTarget,
  useRecordInvoicePaymentWithTarget,
} from '@/hooks/queries/use-weldbooks-banking-queries';
import { depositBankAccounts } from '@/app/weldbooks/deposits/deposit-math';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { Link } from '@/lib/router';
import { maskedAccountNumber } from '@/app/weldbooks/banking/components/routing-number';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isForeignCurrency, parseExchangeRateInput } from '@/lib/weldbooks/currencies';
import {
  defaultPaymentMethod,
  isPaymentMethod,
  paymentMethodsFor,
} from '@/lib/weldbooks/payment-methods';

function createPaymentSchema(st: (key: string) => string) {
  return z.object({
    amount: z.string().min(1, st('sweep.weldbooks.recordPayment.amountRequired')),
    date: z.string().min(1, st('sweep.weldbooks.recordPayment.dateRequired')),
    paymentMethod: z
      .string()
      .min(1, st('sweep.weldbooks.recordPayment.paymentMethodRequired'))
      // Explicit `boolean` so TS doesn't infer a type predicate and narrow the form type.
      .refine((value: string): boolean => isPaymentMethod(value), st('sweep.weldbooks.recordPayment.paymentMethodRequired')),
    checkNumber: z.string().max(30).optional(),
    reference: z.string().optional(),
    /** `undeposited` (US Undeposited Funds) or the id of the bank account; empty = the default one. */
    depositTo: z.string().optional(),
    /** Foreign-currency invoice: the rate of the payment; empty = the rate of the payment date. */
    exchangeRate: z.string().optional(),
  });
}

/** Select value of "Undeposited Funds" in the deposit-to choice. */
const UNDEPOSITED = 'undeposited';

type PaymentFormValues = z.infer<ReturnType<typeof createPaymentSchema>>;

/** What the payment is recorded against: an invoice (money in) or a bill (money out). */
export interface RecordPaymentTarget {
  type: 'invoice' | 'bill';
  id: string;
}

interface RecordPaymentDialogProps {
  target: RecordPaymentTarget;
  balanceDue: string;
  /** The invoice's currency: a foreign one can be paid at a rate of its own. */
  currency?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A credit note: the money goes back to the customer (the API books a refund). */
  refund?: boolean;
}

export function RecordPaymentDialog({
  target,
  balanceDue,
  currency,
  open,
  onOpenChange,
  refund = false,
}: Readonly<RecordPaymentDialogProps>) {
  const recordInvoicePayment = useRecordInvoicePaymentWithTarget();
  const recordBillPayment = useRecordBillPaymentWithTarget();
  const isBill = target.type === 'bill';
  const isPending = isBill ? recordBillPayment.isPending : recordInvoicePayment.isPending;
  const { t } = useI18n();
  const st = useTranslations();
  const tr = t.accounting.recordPayment;
  const tu = t.weldbooksUs.banking.recordPayment;
  const methodLabels = t.accounting.paymentMethods;
  const paymentSchema = useMemo(() => createPaymentSchema(st), [st]);
  const { today, entityCurrency } = useWeldbooksFormat();
  const foreignCurrency = isForeignCurrency(entityCurrency, currency);
  const { code: jurisdictionCode } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(jurisdictionCode);
  const { data: bankAccountsRes } = useBankAccounts(undefined, { enabled: open });
  const depositAccounts = depositBankAccounts(bankAccountsRes?.data ?? []);
  const defaultBankAccountId = (depositAccounts.find((account) => account.isDefault) ?? depositAccounts[0])?.id;

  const defaults = useMemo<PaymentFormValues>(
    () => ({
      amount: balanceDue,
      date: today(),
      paymentMethod: defaultPaymentMethod(jurisdictionCode),
      checkNumber: '',
      reference: '',
      depositTo: '',
      exchangeRate: '',
    }),
    [balanceDue, today, jurisdictionCode],
  );

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: defaults,
  });

  // Start every opening from the current balance, today and the entity's usual method.
  useEffect(() => {
    if (open) reset(defaults);
  }, [open, defaults, reset]);

  const paymentMethod = watch('paymentMethod');
  const methods = paymentMethodsFor(jurisdictionCode, paymentMethod);
  const isCheck = paymentMethod === 'check' && !isBill;
  // A check or cash payment received on a US entity can wait in Undeposited Funds, unless it goes straight to a bank account.
  const offerUndeposited = !isBill && !refund && isUs && (paymentMethod === 'check' || paymentMethod === 'cash');
  // The money always goes to (or comes from) a bank account: the chosen one, else Undeposited Funds or the default account.
  const chosenDepositTo = watch('depositTo');
  const depositTo =
    chosenDepositTo && (chosenDepositTo !== UNDEPOSITED || offerUndeposited)
      ? chosenDepositTo
      : offerUndeposited
        ? UNDEPOSITED
        : (defaultBankAccountId ?? '');
  const noBankAccounts = depositAccounts.length === 0;

  const onSubmit = (data: PaymentFormValues) => {
    if (!isPaymentMethod(data.paymentMethod)) return;
    const rate = foreignCurrency ? parseExchangeRateInput(data.exchangeRate) : null;
    if (rate === undefined) {
      toast.error(t.accounting.documentCurrency.exchangeRateInvalid);
      return;
    }
    const bankAccountId = depositTo && depositTo !== UNDEPOSITED ? depositTo : undefined;
    const reference = data.reference?.trim() ? data.reference.trim() : undefined;
    const callbacks = {
      onSuccess: () => {
        toast.success(refund ? tr.refundRecorded : tr.recorded);
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        toast.error(refund ? tr.refundFailed : tr.failed, { description: err instanceof Error ? err.message : undefined });
      },
    };
    if (isBill) {
      recordBillPayment.mutate(
        { id: target.id, data: { amount: data.amount, date: data.date, paymentMethod: data.paymentMethod, reference, bankAccountId } },
        callbacks,
      );
      return;
    }
    recordInvoicePayment.mutate(
      {
        id: target.id,
        data: {
          amount: data.amount,
          date: data.date,
          paymentMethod: data.paymentMethod,
          checkNumber: data.paymentMethod === 'check' && data.checkNumber?.trim() ? data.checkNumber.trim() : undefined,
          reference,
          exchangeRate: rate ? String(rate) : undefined,
          bankAccountId,
        },
      },
      callbacks,
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{refund ? tr.refundTitle : tr.title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="amount">{tr.amount}</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              inputMode="decimal"
              {...register('amount')}
            />
            {errors.amount && (
              <p className="text-sm text-destructive">{errors.amount.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="date">{tr.date}</Label>
            <Input id="date" type="date" {...register('date')} />
            {errors.date && (
              <p className="text-sm text-destructive">{errors.date.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="paymentMethod">{tr.paymentMethod}</Label>
            <Controller
              control={control}
              name="paymentMethod"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="paymentMethod">
                    <SelectValue placeholder={tr.selectMethod} />
                  </SelectTrigger>
                  <SelectContent>
                    {methods.map((method) => (
                      <SelectItem key={method} value={method}>
                        {methodLabels[method]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.paymentMethod && (
              <p className="text-sm text-destructive">
                {errors.paymentMethod.message}
              </p>
            )}
          </div>

          {isCheck && (
            <div className="space-y-2">
              <Label htmlFor="checkNumber">{tr.checkNumber}</Label>
              <Input
                id="checkNumber"
                placeholder={tr.checkNumberPlaceholder}
                maxLength={30}
                {...register('checkNumber')}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="depositTo">{isBill || refund ? st('sweep.weldbooks.records.payFrom') : tu.depositTo}</Label>
            {noBankAccounts && !offerUndeposited ? (
              <p className="text-xs text-muted-foreground" data-testid="no-bank-account-hint">
                {st('sweep.weldbooks.records.noBankAccountHint')}{' '}
                <Link href="/weldbooks/banking" className="font-medium text-primary underline-offset-4 hover:underline">
                  {st('sweep.weldbooks.records.addBankAccount')}
                </Link>
              </p>
            ) : (
              <div className="space-y-2">
              <Controller
                control={control}
                name="depositTo"
                render={({ field }) => (
                  <Select value={depositTo} onValueChange={field.onChange}>
                    <SelectTrigger id="depositTo" data-testid="deposit-to">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {offerUndeposited ? <SelectItem value={UNDEPOSITED}>{tu.undepositedFunds}</SelectItem> : null}
                      {depositAccounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.name}
                          {account.accountNumberLast4 ? ` · ${maskedAccountNumber(account.accountNumberLast4)}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {offerUndeposited ? (
                <p className="text-xs text-muted-foreground">
                  {depositTo === UNDEPOSITED ? tu.undepositedHint : tu.bankHint}
                </p>
              ) : null}
              </div>
            )}
          </div>

          {foreignCurrency && (
            <div className="space-y-2">
              <Label htmlFor="exchangeRate">{t.accounting.documentCurrency.exchangeRate}</Label>
              <Input
                id="exchangeRate"
                inputMode="decimal"
                placeholder={t.accounting.documentCurrency.exchangeRateAutomatic}
                {...register('exchangeRate')}
              />
              <p className="text-xs text-muted-foreground">
                {t.accounting.documentCurrency.exchangeRateHelp
                  .replace('{base}', entityCurrency ?? '')
                  .replace('{currency}', currency ?? '')}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="reference">{tr.reference}</Label>
            <Input id="reference" {...register('reference')} />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tr.cancel}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? tr.recording : refund ? tr.refundTitle : tr.recordPayment}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
