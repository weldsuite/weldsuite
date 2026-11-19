import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import type { PurchaseOrder } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { PURCHASE_ORDER_STATUSES } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { getTranslations } from '@/lib/i18n';
import { useCreatePurchaseOrder, useUpdatePurchaseOrder } from '@/hooks/queries/use-purchasing-queries';
import { useWeldstashSuppliers, useWeldstashWarehouses } from '@/hooks/queries/use-weldstash-queries';
import { randomSuffix } from '@/lib/random';
import { isoDatePart, toNumber } from '../../lib/numbers';

const NONE = '__none__';

/** `PO-YYYYMMDD-XXXX`, the format the Rust backend generates; Global needs one from the client. */
export function generatePoNumber(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `PO-${day}-${randomSuffix(4).toUpperCase()}`;
}

interface PoFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this order; without it the dialog creates one. */
  order?: PurchaseOrder;
  /** Global only: lets the status be picked by hand, since nothing else moves it there. */
  chooseStatus?: boolean;
  onSaved?: (id: string) => void;
}

export function PoFormDialog({ open, onOpenChange, order, chooseStatus = false, onSaved }: Readonly<PoFormDialogProps>) {
  const t = getTranslations('weldstashPurchasing');
  const isEdit = !!order;
  const create = useCreatePurchaseOrder();
  const update = useUpdatePurchaseOrder();
  const suppliers = useWeldstashSuppliers({ limit: 100 });
  const warehouses = useWeldstashWarehouses({ limit: 100 });
  const supplierRows = suppliers.data?.data ?? [];
  const warehouseRows = warehouses.data?.data ?? [];

  const schema = useMemo(
    () =>
      z.object({
        supplierId: z.string().min(1, t.form.supplierRequired),
        warehouseId: z.string(),
        expectedDate: z.string(),
        currency: z.string().length(3, t.form.currencyInvalid),
        paymentTerms: z.string().max(100),
        shippingTotal: z.number().min(0).optional(),
        discountTotal: z.number().min(0).optional(),
        supplierNotes: z.string(),
        internalNotes: z.string(),
        status: z.string(),
      }),
    [t],
  );
  type FormValues = z.infer<typeof schema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      supplierId: order?.supplierId ?? '',
      warehouseId: order?.warehouseId ?? NONE,
      expectedDate: isoDatePart(order?.expectedDate) ?? '',
      currency: order?.currency ?? 'EUR',
      paymentTerms: order?.paymentTerms ?? '',
      shippingTotal: order ? toNumber(order.shippingTotal) : undefined,
      discountTotal: order ? toNumber(order.discountTotal) : undefined,
      supplierNotes: order?.supplierNotes ?? '',
      internalNotes: order?.internalNotes ?? '',
      status: order?.status ?? 'draft',
    },
  });

  const saving = create.isPending || update.isPending;

  const onSubmit = async (values: FormValues) => {
    const supplier = supplierRows.find((s) => s.id === values.supplierId);
    const warehouse = warehouseRows.find((w) => w.id === values.warehouseId);
    const body = {
      supplierId: values.supplierId,
      supplierName: supplier?.name ?? order?.supplierName ?? null,
      warehouseId: values.warehouseId === NONE ? null : values.warehouseId,
      warehouseName: warehouse?.name ?? null,
      expectedDate: values.expectedDate ? new Date(`${values.expectedDate}T00:00:00Z`).toISOString() : null,
      currency: values.currency.toUpperCase(),
      paymentTerms: values.paymentTerms || null,
      shippingTotal: values.shippingTotal ?? 0,
      discountTotal: values.discountTotal ?? 0,
      supplierNotes: values.supplierNotes || null,
      internalNotes: values.internalNotes || null,
    };
    try {
      if (order) {
        await update.mutateAsync({ id: order.id, data: chooseStatus ? { ...body, status: values.status } : body });
        toast.success(t.form.toastUpdated);
        onSaved?.(order.id);
      } else {
        const created = await create.mutateAsync({ ...body, poNumber: generatePoNumber() });
        toast.success(t.form.toastCreated);
        onSaved?.(created.id);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || t.form.saveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.form.editTitle : t.form.createTitle}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="supplierId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.form.supplier}</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        const supplier = supplierRows.find((s) => s.id === value);
                        if (supplier?.currency && !isEdit) form.setValue('currency', supplier.currency);
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t.form.selectSupplier} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {supplierRows.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="warehouseId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.form.warehouse}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NONE}>{t.form.noWarehouse}</SelectItem>
                        {warehouseRows.map((w) => (
                          <SelectItem key={w.id} value={w.id}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="expectedDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.form.expectedDate}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="currency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.form.currency}</FormLabel>
                    <FormControl>
                      <Input maxLength={3} className="uppercase" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="paymentTerms"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.form.paymentTerms}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="shippingTotal"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.form.shipping}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.value === '' ? undefined : Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="discountTotal"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.form.discount}</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={field.value ?? ''}
                        onChange={(e) => field.onChange(e.target.value === '' ? undefined : Number(e.target.value))}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {chooseStatus && (
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.form.status}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {PURCHASE_ORDER_STATUSES.map((status) => (
                          <SelectItem key={status} value={status}>
                            {(t.status as Record<string, string>)[status] ?? status}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="supplierNotes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.form.supplierNotes}</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="internalNotes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.form.internalNotes}</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.cancel}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? t.common.saving : isEdit ? t.form.save : t.form.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
