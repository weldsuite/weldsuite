/**
 * Column definitions for the WeldStash stock list.
 *
 * Read-only by design: stock levels are a projection of the inventory ledger
 * and move via `/inventory/adjust`, which also writes a movement row. The list
 * therefore offers no edit/delete row actions — the Adjust dialog is the only
 * write path.
 */

import type { WeldstashStockRow } from '@weldsuite/core-api-client/schemas/weldstash';
import type { ColumnDef } from '@/components/panel-entity-list';
import { getTranslations } from '@/lib/i18n';

export function buildStockColumns(): ColumnDef<WeldstashStockRow>[] {
  const t = getTranslations('common');
  return [
    {
      id: 'product',
      header: t.weldstash.stock.colProduct,
      width: 'flex-1',
      render: (s) => (
        <span className="font-medium truncate block">{s.productName ?? s.productId}</span>
      ),
    },
    {
      id: 'sku',
      header: t.weldstash.stock.colSku,
      width: 'w-[140px]',
      render: (s) => <span className="text-muted-foreground">{s.productSku ?? '—'}</span>,
    },
    {
      id: 'warehouse',
      header: t.weldstash.stock.colWarehouse,
      width: 'w-[180px]',
      render: (s) => (
        <span className="text-muted-foreground truncate block">
          {s.warehouseName ?? s.warehouseId}
        </span>
      ),
    },
    {
      id: 'onHand',
      header: t.weldstash.stock.colOnHand,
      width: 'w-[110px]',
      render: (s) => <span>{s.quantityOnHand}</span>,
    },
    {
      id: 'allocated',
      header: t.weldstash.stock.colAllocated,
      width: 'w-[110px]',
      render: (s) => <span className="text-muted-foreground">{s.quantityAllocated}</span>,
    },
    {
      id: 'available',
      header: t.weldstash.stock.colAvailable,
      width: 'w-[110px]',
      render: (s) => <span className="font-medium">{s.quantityAvailable}</span>,
    },
  ];
}
