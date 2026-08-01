import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createOrderSchema, type CreateOrderInput } from '@weldsuite/core-api-client/schemas/orders';
import {
  useCreateCommerceOrder,
  useUpdateCommerceOrder,
  type CommerceOrder,
} from '@/hooks/queries/use-commerce-queries';
import { useCompanies } from '@/components/objects/company/use-company-data';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { ORDER_STATUS_OPTIONS, orderStatusLabel } from '../config/order-columns';

type FormValues = z.input<typeof createOrderSchema>;
/** What the resolver hands `onSubmit` — already parsed, so no second parse. */
type SubmitValues = z.output<typeof createOrderSchema>;

const NO_CUSTOMER = '__none__';

/**
 * `valueAsNumber` turns an empty input into NaN, which an optional Zod number
 * rejects — and because `handleSubmit` then never calls `onSubmit`, the user
 * sees a Save button that silently does nothing. Map blank to undefined so the
 * field reads as "not provided".
 */
const optionalNumber = { setValueAs: (v: unknown) => (v === '' || v == null ? undefined : Number(v)) };

/**
 * Without this, `handleSubmit` blocks on a validation failure and nothing on
 * screen changes — the Save button just appears dead.
 */
function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-xs text-destructive">{message}</p>;
}

export function OrderDialog({
  open,
  onOpenChange,
  order,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order?: CommerceOrder;
}) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const isEdit = !!order;
  const create = useCreateCommerceOrder();
  const update = useUpdateCommerceOrder();
  const { data: companies } = useCompanies({ limit: 100 });

  const form = useForm<FormValues>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: order
      ? {
          orderNumber: order.orderNumber ?? undefined,
          customerId: order.customerId ?? undefined,
          status: order.status ?? 'pending',
          currency: order.currency ?? undefined,
          subtotal: order.subtotal != null ? Number(order.subtotal) : undefined,
          taxTotal: order.taxTotal != null ? Number(order.taxTotal) : undefined,
          total: order.total != null ? Number(order.total) : undefined,
        }
      : { status: 'pending' },
  });
  const { errors } = form.formState;

  const onSubmit = async (values: SubmitValues) => {
    try {
      // zodResolver already parsed and applied transforms; parsing again would
      // re-run them on their own output.
      const parsed = values as CreateOrderInput;
      if (isEdit && order) {
        await update.mutateAsync({ id: order.id, data: parsed });
        toast.success(t.orders.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(t.orders.toastCreated);
      }
      onOpenChange(false);
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.common.saveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.orders.editTitle : t.orders.newTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="orderNumber">{t.fields.orderNumber}</Label>
              <Input id="orderNumber" {...form.register('orderNumber')} />
              <FieldError message={errors.orderNumber?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="status">{t.fields.status}</Label>
              <Select
                defaultValue={order?.status ?? 'pending'}
                onValueChange={(v) => form.setValue('status', v)}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ORDER_STATUS_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>{orderStatusLabel(s)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="customerId">{t.fields.customer}</Label>
            <Select
              defaultValue={order?.customerId ?? NO_CUSTOMER}
              onValueChange={(v) => form.setValue('customerId', v === NO_CUSTOMER ? undefined : v)}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CUSTOMER}>{t.orders.noCustomer}</SelectItem>
                {(companies?.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.customerId?.message} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="subtotal">{t.fields.subtotal}</Label>
              <Input id="subtotal" type="number" step="0.01" {...form.register('subtotal', optionalNumber)} />
              <FieldError message={errors.subtotal?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="taxTotal">{t.fields.tax}</Label>
              <Input id="taxTotal" type="number" step="0.01" {...form.register('taxTotal', optionalNumber)} />
              <FieldError message={errors.taxTotal?.message} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="total">{t.fields.total}</Label>
              <Input id="total" type="number" step="0.01" {...form.register('total', optionalNumber)} />
              <FieldError message={errors.total?.message} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="currency">{t.fields.currency}</Label>
            <Input id="currency" placeholder="EUR" {...form.register('currency')} />
            <FieldError message={errors.currency?.message} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {tc.actions.cancel}
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {isEdit ? tc.actions.save : tc.actions.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
