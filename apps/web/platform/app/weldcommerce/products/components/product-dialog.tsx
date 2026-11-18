import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { createProductSchema, type CreateProductInput } from '@weldsuite/core-api-client/schemas/weldstash';
import {
  useCreateCommerceProduct,
  useUpdateCommerceProduct,
  useCommerceProduct,
  type CommerceProduct,
} from '@/hooks/queries/use-commerce-queries';
import { Button } from '@weldsuite/ui/components/button';
import { FieldError } from '@weldsuite/ui/components/field';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import {
  CURRENCY_CODE,
  commerceSchemaOptions,
  currencyInput,
  optionalNumber,
  optionalText,
} from '../../lib/form';
import { useCommerceDefaults } from '../../lib/use-commerce-defaults';
import { ProductImagesField, type ProductImage } from './product-images-field';
import { ProductSalesChannelsEditor } from './product-sales-channels-editor';
import { ProductTaxFields } from './product-tax-fields';
import {
  hasInvalidCustomCode,
  initialTaxState,
  productTaxPayload,
  storedProductTax,
  type ProductTaxState,
} from './product-tax';

/** The API's product schema, with the currency held to a three-letter code. */
const productFormSchema = createProductSchema.extend({
  currency: z.string().regex(CURRENCY_CODE).optional(),
});

type FormValues = z.input<typeof productFormSchema>;

/**
 * Create + edit form for a product. With the list on the simple table there is
 * no inline cell editing, so this dialog is the primary edit path.
 *
 * Every optional input reads blank as "not given" (`../../lib/form`), and every
 * field shows its own error: a check that fails without a message on screen
 * leaves a Create button that seems to do nothing.
 */
export function ProductDialog({
  open,
  onOpenChange,
  product,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: CommerceProduct;
}>) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const isEdit = !!product;
  const create = useCreateCommerceProduct();
  const update = useUpdateCommerceProduct();
  const defaults = useCommerceDefaults();
  const { data: productDetail } = useCommerceProduct(product?.id ?? '', isEdit);
  const salesChannels = productDetail?.data?.salesChannels ?? product?.salesChannels ?? [];

  const form = useForm<FormValues>({
    resolver: zodResolver(productFormSchema, commerceSchemaOptions()),
    defaultValues: product
      ? {
          name: product.name,
          sku: product.sku || undefined,
          barcode: product.barcode ?? undefined,
          description: product.description ?? undefined,
          price: Number(product.price ?? 0),
          costPrice: product.costPrice != null ? Number(product.costPrice) : undefined,
          currency: product.currency || undefined,
          status: (product.status as 'active' | 'inactive' | 'draft') ?? 'active',
          brand: product.brand ?? undefined,
          vendor: product.vendor ?? undefined,
          lowStockThreshold: product.lowStockThreshold ?? undefined,
          trackInventory: product.trackInventory ?? undefined,
          featuredImageUrl: product.featuredImageUrl ?? undefined,
          images: product.images ?? undefined,
        }
      : { name: '', price: 0, status: 'active', currency: defaults.currency ?? undefined },
  });
  const { errors } = form.formState;

  // A new product is priced in the workspace's currency, not the database's
  // USD default. The entities may arrive after the form mounted; a currency
  // the person already typed is kept.
  useEffect(() => {
    if (isEdit || !defaults.currency) return;
    if (!form.getValues('currency')) form.setValue('currency', defaults.currency);
  }, [isEdit, defaults.currency, form]);

  // The sales tax fields are not form inputs: `product-tax.ts` keeps their state
  // and works out which of them to send, so a save that doesn't touch them
  // leaves the stored tax code alone. They are US sales tax codes, so they
  // only show for a workspace with a US entity.
  const storedTax = storedProductTax(product);
  const [tax, setTax] = useState<ProductTaxState>(() => initialTaxState(storedTax));
  const [taxChecked, setTaxChecked] = useState(false);

  // Images are an array field, so they're controlled by hand rather than via
  // `register`. `watch` keeps the editor in sync with form state (including a
  // reset after submit).
  const images = (form.watch('images') ?? []) as ProductImage[];

  const onSubmit = async (values: FormValues) => {
    if (defaults.salesTax && tax.taxable && hasInvalidCustomCode(tax)) {
      setTaxChecked(true);
      return;
    }
    try {
      // `featuredImageUrl` is derived, never entered: the first image wins.
      // Keeping the column in step here means no consumer has to know the
      // ordering convention.
      const withMedia: FormValues = {
        ...values,
        featuredImageUrl: images[0]?.url,
        images: images.length > 0 ? images : undefined,
        ...(defaults.salesTax ? productTaxPayload(storedTax, tax) : {}),
      };
      const parsed = createProductSchema.parse(withMedia) as CreateProductInput;
      if (isEdit && product) {
        // A blank SKU is "not given" to the form; on an edit that means the
        // person cleared it, which the API takes as an empty string.
        const data = !values.sku && product.sku ? { ...parsed, sku: '' } : parsed;
        await update.mutateAsync({ id: product.id, data });
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
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.products.editTitle : t.products.newTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="name">{t.fields.name}</Label>
            <Input id="name" aria-invalid={!!errors.name || undefined} {...form.register('name')} />
            <FieldError className="text-xs" errors={[errors.name]} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sku">{t.fields.sku}</Label>
              <Input id="sku" aria-invalid={!!errors.sku || undefined} {...form.register('sku', optionalText)} />
              <FieldError className="text-xs" errors={[errors.sku]} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="barcode">{t.fields.barcode}</Label>
              <Input id="barcode" aria-invalid={!!errors.barcode || undefined} {...form.register('barcode')} />
              <FieldError className="text-xs" errors={[errors.barcode]} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="price">{t.fields.price}</Label>
              <Input
                id="price"
                type="number"
                step="0.01"
                min="0"
                aria-invalid={!!errors.price || undefined}
                {...form.register('price', optionalNumber)}
              />
              <FieldError className="text-xs" errors={[errors.price]} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="costPrice">{t.fields.costPrice}</Label>
              <Input
                id="costPrice"
                type="number"
                step="0.01"
                min="0"
                aria-invalid={!!errors.costPrice || undefined}
                {...form.register('costPrice', optionalNumber)}
              />
              <FieldError className="text-xs" errors={[errors.costPrice]} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="currency">{t.fields.currency}</Label>
              <Input
                id="currency"
                maxLength={3}
                autoComplete="off"
                className="uppercase"
                placeholder={defaults.currency ?? undefined}
                aria-invalid={!!errors.currency || undefined}
                {...form.register('currency', currencyInput)}
              />
              {/* The schema's own check has no message; the map would say "not valid". */}
              <FieldError className="text-xs">{errors.currency ? t.validation.currencyCode : null}</FieldError>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="brand">{t.fields.brand}</Label>
              <Input id="brand" aria-invalid={!!errors.brand || undefined} {...form.register('brand')} />
              <FieldError className="text-xs" errors={[errors.brand]} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lowStockThreshold">{t.fields.lowStockAt}</Label>
              <Input
                id="lowStockThreshold"
                type="number"
                min="0"
                step="1"
                aria-invalid={!!errors.lowStockThreshold || undefined}
                {...form.register('lowStockThreshold', optionalNumber)}
              />
              <FieldError className="text-xs" errors={[errors.lowStockThreshold]} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="status">{t.fields.status}</Label>
              <Select
                defaultValue={form.getValues('status') ?? 'active'}
                onValueChange={(v) => form.setValue('status', v as 'active' | 'inactive' | 'draft')}
              >
                <SelectTrigger id="status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t.status.active}</SelectItem>
                  <SelectItem value="draft">{t.status.draft}</SelectItem>
                  <SelectItem value="inactive">{t.status.inactive}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="description">{t.fields.description}</Label>
            <Textarea id="description" rows={3} {...form.register('description')} />
            <FieldError className="text-xs" errors={[errors.description]} />
          </div>
          <ProductImagesField
            value={images}
            onChange={(next) => form.setValue('images', next, { shouldDirty: true })}
          />
          {defaults.salesTax ? (
            <ProductTaxFields state={tax} onChange={setTax} showErrors={taxChecked} />
          ) : null}
          {isEdit && product ? (
            <ProductSalesChannelsEditor
              productId={product.id}
              channels={salesChannels}
              catalogPrice={product.price}
              catalogStatus={product.status}
              currency={product.currency}
            />
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
