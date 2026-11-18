import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { createOrderSchema, type CreateOrderInput } from '@weldsuite/core-api-client/schemas/orders';
import {
  useCreateCommerceOrder,
  useUpdateCommerceOrder,
  type CommerceOrder,
} from '@/hooks/queries/use-commerce-queries';
import { useCompanies } from '@/components/objects/company/use-company-data';
import { Button } from '@weldsuite/ui/components/button';
import { FieldError } from '@weldsuite/ui/components/field';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { CURRENCY_CODE, commerceSchemaOptions, currencyInput, optionalNumber } from '../../lib/form';
import { useCommerceDefaults } from '../../lib/use-commerce-defaults';
import { ORDER_STATUS_OPTIONS, orderStatusLabel } from '../config/order-columns';

/**
 * The API's order schema as this form fills it: the currency is a required
 * three-letter code (the column holds three characters, and an order without
 * one shows a bare amount), and the amounts are numbers of zero or more.
 */
const orderFormSchema = createOrderSchema.extend({
  currency: z.string().regex(CURRENCY_CODE),
  subtotal: z.number().min(0).optional(),
  taxTotal: z.number().min(0).optional(),
  total: z.number().min(0).optional(),
});

type FormValues = z.input<typeof orderFormSchema>;
/** What the resolver hands `onSubmit` — already parsed, so no second parse. */
type SubmitValues = z.output<typeof orderFormSchema>;

const NO_CUSTOMER = '__none__';

export function OrderDialog({
  open,
  onOpenChange,
  order,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order?: CommerceOrder;
}>) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const isEdit = !!order;
  const create = useCreateCommerceOrder();
  const update = useUpdateCommerceOrder();
  const defaults = useCommerceDefaults();
  const { data: companies } = useCompanies({ limit: 100 });

  const form = useForm<FormValues>({
    resolver: zodResolver(orderFormSchema, commerceSchemaOptions()),
    defaultValues: order
      ? {
          orderNumber: order.orderNumber ?? undefined,
          customerId: order.customerId ?? undefined,
          status: order.status ?? 'pending',
          currency: order.currency || '',
          subtotal: order.subtotal != null ? Number(order.subtotal) : undefined,
          taxTotal: order.taxTotal != null ? Number(order.taxTotal) : undefined,
          total: order.total != null ? Number(order.total) : undefined,
        }
      : { status: 'pending', currency: defaults.currency ?? '' },
  });
  const { errors } = form.formState;

  // A new order is in the workspace's currency. The entities may arrive after
  // the form mounted; a currency the person already typed is kept.
  useEffect(() => {
    if (isEdit || !defaults.currency) return;
    if (!form.getValues('currency')) form.setValue('currency', defaults.currency);
  }, [isEdit, defaults.currency, form]);

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
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3" noValidate>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="orderNumber">{t.fields.orderNumber}</Label>
              <Input id="orderNumber" aria-invalid={!!errors.orderNumber || undefined} {...form.register('orderNumber')} />
              <FieldError className="text-xs" errors={[errors.orderNumber]} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="status">{t.fields.status}</Label>
              <Select
                defaultValue={order?.status ?? 'pending'}
                onValueChange={(v) => form.setValue('status', v)}
              >
                <SelectTrigger id="status"><SelectValue /></SelectTrigger>
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
              // `null` (not undefined) so an edit can take the customer off an order.
              onValueChange={(v) => form.setValue('customerId', v === NO_CUSTOMER ? null : v)}
            >
              <SelectTrigger id="customerId"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CUSTOMER}>{t.orders.noCustomer}</SelectItem>
                {(companies?.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError className="text-xs" errors={[errors.customerId]} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="subtotal">{t.fields.subtotal}</Label>
              <Input
                id="subtotal"
                type="number"
                step="0.01"
                min="0"
                aria-invalid={!!errors.subtotal || undefined}
                {...form.register('subtotal', optionalNumber)}
              />
              <FieldError className="text-xs" errors={[errors.subtotal]} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="taxTotal">{t.fields.tax}</Label>
              <Input
                id="taxTotal"
                type="number"
                step="0.01"
                min="0"
                aria-invalid={!!errors.taxTotal || undefined}
                {...form.register('taxTotal', optionalNumber)}
              />
              <FieldError className="text-xs" errors={[errors.taxTotal]} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="total">{t.fields.total}</Label>
              <Input
                id="total"
                type="number"
                step="0.01"
                min="0"
                aria-invalid={!!errors.total || undefined}
                {...form.register('total', optionalNumber)}
              />
              <FieldError className="text-xs" errors={[errors.total]} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="currency">{t.fields.currency}</Label>
            <Input
              id="currency"
              maxLength={3}
              autoComplete="off"
              className="uppercase"
              placeholder={defaults.currency ?? 'EUR'}
              aria-invalid={!!errors.currency || undefined}
              {...form.register('currency', currencyInput)}
            />
            {/* The code check has no message of its own; name what is expected. */}
            <FieldError className="text-xs">{errors.currency ? t.validation.currencyCode : null}</FieldError>
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
