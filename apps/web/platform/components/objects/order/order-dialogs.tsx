/**
 * The order panel's two dialogs: cancelling (a reason, behind a confirmation)
 * and recording a payment.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCancelCommerceOrder,
  useMarkCommerceOrderPaid,
  type Order,
} from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { money, orderErrorMessage } from '@/app/weldcommerce/lib/orders';
import { fill } from '@/app/weldcommerce/lib/text';

export function CancelOrderDialog({
  order,
  open,
  onOpenChange,
}: Readonly<{ order: Order; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = getTranslations('commerce').orders;
  const tc = t.cancelDialog;
  const cancel = useCancelCommerceOrder();
  const [reason, setReason] = useState('');

  const confirm = async () => {
    try {
      await cancel.mutateAsync({ id: order.id, reason: reason.trim() || undefined });
      toast.success(t.actions.toastCancelled);
      onOpenChange(false);
    } catch (err) {
      toast.error(orderErrorMessage(err, t.errors.generic));
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason('');
        onOpenChange(next);
      }}
      variant="destructive"
      title={fill(tc.title, { number: order.orderNumber })}
      description={
        <span className="block space-y-3">
          <span className="block">{tc.description}</span>
          <label className="block space-y-1.5">
            <span className="block text-sm font-medium text-foreground">{tc.reasonLabel}</span>
            <Textarea
              rows={3}
              maxLength={1000}
              value={reason}
              placeholder={tc.reasonPlaceholder}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </span>
      }
      confirmLabel={tc.confirm}
      cancelLabel={tc.keep}
      onConfirm={confirm}
    />
  );
}

const paidSchema = z.object({
  paidAt: z.string(),
  paymentMethod: z.string().max(100),
  paymentReference: z.string().max(255),
});
type PaidValues = z.infer<typeof paidSchema>;

function todayInput(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A calendar day from the date input as the start of that day, in ISO; undefined when blank. */
function dayToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function MarkPaidDialog({
  order,
  open,
  onOpenChange,
}: Readonly<{ order: Order; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = getTranslations('commerce').orders;
  const tp = t.paidDialog;
  const common = getTranslations('common');
  const markPaid = useMarkCommerceOrderPaid();
  const form = useForm<PaidValues>({
    resolver: zodResolver(paidSchema),
    defaultValues: { paidAt: todayInput(), paymentMethod: '', paymentReference: '' },
  });

  const onSubmit = async (values: PaidValues) => {
    try {
      await markPaid.mutateAsync({
        id: order.id,
        data: {
          paidAt: dayToIso(values.paidAt),
          paymentMethod: values.paymentMethod.trim() || undefined,
          paymentReference: values.paymentReference.trim() || undefined,
        },
      });
      toast.success(t.actions.toastPaid);
      onOpenChange(false);
    } catch (err) {
      toast.error(orderErrorMessage(err, t.errors.generic));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{fill(tp.title, { number: order.orderNumber })}</DialogTitle>
          <DialogDescription>{fill(tp.description, { total: money(order.total, order.currency) })}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
            <FormField
              control={form.control}
              name="paidAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tp.paidAt}</FormLabel>
                  <FormControl>
                    <Input {...field} type="date" max={todayInput()} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="paymentMethod"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tp.method}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" placeholder={tp.methodPlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="paymentReference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tp.reference}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="off" spellCheck={false} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {common.actions.cancel}
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {tp.confirm}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
