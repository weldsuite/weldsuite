/**
 * The order panel's payment dialogs (phase 5): a Mollie payment link for what
 * the customer still owes (shown once created, with a copy button), and a
 * refund through Mollie (amount defaulting to what can still be refunded, and
 * a reason). The API's refusals are shown in words: `REFUND_TOO_LARGE` on the
 * amount field with what is left, the others as a toast.
 */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';
import {
  useCreatePaymentLink,
  useCreateRefund,
  useOrderPayments,
  type OrderPayment,
} from '@/hooks/queries/use-commerce-payments-queries';
import { formSchemaOptions } from '@/app/weldstash/lib/form';
import { getTranslations } from '@/lib/i18n';
import { CopyBox } from '@/app/weldcommerce/lib/copy-box';
import { apiErrorInfo, hasErrorCode, money } from '@/app/weldcommerce/lib/orders';
import {
  fromCents,
  httpsUrl,
  outstandingAmount,
  paymentErrorMessage,
  refundableAmount,
  toCents,
} from '@/app/weldcommerce/lib/payments';
import { fill } from '@/app/weldcommerce/lib/text';

type DialogProps = Readonly<{ order: Order; open: boolean; onOpenChange: (open: boolean) => void }>;

/** An unpaid Mollie payment that still has a link to pay on. */
function openLinkPayment(payments: OrderPayment[] | undefined): OrderPayment | undefined {
  return payments?.find((payment) => ['open', 'pending'].includes(payment.status) && httpsUrl(payment.checkoutUrl));
}

function LinkBox({ payment }: Readonly<{ payment: OrderPayment }>) {
  const t = getTranslations('commerce').orders.payments.linkDialog;
  const url = httpsUrl(payment.checkoutUrl);
  if (!url) return null;
  return (
    <div className="space-y-2">
      <CopyBox value={url} label={t.linkLabel} labels={t} rows={3} testId="payment-link" />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 rounded-sm text-sm text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        {t.open}
      </a>
      {payment.testmode && <p className="text-xs text-muted-foreground">{t.testHint}</p>}
    </div>
  );
}

export function PaymentLinkDialog({ order, open, onOpenChange }: DialogProps) {
  const t = getTranslations('commerce').orders.payments.linkDialog;
  const generic = getTranslations('commerce').orders.errors.generic;
  const payments = useOrderPayments(order.id);
  const create = useCreatePaymentLink();
  const [created, setCreated] = useState<OrderPayment | null>(null);
  const existing = openLinkPayment(payments.data?.data.payments);
  const shown = created ?? existing;
  const createLabel = shown ? t.createNew : t.create;

  const makeLink = async () => {
    try {
      const res = await create.mutateAsync(order.id);
      setCreated(res.data);
      toast.success(t.toastCreated);
    } catch (err) {
      toast.error(paymentErrorMessage(err, generic, order.currency));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{fill(t.title, { number: order.orderNumber })}</DialogTitle>
          <DialogDescription>{fill(t.description, { total: money(outstandingAmount(order), order.currency) })}</DialogDescription>
        </DialogHeader>
        {existing && !created && <InfoBanner variant="info">{t.existing}</InfoBanner>}
        {shown && <LinkBox payment={shown} />}
        <DialogFooter>
          {!created && (
            <Button type="button" variant={shown ? 'outline' : 'default'} disabled={create.isPending} onClick={() => void makeLink()}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {create.isPending ? t.creating : createLabel}
            </Button>
          )}
          <Button type="button" variant={shown ? 'default' : 'outline'} onClick={() => onOpenChange(false)}>
            {t.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

interface RefundFormValues {
  amount: string;
  reason: string;
}

function buildRefundSchema(refundable: string, currency: string) {
  const t = getTranslations('commerce').orders.payments.refundDialog;
  const limit = toCents(refundable);
  return z.object({
    amount: z.string().superRefine((value, ctx) => {
      const cents = toCents(value);
      if (Number.isNaN(cents)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: t.amountInvalid });
      else if (cents <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: t.amountZero });
      else if (cents > limit) ctx.addIssue({ code: z.ZodIssueCode.custom, message: fill(t.amountTooLarge, { refundable: money(refundable, currency) }) });
    }),
    reason: z.string().trim().max(500),
  });
}

export function RefundDialog({ order, open, onOpenChange }: DialogProps) {
  const t = getTranslations('commerce').orders.payments.refundDialog;
  const common = getTranslations('common');
  const refund = useCreateRefund();
  const refundable = refundableAmount(order);
  const schema = useMemo(() => buildRefundSchema(refundable, order.currency), [refundable, order.currency]);
  const form = useForm<RefundFormValues>({
    resolver: zodResolver(schema, formSchemaOptions()),
    defaultValues: { amount: refundable, reason: '' },
  });

  const onSubmit = async (values: RefundFormValues) => {
    const amount = fromCents(toCents(values.amount));
    try {
      await refund.mutateAsync({
        orderId: order.id,
        data: { amount, ...(values.reason.trim() ? { reason: values.reason.trim() } : {}) },
      });
      toast.success(fill(t.toastRefunded, { amount: money(amount, order.currency) }));
      onOpenChange(false);
    } catch (err) {
      const left = apiErrorInfo(err).details?.refundable;
      if (hasErrorCode(err, 'REFUND_TOO_LARGE') && typeof left === 'string') {
        form.setError('amount', { message: fill(t.amountTooLarge, { refundable: money(left, order.currency) }) }, { shouldFocus: true });
        return;
      }
      toast.error(paymentErrorMessage(err, getTranslations('commerce').orders.errors.generic, order.currency));
    }
  };

  const submitting = form.formState.isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{fill(t.title, { number: order.orderNumber })}</DialogTitle>
          <DialogDescription>{fill(t.description, { refundable: money(refundable, order.currency) })}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem className="sm:max-w-xs">
                  <FormLabel>
                    {t.amount} ({order.currency})
                  </FormLabel>
                  <FormControl>
                    <Input {...field} required inputMode="decimal" autoComplete="off" enterKeyHint="next" className="tabular-nums" />
                  </FormControl>
                  <FormDescription>{fill(t.amountHint, { refundable: money(refundable, order.currency) })}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.reason}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={3} maxLength={500} placeholder={t.reasonPlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {common.actions.cancel}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {submitting ? t.submitting : t.submit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
