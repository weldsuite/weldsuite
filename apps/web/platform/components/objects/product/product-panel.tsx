/**
 * Product object panel.
 *
 * Tabs are product-specific (see `product-tabs.ts`) rather than the CRM
 * default set — a product has no emails or meetings; it has images, a stock
 * position, a movement history and the categories it's filed under.
 */

import { useState } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { useObjectPanel } from '@/components/object-panel';
import {
  useCommerceProduct,
  useCommerceProductCategories,
  useAttachCategoryProducts,
  useDetachCategoryProduct,
} from '@/hooks/queries/use-commerce-queries';
import { useWeldstashStock, useWeldstashMovements } from '@/hooks/queries/use-weldstash-queries';
import {
  SimpleObjectPanel,
  formatPanelDate,
  formatPanelMoney,
  SectionHeader,
  ProseBlock,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { getProductTabs } from './product-tabs';
import { CategoryPickerDialog } from './category-picker-dialog';
import { ProductSalesChannelsEditor } from '@/app/weldcommerce/products/components/product-sales-channels-editor';

export function ProductPanel(props: ObjectPanelComponentProps) {
  const t = getTranslations('commerce').module;
  const { id } = props;
  const { open } = useObjectPanel();
  const { data, isLoading, error } = useCommerceProduct(id);
  const product = data?.data;

  const { data: stock } = useWeldstashStock({ limit: 50, productId: id });
  const { data: movements } = useWeldstashMovements({ limit: 25, productId: id }, !!product);
  const { data: categories } = useCommerceProductCategories(id, !!product);

  const stockRows = stock?.data ?? [];
  const movementRows = movements?.data ?? [];
  const categoryRows = categories?.data ?? [];
  const salesChannels = product?.salesChannels ?? [];
  const images = product?.images ?? [];

  const totalOnHand = stockRows.reduce((sum, r) => sum + (r.quantityOnHand ?? 0), 0);

  const attach = useAttachCategoryProducts();
  const detach = useDetachCategoryProduct();
  const [pickerOpen, setPickerOpen] = useState(false);

  const tabs = getProductTabs({
    details: t.panel.tabDetails,
    stock: t.panel.tabStock,
    movements: t.panel.tabMovements,
    categories: t.panel.tabCategories,
    salesChannels: t.panel.tabSalesChannels,
    categoryCount: categoryRows.length || undefined,
    salesChannelCount: salesChannels.length || undefined,
  });

  /** One call per category — the junction is written from the category side. */
  const handleAttach = async (categoryIds: string[]) => {
    try {
      for (const categoryId of categoryIds) {
        await attach.mutateAsync({ categoryId, productIds: [id] });
      }
      toast.success(t.linking.categoriesAdded.replace('{count}', String(categoryIds.length)));
    } catch (err) {
      toast.error((err as Error).message || t.common.saveFailed);
    }
  };

  const handleDetach = async (categoryId: string) => {
    try {
      await detach.mutateAsync({ categoryId, productId: id });
      toast.success(t.linking.categoryRemoved);
    } catch (err) {
      toast.error((err as Error).message || t.common.deleteFailed);
    }
  };

  const renderTab = (tabId: string) => {
    if (tabId === 'stock') {
      if (stockRows.length === 0) return <ProseBlock>{t.panel.noStock}</ProseBlock>;
      return (
        <div className="space-y-2">
          <SectionHeader>{t.panel.tabStock}</SectionHeader>
          <LineItemList
            items={stockRows}
            getKey={(r) => r.id}
            renderLeft={(r) => <span className="truncate">{r.warehouseName ?? r.warehouseId}</span>}
            renderRight={(r) => `${r.quantityAvailable} / ${r.quantityOnHand}`}
          />
          <p className="px-4 pb-2 text-xs text-muted-foreground">{t.panel.stockLegend}</p>
        </div>
      );
    }

    if (tabId === 'movements') {
      if (movementRows.length === 0) return <ProseBlock>{t.panel.noMovements}</ProseBlock>;
      return (
        <div className="space-y-2">
          <SectionHeader>{t.panel.tabMovements}</SectionHeader>
          <LineItemList
            items={movementRows}
            getKey={(m) => m.id}
            renderLeft={(m) => (
              <span className="truncate">
                <span className="capitalize">{m.movementType}</span>
                {m.reason ? <span className="text-muted-foreground"> · {m.reason}</span> : null}
              </span>
            )}
            renderRight={(m) => (
              <span className="tabular-nums">
                {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                <span className="ml-2 text-muted-foreground">{formatPanelDate(m.createdAt)}</span>
              </span>
            )}
          />
        </div>
      );
    }

    if (tabId === 'categories') {
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between px-4 pt-3">
            <SectionHeader>{t.panel.tabCategories}</SectionHeader>
            <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t.linking.addCategories}
            </Button>
          </div>

          {categoryRows.length === 0 ? (
            <ProseBlock>{t.panel.noCategories}</ProseBlock>
          ) : (
            <LineItemList
              items={categoryRows}
              getKey={(c) => c.id}
              renderLeft={(c) => (
                <button
                  type="button"
                  className="truncate text-left hover:underline"
                  // Indent mirrors the tree depth so nesting is visible here too.
                  style={{ paddingLeft: (c.depth ?? 0) * 12 }}
                  onClick={() => open({ type: 'category', id: c.id, stack: true })}
                >
                  {c.name}
                </button>
              )}
              renderRight={(c) => (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  title={t.linking.removeFromCategory}
                  onClick={() => void handleDetach(c.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            />
          )}
          <p className="px-4 pb-2 text-xs text-muted-foreground">{t.linking.manualOnlyNote}</p>
        </div>
      );
    }

    if (tabId === 'channels') {
      return (
        <div className="space-y-2 px-4 py-3">
          <ProductSalesChannelsEditor
            productId={id}
            channels={salesChannels}
            catalogPrice={product?.price}
            catalogStatus={product?.status}
            currency={product?.currency}
          />
        </div>
      );
    }

    return null;
  };

  return (
    <>
      <CategoryPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        existingIds={categoryRows.map((c) => c.id)}
        onConfirm={handleAttach}
        isSaving={attach.isPending}
      />

      <SimpleObjectPanel
        {...props}
        objectType="product"
        isLoading={isLoading}
        hasError={!!error}
        hasData={!!product}
        title={product?.name}
        subtitle={product?.sku ?? undefined}
        avatar={
          product?.featuredImageUrl ? (
            <img
              src={product.featuredImageUrl}
              alt=""
              className="h-7 w-7 rounded-lg object-cover bg-muted"
            />
          ) : undefined
        }
        openHref={product ? `/weldcommerce/products?open=${product.id}` : undefined}
        tabs={tabs}
        renderTab={renderTab}
        statusBadges={
          product && (
            <>
              <Badge
                variant={product.status === 'active' ? 'default' : 'secondary'}
                className="capitalize"
              >
                {product.status}
              </Badge>
              {product.brand && <Badge variant="outline">{product.brand}</Badge>}
              {product.trackInventory === false && (
                <Badge variant="outline">{t.panel.notTracked}</Badge>
              )}
            </>
          )
        }
        fields={
          product
            ? [
                { label: t.fields.sku, value: product.sku },
                { label: t.fields.barcode, value: product.barcode },
                { label: t.fields.price, value: formatPanelMoney(product.price, product.currency) },
                {
                  label: t.fields.costPrice,
                  value: formatPanelMoney(product.costPrice, product.currency),
                },
                // Sum across warehouses so this matches the Stock tab rather
                // than the single denormalised counter on the row.
                {
                  label: t.fields.stock,
                  value: stockRows.length > 0 ? totalOnHand : product.inventoryQuantity ?? 0,
                },
                { label: t.fields.lowStockAt, value: product.lowStockThreshold },
                { label: t.fields.brand, value: product.brand },
                { label: t.fields.vendor, value: product.vendor },
                {
                  label: t.products.salesChannels,
                  value: salesChannels.length
                    ? salesChannels
                        .map((c) => {
                          const name = c.displayName || c.provider;
                          const price = formatPanelMoney(c.price, product.currency);
                          return `${name} (${price}, ${c.listingStatus ?? 'active'})`;
                        })
                        .join(', ')
                    : t.products.salesChannelsNone,
                },
                { label: t.fields.created, value: formatPanelDate(product.createdAt) },
              ]
            : []
        }
        extras={
          product && (images.length > 0 || product.description) ? (
            <div className="space-y-3">
              {images.length > 0 && (
                <div className="space-y-1">
                  <SectionHeader>{t.images.label}</SectionHeader>
                  <div className="flex flex-wrap gap-2 px-4 pb-1">
                    {images.map((img, i) => (
                      <img
                        key={img.id ?? `${img.url}-${i}`}
                        src={img.url}
                        alt={img.altText ?? ''}
                        title={img.altText ?? undefined}
                        className="h-16 w-16 rounded-md border object-cover bg-muted"
                      />
                    ))}
                  </div>
                </div>
              )}
              {product.description && (
                <div className="space-y-1">
                  <SectionHeader>{t.fields.description}</SectionHeader>
                  <ProseBlock>{product.description}</ProseBlock>
                </div>
              )}
            </div>
          ) : undefined
        }
      />
    </>
  );
}
