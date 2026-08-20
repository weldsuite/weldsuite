import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createProductSchema, type CreateProductInput } from '@weldsuite/core-api-client/schemas/weldstash';
import {
  useCreateCommerceProduct,
  useUpdateCommerceProduct,
  useCommerceProduct,
  type CommerceProduct,
} from '@/hooks/queries/use-commerce-queries';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { ProductImagesField, type ProductImage } from './product-images-field';
import { ProductSalesChannelsEditor } from './product-sales-channels-editor';

type FormValues = z.input<typeof createProductSchema>;

/**
 * Create + edit form for a product. With the list on the simple table there is
 * no inline cell editing, so this dialog is the primary edit path.
 */
export function ProductDialog({
  open,
  onOpenChange,
  product,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: CommerceProduct;
}) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const isEdit = !!product;
  const create = useCreateCommerceProduct();
  const update = useUpdateCommerceProduct();
  const { data: productDetail } = useCommerceProduct(product?.id ?? '', isEdit);
  const salesChannels = productDetail?.data?.salesChannels ?? product?.salesChannels ?? [];

  const form = useForm<FormValues>({
    resolver: zodResolver(createProductSchema),
    defaultValues: product
      ? {
          name: product.name,
          sku: product.sku ?? undefined,
          barcode: product.barcode ?? undefined,
          description: product.description ?? undefined,
          price: Number(product.price ?? 0),
          costPrice: product.costPrice != null ? Number(product.costPrice) : undefined,
          currency: product.currency ?? undefined,
          status: (product.status as 'active' | 'inactive' | 'draft') ?? 'active',
          brand: product.brand ?? undefined,
          vendor: product.vendor ?? undefined,
          lowStockThreshold: product.lowStockThreshold ?? undefined,
          trackInventory: product.trackInventory ?? undefined,
          featuredImageUrl: product.featuredImageUrl ?? undefined,
          images: product.images ?? undefined,
        }
      : { name: '', price: 0, status: 'active' },
  });

  // Images are an array field, so they're controlled by hand rather than via
  // `register`. `watch` keeps the editor in sync with form state (including a
  // reset after submit).
  const images = (form.watch('images') ?? []) as ProductImage[];

  const onSubmit = async (values: FormValues) => {
    try {
      // `featuredImageUrl` is derived, never entered: the first image wins.
      // Keeping the column in step here means no consumer has to know the
      // ordering convention.
      const withMedia: FormValues = {
        ...values,
        featuredImageUrl: images[0]?.url,
        images: images.length > 0 ? images : undefined,
      };
      const parsed = createProductSchema.parse(withMedia) as CreateProductInput;
      if (isEdit && product) {
        await update.mutateAsync({ id: product.id, data: parsed });
        toast.success(t.products.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(t.products.toastCreated);
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
          <DialogTitle>{isEdit ? t.products.editTitle : t.products.newTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="name">{t.fields.name}</Label>
            <Input id="name" {...form.register('name')} />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{String(form.formState.errors.name.message ?? '')}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sku">{t.fields.sku}</Label>
              <Input id="sku" {...form.register('sku')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="barcode">{t.fields.barcode}</Label>
              <Input id="barcode" {...form.register('barcode')} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="price">{t.fields.price}</Label>
              <Input id="price" type="number" step="0.01" {...form.register('price', { valueAsNumber: true })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="costPrice">{t.fields.costPrice}</Label>
              <Input id="costPrice" type="number" step="0.01" {...form.register('costPrice', { valueAsNumber: true })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="status">{t.fields.status}</Label>
              <Select
                defaultValue={form.getValues('status') ?? 'active'}
                onValueChange={(v) => form.setValue('status', v as 'active' | 'inactive' | 'draft')}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t.status.active}</SelectItem>
                  <SelectItem value="draft">{t.status.draft}</SelectItem>
                  <SelectItem value="inactive">{t.status.inactive}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="brand">{t.fields.brand}</Label>
              <Input id="brand" {...form.register('brand')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lowStockThreshold">{t.fields.lowStockAt}</Label>
              <Input
                id="lowStockThreshold"
                type="number"
                {...form.register('lowStockThreshold', { valueAsNumber: true })}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="description">{t.fields.description}</Label>
            <Textarea id="description" rows={3} {...form.register('description')} />
          </div>
          <ProductImagesField
            value={images}
            onChange={(next) => form.setValue('images', next, { shouldDirty: true })}
          />
          {isEdit && product ? (
            <ProductSalesChannelsEditor productId={product.id} channels={salesChannels} />
          ) : null}
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
