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
import { useRecordInvoicePayment } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
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
  });
}

type PaymentFormValues = z.infer<ReturnType<typeof createPaymentSchema>>;

interface RecordPaymentDialogProps {
  invoiceId: string;
  balanceDue: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RecordPaymentDialog({
  invoiceId,
  balanceDue,
  open,
  onOpenChange,
}: Readonly<RecordPaymentDialogProps>) {
  const recordPayment = useRecordInvoicePayment();
  const { t } = useI18n();
  const st = useTranslations();
  const tr = t.accounting.recordPayment;
  const methodLabels = t.accounting.paymentMethods;
  const paymentSchema = useMemo(() => createPaymentSchema(st), [st]);
  const { today } = useWeldbooksFormat();
  const { code: jurisdictionCode } = useCurrentJurisdiction();

  const defaults = useMemo<PaymentFormValues>(
    () => ({
      amount: balanceDue,
      date: today(),
      paymentMethod: defaultPaymentMethod(jurisdictionCode),
      checkNumber: '',
      reference: '',
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
  const isCheck = paymentMethod === 'check';

  const onSubmit = (data: PaymentFormValues) => {
    if (!isPaymentMethod(data.paymentMethod)) return;
    recordPayment.mutate(
      {
        id: invoiceId,
        data: {
          amount: data.amount,
          date: data.date,
          paymentMethod: data.paymentMethod,
          checkNumber: data.paymentMethod === 'check' && data.checkNumber?.trim() ? data.checkNumber.trim() : undefined,
          reference: data.reference?.trim() ? data.reference.trim() : undefined,
        },
      },
      {
        onSuccess: () => {
          toast.success(tr.recorded);
          onOpenChange(false);
        },
        onError: (err) => {
          toast.error(tr.failed, { description: err instanceof Error ? err.message : undefined });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr.title}</DialogTitle>
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
            <Button type="submit" disabled={recordPayment.isPending}>
              {recordPayment.isPending ? tr.recording : tr.recordPayment}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
