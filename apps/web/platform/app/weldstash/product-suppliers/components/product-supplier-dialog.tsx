import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import type { ProductSupplier } from '@weldsuite/app-api-client/schemas/product-suppliers';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { SearchInput } from '@weldsuite/ui/components/search-input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { getTranslations } from '@/lib/i18n';
import { useDebounce } from '@/hooks/use-debounce';
import { useCreateProductSupplier, useUpdateProductSupplier } from '@/hooks/queries/use-purchasing-queries';
import { useWeldstashProducts, useWeldstashSuppliers } from '@/hooks/queries/use-weldstash-queries';
import {
  EMPTY_PRODUCT_SUPPLIER_FORM,
  formToCreateInput,
  formToUpdateInput,
  makeProductSupplierFormSchema,
  productSupplierToForm,
  type ProductSupplierFormField,
  type ProductSupplierFormValues,
} from '../lib/product-supplier-form';

interface ProductSupplierDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this row; without it the dialog links a new supplier or product. */
  row?: ProductSupplier;
  /** Fixed side of a new link: the product (product detail) or the supplier (supplier detail). */
  productId?: string;
  supplierId?: string;
  /** Suppliers (or products) already linked, left out of the choice. */
  excludeIds?: readonly string[];
}

export function ProductSupplierDialog({ open, onOpenChange, row, productId, supplierId, excludeIds = [] }: Readonly<ProductSupplierDialogProps>) {
  const t = getTranslations('weldstashPurchasing').productSuppliers;
  const isEdit = !!row;
  const create = useCreateProductSupplier();
  const update = useUpdateProductSupplier();
  const suppliers = useWeldstashSuppliers({ limit: 100 });
  const [productSearch, setProductSearch] = useState('');
  const debouncedSearch = useDebounce(productSearch, 300);
  const pickProduct = !isEdit && !productId;
  const products = useWeldstashProducts({ limit: 25, ...(debouncedSearch ? { search: debouncedSearch } : {}) });

  const schema = useMemo(
    () =>
      makeProductSupplierFormSchema(
        { required: t.required, invalid: t.invalid },
        isEdit ? { kind: 'update' } : { kind: 'create', productId: productId ?? '' },
      ),
    [t, isEdit, productId],
  );
  const form = useForm<ProductSupplierFormValues>({
    resolver: zodResolver(schema),
    defaultValues: row
      ? productSupplierToForm(row)
      : { ...EMPTY_PRODUCT_SUPPLIER_FORM, supplierId: supplierId ?? '', productId: productId ?? '' },
  });

  const saving = create.isPending || update.isPending;

  const onSubmit = async (values: ProductSupplierFormValues) => {
    try {
      if (row) {
        const result = formToUpdateInput(values);
        if (!result.ok) return;
        await update.mutateAsync({ id: row.id, data: result.input });
        toast.success(t.toastUpdated);
      } else {
        const result = formToCreateInput(values, { productId: productId ?? values.productId });
        if (!result.ok) return;
        await create.mutateAsync(result.input);
        toast.success(t.toastAdded);
      }
      onOpenChange(false);
    } catch (err) {
      // 404 (unknown product or supplier) and 409 (already linked) come back with their own message.
      toast.error((err as Error).message || t.saveFailed);
    }
  };

  const text = (name: ProductSupplierFormField, label: string, props: { inputMode?: 'decimal' | 'numeric'; placeholder?: string; hint?: string; className?: string } = {}) => (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem className={props.className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              inputMode={props.inputMode}
              placeholder={props.placeholder}
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              onChange={field.onChange}
              value={String(field.value)}
            />
          </FormControl>
          {props.hint && <FormDescription>{props.hint}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const supplierOptions = (suppliers.data?.data ?? []).filter((s) => !excludeIds.includes(s.id) || s.id === row?.supplierId);
  const productOptions = (products.data?.data ?? []).filter((p) => !excludeIds.includes(p.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.editTitle : t.addTitle}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
            {!supplierId && (
              <FormField
                control={form.control}
                name="supplierId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t.supplier}</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={isEdit}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={t.chooseSupplier} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {supplierOptions.map((s) => (
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
            )}
            {pickProduct && (
              <div className="grid gap-2">
                <SearchInput
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder={t.searchProducts}
                  aria-label={t.searchProducts}
                />
                <FormField
                  control={form.control}
                  name="productId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t.product}</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder={t.chooseProduct} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {productOptions.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.sku ? `${p.name} (${p.sku})` : p.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {text('supplierSku', t.supplierSku)}
              {text('supplierProductName', t.supplierProductName)}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {text('unitCost', t.unitCost, { inputMode: 'decimal' })}
              {text('currency', t.currency, { placeholder: 'EUR' })}
              {text('leadTimeDays', t.leadTime, { inputMode: 'numeric', hint: t.leadTimeHint })}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {text('minOrderQty', t.minOrderQty, { inputMode: 'numeric' })}
              {text('orderMultiple', t.orderMultiple, { inputMode: 'numeric', hint: t.orderMultipleHint })}
            </div>
            <FormField
              control={form.control}
              name="isPreferred"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div className="space-y-0.5">
                    <FormLabel>{t.preferred}</FormLabel>
                    <FormDescription>{t.preferredHint}</FormDescription>
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.cancel}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? t.saving : isEdit ? t.save : t.add}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
