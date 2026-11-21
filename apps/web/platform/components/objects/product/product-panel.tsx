/**
 * Product object panel.
 *
 * Tabs are product-specific (see `product-tabs.ts`) rather than the CRM
 * default set — a product has no emails or meetings; it has images, a stock
 * position and a movement history.
 *
 * Opened inside WeldCommerce (the member's current app), the panel also
 * shows the product's variants and its categories, and links to the
 * WeldCommerce product list. Elsewhere it is WeldStash's panel, unchanged.
 */

import { Badge } from '@weldsuite/ui/components/badge';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { isFeatureAvailable } from '@/lib/edition';
import { ProductSuppliersSection } from '@/app/weldstash/product-suppliers/components/product-suppliers-section';
import { ProductVariantsSection } from '@/app/weldcommerce/products/components/product-variants-section';
import { ProductCategoriesSection } from '@/app/weldcommerce/products/components/product-categories-section';
import { ProductPricesSection } from '@/app/weldcommerce/products/components/product-prices-section';
import {
  useWeldstashProduct,
  useWeldstashStock,
  useWeldstashMovements,
} from '@/hooks/queries/use-weldstash-queries';
import {
  SimpleObjectPanel,
  formatPanelDate,
  formatPanelMoney,
  SectionHeader,
  ProseBlock,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';
import { vatCategoryLabel } from '@/app/weldcommerce/lib/vat';
import { getProductTabs } from './product-tabs';

/** Which of the optional tabs this member sees, and whether they may edit variants. */
function usePanelAccess() {
  // Product suppliers are served by the Rust backend only (Kubernetes editions).
  const permissions = usePermissionsMaybe();
  const showSuppliers = isFeatureAvailable('stash-replenishment') && (permissions?.can('weldstash:suppliers:read') ?? false);

  // Variants and categories belong to WeldCommerce (Rust only), so they show
  // where the member is in WeldCommerce; checks then run against that app.
  const inCommerce = isFeatureAvailable('commerce') && permissions?.app === 'weldcommerce';
  return {
    showSuppliers,
    inCommerce,
    canEditVariants: inCommerce && (permissions?.can('products:update') ?? false),
    showCategories: inCommerce && (permissions?.can('categories:read') ?? false),
  };
}

export function ProductPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = getTranslations('weldstash');
  const tw = getTranslations('weldstashPurchasing').productSuppliers;
  const { id } = props;
  const { data, isLoading, error } = useWeldstashProduct(id);
  const product = data?.data;

  const { data: stock } = useWeldstashStock({ limit: 50, productId: id });
  const { data: movements } = useWeldstashMovements({ limit: 25, productId: id }, !!product);

  const stockRows = stock?.data ?? [];
  const movementRows = movements?.data ?? [];
  const images = product?.images ?? [];

  const totalOnHand = stockRows.reduce((sum, r) => sum + (r.quantityOnHand ?? 0), 0);

  const { showSuppliers, inCommerce, canEditVariants, showCategories } = usePanelAccess();
  const tc = getTranslations('commerce');
  // "Open" leads to the product list of the app the panel was opened in.
  const listApp = inCommerce ? 'weldcommerce' : 'weldstash';

  const tabs = getProductTabs({
    suppliers: showSuppliers ? tw.titleForProduct : undefined,
    variants: inCommerce ? tc.variants.tab : undefined,
    prices: inCommerce ? tc.prices.tab : undefined,
    categories: showCategories ? tc.productCategories.tab : undefined,
    details: t.panel.tabDetails,
    stock: t.panel.tabStock,
    movements: t.panel.tabMovements,
  });

  const renderTab = (tabId: string) => {
    if (tabId === 'variants' && inCommerce) {
      return (
        <ProductVariantsSection
          productId={id}
          productPrice={product?.price}
          currency={product?.currency}
          productOptions={product?.options}
          productVatCategory={product?.vatCategory ?? 'standard'}
          canEdit={canEditVariants}
        />
      );
    }

    if (tabId === 'prices' && inCommerce) {
      return (
        <ProductPricesSection
          productId={id}
          basePrice={product?.price}
          baseCurrency={product?.currency}
          canEdit={canEditVariants}
        />
      );
    }

    if (tabId === 'categories' && showCategories) {
      return <ProductCategoriesSection productId={id} />;
    }

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
                <span className="ml-2 text-foreground">{formatPanelDate(m.createdAt)}</span>
              </span>
            )}
          />
        </div>
      );
    }

    if (tabId === 'suppliers' && showSuppliers) {
      return <ProductSuppliersSection side="product" productId={id} />;
    }

    return null;
  };

  return (
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
            className="size-[22px] rounded-[8px] object-cover bg-muted"
          />
        ) : undefined
      }
      openHref={product ? `/${listApp}/products?stack=product:${encodeURIComponent(product.id)}` : undefined}
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
              ...(inCommerce ? [{ label: tc.products.vat.label, value: vatCategoryLabel(product.vatCategory ?? 'standard') }] : []),
              { label: t.fields.brand, value: product.brand },
              { label: t.fields.vendor, value: product.vendor },
              { label: t.fields.created, value: formatPanelDate(product.createdAt), tabular: true },
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
  );
}
