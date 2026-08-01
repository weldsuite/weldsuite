/**
 * Column definitions for the WeldStash products list.
 *
 * Same `products` table as WeldCommerce, different lens: the warehouse view
 * drops price/brand and shows stock, low-stock threshold and tracking instead.
 * The shared cells are imported rather than re-declared.
 */

import { Badge } from '@weldsuite/ui/components/badge';
import type { WeldstashProduct } from '@weldsuite/core-api-client/schemas/weldstash';
import type { ColumnDef } from '@/components/panel-entity-list';
import { getTranslations } from '@/lib/i18n';
import { productStatusVariant } from '@/app/weldcommerce/products/config/product-columns';

export function buildWeldstashProductColumns(): ColumnDef<WeldstashProduct>[] {
  const t = getTranslations('commerce').module;
  return [
    {
      id: 'name',
      header: t.fields.name,
      width: 'flex-1',
      render: (p) => <span className="font-medium truncate block">{p.name}</span>,
    },
    {
      id: 'sku',
      header: t.fields.sku,
      width: 'w-[150px]',
      render: (p) => <span className="text-muted-foreground">{p.sku ?? '—'}</span>,
    },
    {
      id: 'stock',
      header: t.fields.stock,
      width: 'w-[100px]',
      render: (p) => {
        const qty = p.inventoryQuantity ?? 0;
        const low = p.lowStockThreshold;
        const isLow = low != null && qty <= low;
        return (
          <span className={isLow ? 'text-amber-600 dark:text-amber-400 font-medium' : undefined}>
            {qty}
          </span>
        );
      },
    },
    {
      id: 'lowStockThreshold',
      header: t.fields.lowStockAt,
      width: 'w-[120px]',
      render: (p) => <span className="text-muted-foreground">{p.lowStockThreshold ?? '—'}</span>,
    },
    {
      id: 'trackInventory',
      header: t.fields.tracked,
      width: 'w-[110px]',
      render: (p) => (
        <span className="text-muted-foreground">
          {p.trackInventory === false ? t.common.no : t.common.yes}
        </span>
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
