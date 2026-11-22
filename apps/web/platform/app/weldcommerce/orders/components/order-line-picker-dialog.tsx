/**
 * Picks what to put on an order line: search the catalogue by name or SKU,
 * and for a product with variants choose the variant in a second step.
 *
 * Products come from the same `/products` search WeldStash and the category
 * picker use; a product's variants from `/products/:id/variants` (phase 1).
 * Picking calls `onPick` once and closes the dialog.
 */

import { useMemo, useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { useDebounce } from '@/hooks/use-debounce';
import { useWeldstashProducts } from '@/hooks/queries/use-weldstash-queries';
import { useProductVariants, type CommerceProduct, type CommerceVariant } from '@/hooks/queries/use-commerce-queries';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { fill } from '../../lib/text';
import { money } from '../../lib/orders';
import type { LineValues } from '../../lib/order-form';

function newLine(product: CommerceProduct, variant: CommerceVariant | null): LineValues {
  return {
    productId: product.id,
    variantId: variant?.id ?? null,
    sku: variant?.sku ?? product.sku ?? null,
    name: product.name,
    variantName: variant?.name?.trim() || null,
    quantity: 1,
    unitPrice: '',
  };
}

function Thumbnail({ url }: Readonly<{ url: string | null | undefined }>) {
  if (!url) return <span className="h-8 w-8 shrink-0 rounded bg-muted" aria-hidden="true" />;
  // Up to 20 rows in a scroll box: load the thumbnails as they scroll into view.
  return <img src={url} alt="" width={32} height={32} loading="lazy" className="h-8 w-8 shrink-0 rounded object-cover bg-muted" />;
}

const ROW = 'flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50';

function VariantStep({
  product,
  onBack,
  onPick,
}: Readonly<{ product: CommerceProduct; onBack: () => void; onPick: (line: LineValues) => void }>) {
  const t = getTranslations('commerce').orders.picker;
  const { data, isLoading, isError } = useProductVariants(product.id);
  const variants = (data?.data ?? []).filter((variant) => variant.status !== 'archived');

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          {t.back}
        </Button>
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{fill(t.variantsOf, { name: product.name })}</h3>
      </div>
      <div className="max-h-[320px] overflow-y-auto rounded-md border">
        {isLoading && <InlineSpinner className="py-6" />}
        {isError && <ErrorBanner error={t.loadFailed} />}
        {!isLoading && !isError && variants.length === 0 && <EmptyText>{t.noVariants}</EmptyText>}
        {variants.map((variant) => (
          <button key={variant.id} type="button" className={ROW} onClick={() => onPick(newLine(product, variant))}>
            <Thumbnail url={product.featuredImageUrl} />
            <span className="min-w-0 flex-1 truncate text-sm">
              {variant.name?.trim() || product.name}
              {variant.sku && <span className="text-muted-foreground"> · {variant.sku}</span>}
            </span>
            <span className="text-sm tabular-nums text-muted-foreground">
              {money(variant.price ?? product.price, variant.currency ?? product.currency)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ProductStep({ onChoose }: Readonly<{ onChoose: (product: CommerceProduct) => void }>) {
  const t = getTranslations('commerce').orders.picker;
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search.trim(), 300);
  const params = useMemo(() => ({ limit: 20, status: 'active', search: debouncedSearch || undefined }), [debouncedSearch]);
  const { data, isLoading, isError } = useWeldstashProducts(params);
  const rows: CommerceProduct[] = data?.data ?? [];
  // Said after each search, for whoever can't see the list change.
  const found = debouncedSearch && !isLoading ? plural(data?.pagination?.totalCount ?? rows.length, t.found, getLocale()) : '';

  return (
    <div className="grid gap-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <Input
          autoFocus
          type="search"
          aria-label={t.searchPlaceholder}
          placeholder={t.searchPlaceholder}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="pl-8"
        />
      </div>
      <p role="status" className="sr-only">
        {found}
      </p>
      <div className="max-h-[320px] overflow-y-auto rounded-md border">
        {isLoading && <InlineSpinner className="py-6" />}
        {isError && <ErrorBanner error={t.loadFailed} />}
        {!isLoading && !isError && rows.length === 0 && <EmptyText>{t.empty}</EmptyText>}
        {rows.map((product) => (
          <button key={product.id} type="button" className={ROW} onClick={() => onChoose(product)}>
            <Thumbnail url={product.featuredImageUrl} />
            <span className="min-w-0 flex-1 truncate text-sm">
              {product.name}
              {product.sku && <span className="text-muted-foreground"> · {product.sku}</span>}
            </span>
            <span className="text-right text-sm tabular-nums text-muted-foreground">
              {product.variantCount ? plural(product.variantCount, t.variants, getLocale()) : money(product.price, product.currency)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function OrderLinePickerDialog({
  open,
  onOpenChange,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (line: LineValues) => void;
}>) {
  const t = getTranslations('commerce').orders.picker;
  const [product, setProduct] = useState<CommerceProduct | null>(null);

  const pick = (line: LineValues) => {
    onPick(line);
    setProduct(null);
    onOpenChange(false);
  };
  const choose = (chosen: CommerceProduct) => {
    if (chosen.variantCount) setProduct(chosen);
    else pick(newLine(chosen, null));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProduct(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
        </DialogHeader>
        {product ? <VariantStep product={product} onBack={() => setProduct(null)} onPick={pick} /> : <ProductStep onChoose={choose} />}
      </DialogContent>
    </Dialog>
  );
}
