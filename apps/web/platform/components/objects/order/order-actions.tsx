/**
 * What a member can do with an order from its panel: take it to its next
 * status, record the payment, edit it, cancel it. Each shows only while it
 * applies (the order's own `editable` and `cancellable`) and the member holds
 * `orders:update`.
 */

import { useState } from 'react';
import { Banknote, CheckCircle2, Pencil, Play, Truck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { useUpdateCommerceOrder, type Order } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { nextOrderStatus, orderErrorMessage } from '@/app/weldcommerce/lib/orders';
import { OrderEditDialog } from '@/app/weldcommerce/orders/components/order-edit-dialog';
import { CancelOrderDialog, MarkPaidDialog } from './order-dialogs';

type NextStatus = NonNullable<ReturnType<typeof nextOrderStatus>>;

const STEP_ICONS = { confirmed: CheckCircle2, processing: Play, completed: Truck } as const;

/** An order that can still be paid: not cancelled, and not paid or refunded already. */
export function canMarkPaid(order: Order): boolean {
  return order.status !== 'cancelled' && ['pending', 'on_invoice', 'failed'].includes(order.paymentStatus);
}

export function OrderActions({ order }: Readonly<{ order: Order }>) {
  const t = getTranslations('commerce').orders.actions;
  const permissions = usePermissionsMaybe();
  const canUpdate = permissions?.can('orders:update') ?? false;
  const update = useUpdateCommerceOrder();
  const [dialog, setDialog] = useState<'edit' | 'paid' | 'cancel' | null>(null);

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
      {dialog === 'cancel' && <CancelOrderDialog order={order} open onOpenChange={(open) => !open && setDialog(null)} />}
    </div>
  );
}
