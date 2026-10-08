import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { useI18n } from '@/lib/i18n/provider';
import { usePayTaxReturn } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useBankAccounts } from '@/hooks/queries/use-weldbooks-banking-queries';
import { maskedAccountNumber } from '@/app/weldbooks/banking/components/routing-number';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import {
  isSalesTaxRequestError,
  salesTaxErrorDetails,
  type PaymentResult,
  type TaxReturnDetail,
} from '@/lib/api/domains/weldbooks-sales-tax-center';
import { Notice } from '../../shared/notice';
import { fill } from '../../shared/text';
import { paymentAmountProblem, paymentDifference, paymentNeedsReason, parseAmount, roundMoney } from '../return-model';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface PaymentMessages {
  bankRequired: string;
  amountRequired: string;
  dateRequired: string;
  reasonRequired: string;
  negativeNotAllowed: string;
  positiveNotAllowed: string;
}

/**
 * The payment form's rules: a bank account, an amount that is a number with the
 * sign the total due allows, a date, and a reason whenever the amount differs
 * from the total due.
 */
export function createPaymentSchema(messages: PaymentMessages, totalDue: number) {
  return z
    .object({
      bankAccountId: z.string().min(1, messages.bankRequired),
      amount: z
        .string()
        .trim()
        .min(1, messages.amountRequired)
        .refine((value) => parseAmount(value) !== null, messages.amountRequired),
      date: z.string().regex(DAY, messages.dateRequired),
      reference: z.string().max(255).optional(),
      differenceReason: z.string().max(500).optional(),
    })
    .superRefine((values, ctx) => {
      const amount = parseAmount(values.amount);
      if (amount === null) return;
      const problem = paymentAmountProblem(totalDue, amount);
      if (problem) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount'],
          message: problem === 'negative' ? messages.negativeNotAllowed : messages.positiveNotAllowed,
        });
      } else if (paymentNeedsReason(totalDue, amount) && !(values.differenceReason ?? '').trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['differenceReason'], message: messages.reasonRequired });
      }
    });
}

interface PaymentDialogProps {
  ret: TaxReturnDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the result once the payment is recorded. */
  onPaid?: (result: PaymentResult) => void;
}

/** Records the payment of a filed return: the bank account, the amount (with a reason when it differs), the date. */
export function PaymentDialog({ ret, open, onOpenChange, onPaid }: Readonly<PaymentDialogProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.salesTax.center.returnPage.paymentDialog;
  const { formatMoney, today } = useWeldbooksFormat();
  const pay = usePayTaxReturn(ret.id);
  // The server asked for a reason although the amount looked equal to the total due.
  const [serverWantsReason, setServerWantsReason] = useState(false);
  const totalDue = ret.totalDue;
  const bankQuery = useBankAccounts(undefined, { enabled: open });
  const bankAccounts = useMemo(() => (bankQuery.data?.data ?? []).filter((account) => account.isActive !== false), [bankQuery.data]);

  const schema = useMemo(
    () =>
      createPaymentSchema(
        {
          bankRequired: tp.bankRequired,
          amountRequired: tp.amountRequired,
          dateRequired: tp.dateRequired,
          reasonRequired: tp.reasonRequired,
          negativeNotAllowed: tp.negativeNotAllowed,
          positiveNotAllowed: tp.positiveNotAllowed,
        },
        totalDue,
      ),
    [tp, totalDue],
  );
  type Values = z.infer<typeof schema>;

  const defaults = useMemo<Values>(
    () => ({
      bankAccountId: '',
      amount: totalDue.toFixed(2),
      date: today(),
      reference: ret.confirmationNumber ?? '',
      differenceReason: '',
    }),
    [totalDue, today, ret.confirmationNumber],
  );

  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    setValue,
    getValues,
    setError,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });

  // Every opening starts from the total due, today and the return's confirmation number.
  useEffect(() => {
    if (open) {
      reset(defaults);
      setServerWantsReason(false);
    }
  }, [open, defaults, reset]);

  // The default bank account (or the first one that can be paid from) once the list is known.
  useEffect(() => {
    if (!open || getValues('bankAccountId')) return;
    const usable = bankAccounts.filter((account) => account.ledgerAccountId);
    const preferred = usable.find((account) => account.isDefault) ?? usable[0];
    if (preferred) setValue('bankAccountId', preferred.id);
  }, [open, bankAccounts, getValues, setValue]);

  const amountText = watch('amount');
  const amount = parseAmount(amountText ?? '');
  const differs = amount !== null && paymentNeedsReason(totalDue, amount);
  const difference = amount === null ? 0 : paymentDifference(totalDue, amount);

  const onSubmit = async (values: Values) => {
    const parsed = parseAmount(values.amount);
    if (parsed === null) return;
    try {
      const result = await pay.mutateAsync({
        bankAccountId: values.bankAccountId,
        amount: roundMoney(parsed),
        date: values.date,
        ...(values.reference?.trim() ? { reference: values.reference.trim() } : {}),
        ...(values.differenceReason?.trim() ? { differenceReason: values.differenceReason.trim() } : {}),
      });
      toast.success(tp.recorded);
      onOpenChange(false);
      onPaid?.(result);
    } catch (err) {
      // The server asks for a reason when the amounts differ (400 with the amounts as details).
      const details = salesTaxErrorDetails(err);
      if (isSalesTaxRequestError(err) && err.status === 400 && details && 'totalDue' in details && 'amount' in details) {
        setServerWantsReason(true);
        setError('differenceReason', { type: 'server', message: tp.reasonRequired });
        return;
      }
      toast.error(tp.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tp.title}</DialogTitle>
          <DialogDescription>{fill(tp.description, { agency: ret.agency.name })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="payment-bank">{tp.bankAccount}</Label>
            <Controller
              control={control}
              name="bankAccountId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="payment-bank" aria-invalid={Boolean(errors.bankAccountId)} data-testid="payment-bank">
                    <SelectValue placeholder={tp.bankPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {bankAccounts.map((account) => (
                      <SelectItem key={account.id} value={account.id} disabled={!account.ledgerAccountId}>
                        {account.name}
                        {account.accountNumberLast4 ? ` · ${maskedAccountNumber(account.accountNumberLast4)}` : ''}
                        {account.ledgerAccountId ? '' : ` (${tp.notLinked})`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.bankAccountId ? <p className="text-sm text-destructive">{errors.bankAccountId.message}</p> : null}
            {!bankQuery.isLoading && bankAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tp.noBankAccounts}</p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="payment-amount">{tp.amount}</Label>
              <Input
                id="payment-amount"
                inputMode="decimal"
                className="tabular-nums"
                aria-invalid={Boolean(errors.amount)}
                {...register('amount')}
              />
              {errors.amount ? (
                <p className="text-sm text-destructive">{errors.amount.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{fill(tp.totalDue, { amount: formatMoney(totalDue) })}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="payment-date">{tp.date}</Label>
              <Input id="payment-date" type="date" aria-invalid={Boolean(errors.date)} {...register('date')} />
              {errors.date ? <p className="text-sm text-destructive">{errors.date.message}</p> : null}
            </div>
          </div>

          {totalDue < 0 ? (
            <Notice tone="info">
              <p>{tp.creditHint}</p>
            </Notice>
          ) : null}

          {differs || serverWantsReason ? (
            <div className="space-y-2" data-testid="difference-section">
              {differs ? (
                <Notice tone="warning">
                  <p>{fill(tp.differenceHint, { amount: formatMoney(Math.abs(difference)) })}</p>
                </Notice>
              ) : null}
              <Label htmlFor="payment-reason">{tp.differenceReason}</Label>
              <Textarea
                id="payment-reason"
                rows={2}
                maxLength={500}
                placeholder={tp.differenceReasonPlaceholder}
                aria-invalid={Boolean(errors.differenceReason)}
                {...register('differenceReason')}
              />
              {errors.differenceReason ? (
                <p className="text-sm text-destructive">{errors.differenceReason.message}</p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="payment-reference">{tp.reference}</Label>
            <Input
              id="payment-reference"
              maxLength={255}
              placeholder={tp.referencePlaceholder}
              {...register('reference')}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.weldbooksUs.salesTax.center.common.cancel}
            </Button>
            <Button type="submit" disabled={pay.isPending}>
              {pay.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {pay.isPending ? tp.submitting : tp.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
