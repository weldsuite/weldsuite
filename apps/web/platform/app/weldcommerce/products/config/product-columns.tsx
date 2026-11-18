/**
 * Column definitions for the WeldCommerce products list.
 *
 * `products` is shared with WeldStash — the same rows back both modules — so
 * the WMS list imports these and swaps in its own lens rather than forking.
 */

import { Badge } from '@weldsuite/ui/components/badge';
import type { ColumnDef } from '@/components/panel-entity-list';
import { getTranslations } from '@/lib/i18n';
import type { CommerceProduct } from '@/hooks/queries/use-commerce-queries';
import { ProductSalesChannelsEditor } from '../components/product-sales-channels-editor';

/**
 * An amount as the lists show it: in the row's currency, formatted the same
 * way as the object panel (`formatPanelMoney`), so "$19.99" is "$19.99" in both.
 * Without a usable currency code the plain amount is shown rather than a
 * guessed currency.
 */
export function formatMoney(amount: unknown, currency?: string | null): string {
  if (amount == null || amount === '') return '—';
  const num = Number(amount);
  if (Number.isNaN(num)) return String(amount);
  const code = currency?.trim().toUpperCase();
  if (code && /^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(num);
    } catch {
      return `${num.toFixed(2)} ${code}`;
    }
  }
  return num.toFixed(2);
}

/**
 * Column widths of the commerce lists. The first column grows and keeps a
 * minimum width; the others appear as the list gets wider (`@…/list` is the
 * list's own width, see `PanelEntityList`), least important last, so the
 * first column is never squeezed to nothing on a laptop, a phone, or next to
 * an open panel.
 */
export const LIST_PRIMARY_COLUMN = 'flex-1 min-w-[140px]';

export function productStatusVariant(status: string | null | undefined) {
  if (status === 'active') return 'default';
  if (status === 'draft') return 'outline';
  return 'secondary';
}

export function buildProductColumns(): ColumnDef<CommerceProduct>[] {
  const t = getTranslations('commerce').module;
  return [
    {
      id: 'name',
      header: t.fields.name,
      width: LIST_PRIMARY_COLUMN,
      render: (p) => (
        <span className="flex min-w-0 items-center gap-2">
          {p.featuredImageUrl ? (
            <img
              src={p.featuredImageUrl}
              alt=""
              className="h-8 w-8 shrink-0 rounded object-cover bg-muted"
            />
          ) : (
            <span className="h-8 w-8 shrink-0 rounded bg-muted" aria-hidden="true" />
          )}
          <span className="truncate font-medium">{p.name}</span>
        </span>
      ),
    },
    {
      id: 'sku',
      header: t.fields.sku,
      width: 'hidden @3xl/list:block w-[150px]',
      render: (p) => <span className="text-muted-foreground truncate block">{p.sku?.trim() || '—'}</span>,
    },
    {
      id: 'price',
      header: t.fields.price,
      width: 'w-[130px]',
      render: (p) => <span>{formatMoney(p.price, p.currency)}</span>,
    },
    {
      id: 'stock',
      header: t.fields.stock,
      width: 'hidden @4xl/list:block w-[100px]',
      render: (p) => <span>{p.inventoryQuantity ?? 0}</span>,
    },
    {
      id: 'brand',
      header: t.fields.brand,
      width: 'hidden @7xl/list:block w-[130px]',
      render: (p) => <span className="text-muted-foreground truncate block">{p.brand?.trim() || '—'}</span>,
    },
    {
      id: 'salesChannels',
      header: t.products.salesChannels,
      width: 'hidden @6xl/list:block w-[280px]',
      render: (p) => (
        <ProductSalesChannelsEditor
          productId={p.id}
          channels={p.salesChannels ?? []}
          compact
          catalogPrice={p.price}
          catalogStatus={p.status}
          currency={p.currency}
        />
      ),
    },
    {
      id: 'status',
      header: t.fields.status,
      width: 'hidden @lg/list:block w-[120px]',
      render: (p) => (
        <Badge variant={productStatusVariant(p.status)} className="capitalize">
          {p.status}
        </Badge>
      ),
    },
  ];
}
