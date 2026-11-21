/**
 * What a discount code applies to: everything on the order, chosen products
 * (the phase 1 product picker) or chosen categories (a checklist of the
 * category tree). Which products or categories are chosen lives in the form.
 */

import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useFormContext } from 'react-hook-form';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ProductPickerDialog } from '@/components/objects/category/product-picker-dialog';
import { useCommerceCategoryTree } from '@/hooks/queries/use-commerce-queries';
import { useProductsByIds } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { flattenCategoryTree } from '../../lib/categories';
import { DISCOUNT_APPLIES_TO, type DiscountFormValues } from '../../lib/discounts';
import { fill } from '../../lib/text';

function ChosenProducts({ ids, onRemove }: Readonly<{ ids: string[]; onRemove: (id: string) => void }>) {
  const t = getTranslations('commerce').discounts.form;
  const queries = useProductsByIds(ids);

  if (ids.length === 0) return <p className="text-sm text-muted-foreground">{t.noProducts}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {ids.map((id, index) => {
        const name = queries[index]?.data?.data.name ?? t.productUnknown;
        return (
          <li key={id} className="flex items-center gap-1 rounded-md border bg-muted/40 py-0.5 pl-2 pr-0.5 text-sm">
            <span className="max-w-[16rem] truncate">{name}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              aria-label={fill(t.removeProduct, { name })}
              title={fill(t.removeProduct, { name })}
              onClick={() => onRemove(id)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function CategoryChecklist({ selected, onToggle }: Readonly<{ selected: string[]; onToggle: (id: string) => void }>) {
  const t = getTranslations('commerce').discounts.form;
  const { data, isLoading } = useCommerceCategoryTree();
  const categories = useMemo(() => flattenCategoryTree(data?.data ?? []), [data]);

  if (!isLoading && categories.length === 0) return <EmptyText>{t.noCategories}</EmptyText>;
  return (
    <div className="max-h-48 overflow-y-auto rounded-md border">
      {categories.map((category) => {
        const checkboxId = `discount-category-${category.id}`;
        return (
          <label
            key={category.id}
            htmlFor={checkboxId}
            className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-muted/50"
            style={{ paddingLeft: 12 + (category.depth ?? 0) * 16 }}
          >
            <Checkbox id={checkboxId} checked={selected.includes(category.id)} onCheckedChange={() => onToggle(category.id)} />
            <span className="truncate">{category.name}</span>
          </label>
        );
      })}
    </div>
  );
}

export function DiscountScopeFields() {
  const t = getTranslations('commerce').discounts;
  const form = useFormContext<DiscountFormValues>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const appliesTo = form.watch('appliesTo');
  const productIds = form.watch('productIds');
  const categoryIds = form.watch('categoryIds');

  const toggleCategory = (id: string) => {
    const next = categoryIds.includes(id) ? categoryIds.filter((x) => x !== id) : [...categoryIds, id];
    form.setValue('categoryIds', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  };

  return (
    <div className="grid gap-3">
      <FormField
        control={form.control}
        name="appliesTo"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t.fields.appliesTo}</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {DISCOUNT_APPLIES_TO.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t.appliesTo[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {appliesTo === 'products' && (
        <fieldset className="grid gap-2" aria-describedby={form.formState.errors.productIds ? 'discount-products-error' : undefined}>
          <legend className="mb-1 text-sm font-medium">{t.fields.products}</legend>
          <ChosenProducts
            ids={productIds}
            onRemove={(id) =>
              form.setValue(
                'productIds',
                productIds.filter((x) => x !== id),
                { shouldDirty: true, shouldValidate: form.formState.isSubmitted },
              )
            }
          />
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {t.form.addProducts}
            </Button>
          </div>
          {form.formState.errors.productIds && (
            <p id="discount-products-error" role="alert" className="text-sm text-destructive">
              {form.formState.errors.productIds.message}
            </p>
          )}
          {pickerOpen && (
            <ProductPickerDialog
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              existingIds={productIds}
              title={t.form.addProducts}
              onConfirm={(ids) =>
                form.setValue('productIds', [...productIds, ...ids.filter((id) => !productIds.includes(id))], {
                  shouldDirty: true,
                  shouldValidate: form.formState.isSubmitted,
                })
              }
            />
          )}
        </fieldset>
      )}

      {appliesTo === 'categories' && (
        <fieldset className="grid gap-2" aria-describedby={form.formState.errors.categoryIds ? 'discount-categories-error' : undefined}>
          <legend className="mb-1 text-sm font-medium">{t.fields.categories}</legend>
          <CategoryChecklist selected={categoryIds} onToggle={toggleCategory} />
          {form.formState.errors.categoryIds && (
            <p id="discount-categories-error" role="alert" className="text-sm text-destructive">
              {form.formState.errors.categoryIds.message}
            </p>
          )}
        </fieldset>
      )}
    </div>
  );
}
