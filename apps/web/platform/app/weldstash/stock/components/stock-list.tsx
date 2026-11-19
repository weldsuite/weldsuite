import { useState, useMemo } from 'react';
import { Boxes } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import type { WeldstashStockRow } from '@weldsuite/core-api-client/schemas/weldstash';
import { getTranslations } from '@/lib/i18n';
import { useWeldstashWarehouses } from '@/hooks/queries/use-weldstash-queries';
import { buildStockColumns } from '../config/stock-columns';
import { AdjustStockDialog } from './adjust-stock-dialog';

interface StockListProps {
  stock: WeldstashStockRow[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

export function StockList({
  stock,
  isLoading,
  search,
  onSearchChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: Readonly<StockListProps>) {
  const t = getTranslations('common');
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldstash/stock');

  const [adjustOpen, setAdjustOpen] = useState(false);

  // Stock in a warehouse managed in Odoo is read-only here; its rows say so.
  const warehouses = useWeldstashWarehouses({ limit: 100 });
  const warehouseRows = warehouses.data?.data;
  const columns = useMemo(
    () => buildStockColumns(new Set((warehouseRows ?? []).filter((w) => w.managedByConnectionId).map((w) => w.id))),
    [warehouseRows],
  );

  return (
    <>
      <PanelEntityList<WeldstashStockRow>
        items={stock}
        isLoading={isLoading}
        columns={columns}
        // A stock row's subject is its product, so that's what opens.
        onRowClick={(row) => openObjectPanel({ type: 'product', id: row.productId })}
        objectPanel={{ type: 'product', getId: (row) => row.productId }}
        // No onEdit / onDelete: stock is a ledger projection. It moves through
        // /inventory/adjust, which also writes the movement row — an edit here
        // would change the level without its history.
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={t.weldstash.stock.searchPlaceholder}
        createButton={{ label: t.weldstash.stock.adjustTitle, onClick: () => setAdjustOpen(true) }}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Boxes className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: t.weldstash.stock.empty,
          description: t.weldstash.stock.readOnlyHint,
          action: { label: t.weldstash.stock.adjustTitle, onClick: () => setAdjustOpen(true) },
        }}
      />

      <AdjustStockDialog open={adjustOpen} onOpenChange={setAdjustOpen} />
    </>
  );
}
