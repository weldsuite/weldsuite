import { useState, useMemo } from 'react';
import { Boxes } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import type { WeldstashStockRow } from '@weldsuite/core-api-client/schemas/weldstash';
import { getTranslations } from '@/lib/i18n';
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
}: StockListProps) {
  const t = getTranslations('common');
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldstash/stock');

  const [adjustOpen, setAdjustOpen] = useState(false);

  const columns = useMemo(() => buildStockColumns(), []);

  return (
    <>
      <PanelEntityList<WeldstashStockRow>
        items={stock}
        isLoading={isLoading}
        columns={columns}
        // A stock row's subject is its product, so that's what opens.
        onRowClick={(row) => openObjectPanel({ type: 'product', id: row.productId })}
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
