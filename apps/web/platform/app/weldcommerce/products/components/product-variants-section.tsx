import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Settings2 } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { SectionHeader, ProseBlock } from '@/components/objects/_shared/simple-object-panel';
import {
  useDeleteProductVariant,
  useGenerateProductVariants,
  useProductVariants,
  useUpdateProductVariant,
  type CommerceVariant,
  type UpdateVariantInput,
  type VariantOption,
} from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { deriveOptions, variantTitle } from '../../lib/variants';
import { errorMessage, fill } from '../../lib/text';
import { useConfirmDelete } from '../../lib/use-confirm-delete';
import { useReturnFocus } from '../../lib/use-return-focus';
import { VariantOptionsEditor } from './variant-options-editor';
import { VariantRow } from './variant-row';

/** A 409 is a SKU or barcode another product or variant already has. */
function saveError(err: unknown, conflict: string, fallback: string): string {
  return isApiError(err) && err.status === 409 ? conflict : errorMessage(err, fallback);
}

/**
 * The Variants tab of the product panel (WeldCommerce): the product's
 * variants, the options editor that generates them, and in-place editing of
 * a variant's SKU, barcode, price and status. Editing needs `products:update`.
 */
export function ProductVariantsSection({
  productId,
  productPrice,
  currency,
  productOptions,
  productVatCategory = 'standard',
  canEdit,
}: Readonly<{
  productId: string;
  productPrice: string | number | null | undefined;
  currency: string | null | undefined;
  /** The product's `options`, which keep the seller's option order. */
  productOptions?: readonly { name: string; values: readonly string[] }[] | null;
  /** The product's VAT category, which a variant without its own uses. */
  productVatCategory?: string | null;
  canEdit: boolean;
}>) {
  const t = getTranslations('commerce');
  const tv = t.variants;
  const { data, isLoading, error } = useProductVariants(productId);
  const variants = useMemo(
    () => [...(data?.data ?? [])].sort((a, b) => a.position - b.position),
    [data],
  );

  const generate = useGenerateProductVariants();
  const update = useUpdateProductVariant();
  const remove = useDeleteProductVariant();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The options editor hides the button that opens it; closing it puts focus back there.
  const optionsButton = useReturnFocus<HTMLButtonElement>(optionsOpen);

  const confirmDelete = useConfirmDelete<CommerceVariant>({
    title: tv.confirmDelete,
    name: (variant) => variantTitle(variant) ?? variant.sku ?? tv.defaultTitle,
    onDelete: async (variant) => {
      try {
        await remove.mutateAsync({ productId, variantId: variant.id });
        toast.success(tv.toastDeleted);
      } catch (err) {
        toast.error(errorMessage(err, t.common.deleteFailed));
      }
    },
  });

  const handleGenerate = async (options: VariantOption[]) => {
    try {
      const result = await generate.mutateAsync({ productId, options });
      toast.success(fill(tv.options.generated, { created: result.data.created, kept: result.data.kept }));
      setOptionsOpen(false);
    } catch (err) {
      toast.error(errorMessage(err, t.common.saveFailed));
    }
  };

  const handleSave = async (variant: CommerceVariant, patch: UpdateVariantInput) => {
    try {
      await update.mutateAsync({ productId, variantId: variant.id, data: patch });
      toast.success(tv.toastUpdated);
      setEditingId(null);
      return true;
    } catch (err) {
      toast.error(saveError(err, tv.conflict, t.common.saveFailed));
      return false;
    }
  };

  if (isLoading) return <InlineSpinner />;
  if (error) return <InlineError className="mx-4 my-3">{tv.loadFailed}</InlineError>;

  return (
    <div className="space-y-2 pb-3">
      <div className="flex items-center justify-between pr-4">
        <SectionHeader>{tv.tab}</SectionHeader>
        {canEdit && !optionsOpen && (
          <Button
            ref={optionsButton}
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => setOptionsOpen(true)}
          >
            <Settings2 className="mr-1 h-3.5 w-3.5" />
            {variants.length > 0 ? tv.editOptions : tv.addOptions}
          </Button>
        )}
      </div>

      {optionsOpen && (
        <VariantOptionsEditor
          initialOptions={deriveOptions(variants, productOptions)}
          onGenerate={handleGenerate}
          isGenerating={generate.isPending}
          onCancel={() => setOptionsOpen(false)}
        />
      )}

      {variants.length === 0 ? (
        !optionsOpen && <ProseBlock>{tv.empty}</ProseBlock>
      ) : (
        <ul className="mx-4 divide-y divide-border border-y border-border">
          {variants.map((variant) => (
            <VariantRow
              key={variant.id}
              variant={variant}
              productPrice={productPrice}
              productVatCategory={productVatCategory}
              currency={currency}
              canEdit={canEdit}
              isEditing={editingId === variant.id}
              onEdit={() => setEditingId(variant.id)}
              onCancel={() => setEditingId(null)}
              onSave={(patch) => handleSave(variant, patch)}
              onDelete={() => confirmDelete.request(variant)}
            />
          ))}
        </ul>
      )}
      {confirmDelete.dialog}
    </div>
  );
}
