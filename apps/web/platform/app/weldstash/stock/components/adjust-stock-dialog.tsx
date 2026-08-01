/**
 * Stock adjustment dialog — the only write path on the stock screen.
 *
 * `/inventory/adjust` writes both the inventory row and a movement row, so
 * every change keeps its audit trail. That's why the stock grid itself is
 * read-only: an inline cell edit would move the level without the movement.
 *
 * Lifted out of the old stock page unchanged when that page moved to
 * EntityGrid.
 */

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { adjustStockSchema, type AdjustStockInput } from '@weldsuite/core-api-client/schemas/weldstash';
import {
  useAdjustWeldstashStock,
  useWeldstashProducts,
  useWeldstashWarehouses,
} from '@/hooks/queries/use-weldstash-queries';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

export function AdjustStockDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = getTranslations('common');
  const adjust = useAdjustWeldstashStock();
  const products = useWeldstashProducts({ limit: 100 });
  const warehouses = useWeldstashWarehouses({ limit: 100 });

  const form = useForm<z.input<typeof adjustStockSchema>>({
    resolver: zodResolver(adjustStockSchema),
    defaultValues: { productId: '', warehouseId: '', delta: 0, reason: '' },
  });

  const onSubmit = async (values: z.input<typeof adjustStockSchema>) => {
    try {
      const parsed = adjustStockSchema.parse(values) as AdjustStockInput;
      await adjust.mutateAsync(parsed);
      const deltaStr = `${values.delta > 0 ? '+' : ''}${values.delta}`;
      toast.success(t.weldstash.stock.toastAdjusted.replace('{delta}', deltaStr));
      onOpenChange(false);
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.weldstash.stock.toastAdjustFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.weldstash.stock.adjustTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>{t.weldstash.stock.labelProduct}</Label>
            {/* Controller, not bare setValue: an uncontrolled Select keeps its
                own display state, so after form.reset() the field would clear
                while the trigger still showed the old product. */}
            <Controller
              control={form.control}
              name="productId"
              render={({ field }) => (
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder={t.weldstash.stock.placeholderProduct} /></SelectTrigger>
                  <SelectContent>
                    {products.data?.data.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {form.formState.errors.productId && (
              <p className="text-xs text-destructive">{form.formState.errors.productId.message}</p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label>{t.weldstash.stock.labelWarehouse}</Label>
            <Controller
              control={form.control}
              name="warehouseId"
              render={({ field }) => (
                <Select value={field.value ?? ''} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder={t.weldstash.stock.placeholderWarehouse} /></SelectTrigger>
                  <SelectContent>
                    {warehouses.data?.data.map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {form.formState.errors.warehouseId && (
              <p className="text-xs text-destructive">{form.formState.errors.warehouseId.message}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="delta">{t.weldstash.stock.labelQuantityChange}</Label>
              <Input id="delta" type="number" step="1" {...form.register('delta', { valueAsNumber: true })} />
              <p className="text-xs text-muted-foreground">{t.weldstash.stock.hintQuantityChange}</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="unitCost">{t.weldstash.stock.labelUnitCost}</Label>
              <Input id="unitCost" type="number" step="0.01" {...form.register('unitCost', { valueAsNumber: true })} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="lotNumber">{t.weldstash.stock.labelLotNumber}</Label>
            <Input id="lotNumber" {...form.register('lotNumber')} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="reason">{t.weldstash.stock.labelReason}</Label>
            <Input id="reason" placeholder={t.weldstash.stock.placeholderReason} {...form.register('reason')} />
            {form.formState.errors.reason && (
              <p className="text-xs text-destructive">{form.formState.errors.reason.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.actions.cancel}
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {t.weldstash.stock.applyButton}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
