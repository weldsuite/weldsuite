/**
 * What a member can do with an order from its panel: take it to its next
 * status, record the payment, send a Mollie payment link, refund it, create its
 * WeldBooks invoice again, edit it, cancel it. Each shows only while it applies
 * (the order's own `editable` and `cancellable`, what has been paid) and the
 * member holds `orders:update`.
 */

import { useState } from 'react';
import { Banknote, CheckCircle2, FileText, Link2, Loader2, Pencil, Play, Truck, Undo2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { useUpdateCommerceOrder, type Order } from '@/hooks/queries/use-commerce-orders-queries';
import { useRetryOrderInvoice } from '@/hooks/queries/use-commerce-payments-queries';
import { getTranslations } from '@/lib/i18n';
import { nextOrderStatus, orderErrorMessage } from '@/app/weldcommerce/lib/orders';
import { canCreatePaymentLink, canRefund, orderInvoiceError, paymentErrorMessage } from '@/app/weldcommerce/lib/payments';
import { fill } from '@/app/weldcommerce/lib/text';
import { OrderEditDialog } from '@/app/weldcommerce/orders/components/order-edit-dialog';
import { CancelOrderDialog, MarkPaidDialog } from './order-dialogs';
import { PaymentLinkDialog, RefundDialog } from './order-payment-dialogs';

type NextStatus = NonNullable<ReturnType<typeof nextOrderStatus>>;

const STEP_ICONS = { confirmed: CheckCircle2, processing: Play, completed: Truck } as const;

/** An order that can still be paid: not cancelled, and not paid or refunded already. */
export function canMarkPaid(order: Order): boolean {
  return order.status !== 'cancelled' && ['pending', 'on_invoice', 'failed'].includes(order.paymentStatus);
}

/** The Mollie buttons: a payment link while money is owed, a refund while some can go back, the invoice again when it failed. */
function PaymentActions({
  order,
  invoicing,
  onLink,
  onRefund,
  onInvoice,
}: Readonly<{ order: Order; invoicing: boolean; onLink: () => void; onRefund: () => void; onInvoice: () => void }>) {
  const t = getTranslations('commerce').orders.payments.actions;
  return (
    <>
      {canCreatePaymentLink(order) && (
        <Button type="button" size="sm" variant="outline" onClick={onLink}>
          <Link2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t.paymentLink}
        </Button>
      )}
      {canRefund(order) && (
        <Button type="button" size="sm" variant="outline" onClick={onRefund}>
          <Undo2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {t.refund}
        </Button>
      )}
      {orderInvoiceError(order) && (
        <Button type="button" size="sm" variant="outline" disabled={invoicing} onClick={onInvoice}>
          {invoicing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FileText className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}
          {invoicing ? t.creatingInvoice : t.createInvoice}
        </Button>
      )}
    </>
  );
}

export function OrderActions({ order }: Readonly<{ order: Order }>) {
  const t = getTranslations('commerce').orders.actions;
  const permissions = usePermissionsMaybe();
  const canUpdate = permissions?.can('orders:update') ?? false;
  const update = useUpdateCommerceOrder();
  const [dialog, setDialog] = useState<'edit' | 'paid' | 'cancel' | 'link' | 'refund' | null>(null);
  const retryInvoice = useRetryOrderInvoice();

  if (!canUpdate) return null;

  const step = nextOrderStatus(order.status);
  const stepLabels: Record<NextStatus, string> = { confirmed: t.confirm, processing: t.process, completed: t.complete };
  const stepToasts: Record<NextStatus, string> = {
    confirmed: t.toastConfirmed,
    processing: t.toastProcessing,
    completed: t.toastCompleted,
  };
  const StepIcon = step ? STEP_ICONS[step] : null;
  const isFinished = order.status === 'cancelled' || order.status === 'completed';

  const advance = async (status: NextStatus) => {
    try {
      await update.mutateAsync({ id: order.id, data: { status } });
      toast.success(stepToasts[status]);
    } catch (err) {
      toast.error(orderErrorMessage(err, getTranslations('commerce').orders.errors.generic));
    }
  };

  const createInvoice = async () => {
    const tp = getTranslations('commerce').orders.payments.actions;
    try {
      const res = await retryInvoice.mutateAsync(order.id);
      toast.success(res.data.number ? fill(tp.toastInvoiceCreated, { number: res.data.number }) : tp.toastInvoiceCreatedNoNumber);
    } catch (err) {
      toast.error(paymentErrorMessage(err, getTranslations('commerce').orders.errors.generic, order.currency));
    }
  };

  return (
    <div className="space-y-2 px-4 pt-3">
      <div className="flex flex-wrap gap-2">
        {step && StepIcon && (
          <Button type="button" size="sm" disabled={update.isPending} onClick={() => void advance(step)}>
            <StepIcon className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {stepLabels[step]}
          </Button>
        )}
        {canMarkPaid(order) && (
          <Button type="button" size="sm" variant="outline" onClick={() => setDialog('paid')}>
            <Banknote className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t.markPaid}
          </Button>
        )}
        <PaymentActions
          order={order}
          invoicing={retryInvoice.isPending}
          onLink={() => setDialog('link')}
          onRefund={() => setDialog('refund')}
          onInvoice={() => void createInvoice()}
        />
        {order.status !== 'cancelled' && (
          <Button type="button" size="sm" variant="outline" onClick={() => setDialog('edit')}>
            <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t.edit}
          </Button>
        )}
        {order.cancellable && (
          <Button type="button" size="sm" variant="outline" onClick={() => setDialog('cancel')}>
            <XCircle className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {t.cancel}
          </Button>
        )}
      </div>
      {!order.editable && !isFinished && <p className="text-xs text-muted-foreground">{t.notEditable}</p>}

      {dialog === 'edit' && <OrderEditDialog order={order} open onOpenChange={(open) => !open && setDialog(null)} />}
      {dialog === 'paid' && <MarkPaidDialog order={order} open onOpenChange={(open) => !open && setDialog(null)} />}
      {dialog === 'link' && <PaymentLinkDialog order={order} open onOpenChange={(open) => !open && setDialog(null)} />}
      {dialog === 'refund' && <RefundDialog order={order} open onOpenChange={(open) => !open && setDialog(null)} />}
      {dialog === 'cancel' && <CancelOrderDialog order={order} open onOpenChange={(open) => !open && setDialog(null)} />}
    </div>
  );
}
