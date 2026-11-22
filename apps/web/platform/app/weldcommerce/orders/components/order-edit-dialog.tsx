import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { fill } from '../../lib/text';
import { OrderForm } from './order-form';

/** The order form in a wide dialog, for changing an order from its panel. */
export function OrderEditDialog({
  order,
  open,
  onOpenChange,
}: Readonly<{ order: Order; open: boolean; onOpenChange: (open: boolean) => void }>) {
  const t = getTranslations('commerce').orders.form;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{fill(t.editTitle, { number: order.orderNumber })}</DialogTitle>
        </DialogHeader>
        <OrderForm
          order={order}
          defaultCurrency={order.currency}
          onSaved={() => onOpenChange(false)}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
