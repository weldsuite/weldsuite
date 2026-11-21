import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import type { PurchaseOrderLine } from '@weldsuite/app-api-client/schemas/purchase-orders';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { getLocale, getTranslations } from '@/lib/i18n';
import { useDebounce } from '@/hooks/use-debounce';
import {
  useCreatePurchaseOrderLine,
  useUpdatePurchaseOrderLine,
} from '@/hooks/queries/use-purchasing-queries';
import { useWeldstashProducts } from '@/hooks/queries/use-weldstash-queries';
import { formatMoney, toNumber } from '../../lib/numbers';
import { previewLineAmounts } from '../lib/po-totals';

const CUSTOM = '__custom__';

interface PoLineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  currency: string | null;
  /** Edit this line; without it the dialog adds one. */
  line?: PurchaseOrderLine;
}

export function PoLineDialog({ open, onOpenChange, orderId, currency, line }: Readonly<PoLineDialogProps>) {
  const t = getTranslations('weldstashPurchasing');
  const locale = getLocale();
  const isEdit = !!line;
  const create = useCreatePurchaseOrderLine(orderId);
  const update = useUpdatePurchaseOrderLine(orderId);

  const [productSearch, setProductSearch] = useState('');
  const debouncedSearch = useDebounce(productSearch, 300);
  const products = useWeldstashProducts({ limit: 25, ...(debouncedSearch ? { search: debouncedSearch } : {}) });
  const productRows = products.data?.data;

  const schema = useMemo(
    () =>
      z.object({
        productId: z.string(),
        name: z.string().min(1, t.lineForm.nameRequired).max(255),
        sku: z.string().max(100),
        quantityOrdered: z
          .number({ invalid_type_error: t.lineForm.quantityInvalid })
          .int(t.lineForm.quantityInvalid)
          .min(1, t.lineForm.quantityInvalid),
        unitPrice: z.number({ invalid_type_error: t.lineForm.priceInvalid }).min(0, t.lineForm.priceInvalid),
        discountPercent: z.number().min(0).max(100),
        taxPercent: z.number().min(0).max(100),
        notes: z.string(),
      }),
    [t],
  );
  type FormValues = z.infer<typeof schema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      productId: line?.productId ?? CUSTOM,
      name: line?.name ?? '',
      sku: line?.sku ?? '',
      quantityOrdered: line?.quantityOrdered ?? 1,
      unitPrice: line ? toNumber(line.unitPrice) : 0,
      discountPercent: line ? toNumber(line.discountPercent) : 0,
      taxPercent: line ? toNumber(line.taxPercent) : 0,
      notes: line?.notes ?? '',
    },
  });

  const watched = form.watch();
  const preview = previewLineAmounts({
    quantityOrdered: Number(watched.quantityOrdered) || 0,
    unitPrice: Number(watched.unitPrice) || 0,
    discountPercent: Number(watched.discountPercent) || 0,
    taxPercent: Number(watched.taxPercent) || 0,
  });

  const onPickProduct = (productId: string) => {
    form.setValue('productId', productId);
    if (productId === CUSTOM) return;
    const product = productRows?.find((p) => p.id === productId);
    if (!product) return;
    form.setValue('name', product.name, { shouldValidate: true });
    form.setValue('sku', product.sku ?? '');
    if (product.costPrice != null) form.setValue('unitPrice', Math.round(product.costPrice * 100) / 100);
  };

  const saving = create.isPending || update.isPending;

  const onSubmit = async (values: FormValues) => {
    const body = {
      productId: values.productId === CUSTOM ? null : values.productId,
      name: values.name,
      sku: values.sku || null,
      quantityOrdered: values.quantityOrdered,
      unitPrice: Math.round(values.unitPrice * 100) / 100,
      discountPercent: values.discountPercent,
      taxPercent: values.taxPercent,
      notes: values.notes || null,
    };
    try {
      if (line) await update.mutateAsync({ itemId: line.id, data: body });
      else await create.mutateAsync(body);
      toast.success(isEdit ? t.lineForm.toastUpdated : t.lineForm.toastAdded);
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || t.lineForm.saveFailed);
    }
  };

  const numberField = (name: 'quantityOrdered' | 'unitPrice' | 'discountPercent' | 'taxPercent', label: string, step: string) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              step={step}
              min="0"
              value={Number.isNaN(field.value) || field.value === undefined ? '' : field.value}
              onChange={(e) => field.onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const submitLabel = isEdit ? t.lineForm.save : t.lineForm.add;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.lineForm.editTitle : t.lineForm.addTitle}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
            {!isEdit && (
              <div className="grid gap-2">
                <SearchInput
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder={t.lineForm.searchProducts}
                  aria-label={t.lineForm.searchProducts}
                />
                <Select value={watched.productId} onValueChange={onPickProduct}>
                  <SelectTrigger aria-label={t.lineForm.product}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={CUSTOM}>{t.lineForm.customLine}</SelectItem>
                    {(productRows ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.sku ? `${p.name} (${p.sku})` : p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.lineForm.name}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="sku"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.lineForm.sku}</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              {numberField('quantityOrdered', t.lineForm.quantity, '1')}
              {numberField('unitPrice', t.lineForm.unitPrice, '0.01')}
              {numberField('discountPercent', t.lineForm.discountPercent, '0.01')}
              {numberField('taxPercent', t.lineForm.taxPercent, '0.01')}
            </div>

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t.lineForm.notes}</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <p className="text-right text-sm text-muted-foreground">
              {t.lineForm.lineTotal}{' '}
              <span className="font-medium tabular-nums text-foreground">{formatMoney(preview.total, currency, locale)}</span>
            </p>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.common.cancel}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? t.common.saving : submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
