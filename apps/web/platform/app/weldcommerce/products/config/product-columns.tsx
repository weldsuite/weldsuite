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

export function formatMoney(amount: unknown, currency?: string | null): string {
  if (amount == null || amount === '') return '—';
  return `${Number(amount).toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

export function productStatusVariant(status: string | null | undefined) {
  return status === 'active' ? 'default' : status === 'draft' ? 'outline' : 'secondary';
}

export function buildProductColumns(): ColumnDef<CommerceProduct>[] {
  const t = getTranslations('commerce').module;
  return [
    {
      id: 'name',
      header: t.fields.name,
      width: 'flex-1',
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
      width: 'w-[150px]',
      render: (p) => <span className="text-muted-foreground">{p.sku ?? '—'}</span>,
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
      width: 'w-[100px]',
      render: (p) => <span>{p.inventoryQuantity ?? 0}</span>,
    },
    {
      id: 'brand',
      header: t.fields.brand,
      width: 'w-[130px]',
      render: (p) => <span className="text-muted-foreground truncate block">{p.brand ?? '—'}</span>,
    },
    {
      id: 'salesChannels',
      header: t.products.salesChannels,
      width: 'w-[220px]',
      render: (p) => (
        <ProductSalesChannelsEditor
          productId={p.id}
          channels={p.salesChannels ?? []}
          compact
        />
      ),
    },
    {
      id: 'status',
      header: t.fields.status,
      width: 'w-[120px]',
      render: (p) => (
        <Badge variant={productStatusVariant(p.status)} className="capitalize">
          {p.status}
        </Badge>
      ),
    },
  ];
}
