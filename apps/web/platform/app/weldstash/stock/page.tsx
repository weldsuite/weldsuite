import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { adjustStockSchema, type AdjustStockInput } from '@weldsuite/core-api-client/schemas/weldstash';
import {
  useWeldstashStock,
  useAdjustWeldstashStock,
  useWeldstashProducts,
  useWeldstashWarehouses,
} from '@/hooks/queries/use-weldstash-queries';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@weldsuite/ui/components/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

function AdjustStockDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
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
            <Select onValueChange={(v) => form.setValue('productId', v)}>
              <SelectTrigger><SelectValue placeholder={t.weldstash.stock.placeholderProduct} /></SelectTrigger>
              <SelectContent>
                {products.data?.data.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}{p.sku ? ` (${p.sku})` : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.productId && <p className="text-xs text-destructive">{form.formState.errors.productId.message}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label>{t.weldstash.stock.labelWarehouse}</Label>
            <Select onValueChange={(v) => form.setValue('warehouseId', v)}>
              <SelectTrigger><SelectValue placeholder={t.weldstash.stock.placeholderWarehouse} /></SelectTrigger>
              <SelectContent>
                {warehouses.data?.data.map((w) => (
                  <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.warehouseId && <p className="text-xs text-destructive">{form.formState.errors.warehouseId.message}</p>}
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
            {form.formState.errors.reason && <p className="text-xs text-destructive">{form.formState.errors.reason.message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t.actions.cancel}</Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>{t.weldstash.stock.applyButton}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function StockPage() {
  const t = getTranslations('common');
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [warehouseFilter, setWarehouseFilter] = useState<string>('');

  const warehouses = useWeldstashWarehouses({ limit: 100 });
  const params = useMemo(
    () => ({ limit: 100, warehouseId: warehouseFilter || undefined }),
    [warehouseFilter],
  );
  const { data, isLoading } = useWeldstashStock(params);

  return (
    <div className="container mx-auto max-w-[1600px] p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Label className="text-sm text-muted-foreground">{t.weldstash.stock.warehouseLabel}</Label>
          <Select value={warehouseFilter || 'all'} onValueChange={(v) => setWarehouseFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-[240px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t.weldstash.stock.allWarehouses}</SelectItem>
              {warehouses.data?.data.map((w) => (
                <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Dialog open={adjustOpen} onOpenChange={setAdjustOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" /> {t.weldstash.stock.adjustButton}</Button>
          </DialogTrigger>
          {adjustOpen && <AdjustStockDialog open={adjustOpen} onOpenChange={setAdjustOpen} />}
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.weldstash.stock.colProduct}</TableHead>
                <TableHead>{t.weldstash.stock.colSku}</TableHead>
                <TableHead>{t.weldstash.stock.colWarehouse}</TableHead>
                <TableHead>{t.weldstash.stock.colLocation}</TableHead>
                <TableHead className="text-right">{t.weldstash.stock.colOnHand}</TableHead>
                <TableHead className="text-right">{t.weldstash.stock.colAllocated}</TableHead>
                <TableHead className="text-right">{t.weldstash.stock.colAvailable}</TableHead>
                <TableHead>{t.weldstash.stock.colLot}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">{t.weldstash.stock.loading}</TableCell></TableRow>
              )}
              {!isLoading && data?.data.length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-8">{t.weldstash.stock.empty}</TableCell></TableRow>
              )}
              {data?.data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.productName ?? row.productId}</TableCell>
                  <TableCell>{row.productSku ?? '—'}</TableCell>
                  <TableCell>{row.warehouseName ?? '—'}</TableCell>
                  <TableCell>{row.locationCode ?? '—'}</TableCell>
                  <TableCell className="text-right">{row.quantityOnHand ?? 0}</TableCell>
                  <TableCell className="text-right">{row.quantityAllocated ?? 0}</TableCell>
                  <TableCell className="text-right">{row.quantityAvailable ?? 0}</TableCell>
                  <TableCell>{row.lotNumber ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
