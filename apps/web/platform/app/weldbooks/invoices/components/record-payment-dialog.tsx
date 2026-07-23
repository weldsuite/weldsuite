import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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

function createPaymentSchema(st: (key: string) => string) {
  return z.object({
    amount: z.string().min(1, st('sweep.weldbooks.recordPayment.amountRequired')),
    date: z.string().min(1, st('sweep.weldbooks.recordPayment.dateRequired')),
    paymentMethod: z.string().min(1, st('sweep.weldbooks.recordPayment.paymentMethodRequired')),
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
}: RecordPaymentDialogProps) {
  const recordPayment = useRecordInvoicePayment();
  const { t } = useI18n();
  const st = useTranslations();
  const tr = t.accounting.recordPayment;
  const paymentSchema = useMemo(() => createPaymentSchema(st), [st]);

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      amount: balanceDue,
      date: new Date().toISOString().split('T')[0],
      paymentMethod: 'bank_transfer',
      reference: '',
    },
  });

  const onSubmit = (data: PaymentFormValues) => {
    recordPayment.mutate(
      { id: invoiceId, data },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
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
            <Select
              defaultValue="bank_transfer"
              onValueChange={(value) => setValue('paymentMethod', value)}
            >
              <SelectTrigger>
                <SelectValue placeholder={tr.selectMethod} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bank_transfer">{tr.methods.bankTransfer}</SelectItem>
                <SelectItem value="cash">{tr.methods.cash}</SelectItem>
                <SelectItem value="card">{tr.methods.card}</SelectItem>
                <SelectItem value="ideal">{tr.methods.ideal}</SelectItem>
              </SelectContent>
            </Select>
            {errors.paymentMethod && (
              <p className="text-sm text-destructive">
                {errors.paymentMethod.message}
              </p>
            )}
          </div>

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
