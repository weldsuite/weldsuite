import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Warehouse } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useDeleteWeldstashWarehouse } from '@/hooks/queries/use-weldstash-queries';
import type { WeldstashWarehouse } from '@weldsuite/core-api-client/schemas/weldstash';
import { getTranslations } from '@/lib/i18n';
import { buildWarehouseColumns } from '../config/warehouse-columns';
import { WarehouseDialog } from './warehouse-dialog';

interface WarehousesListProps {
  warehouses: WeldstashWarehouse[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

export function WarehousesList({
  warehouses,
  isLoading,
  search,
  onSearchChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: WarehousesListProps) {
  const t = getTranslations('commerce').module;
  const ts = getTranslations('common');
  const deleteMut = useDeleteWeldstashWarehouse();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldstash/warehouses');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WeldstashWarehouse | undefined>();

  const columns = useMemo(() => buildWarehouseColumns(), []);

  const handleDelete = async (warehouse: WeldstashWarehouse) => {
    if (!confirm(ts.weldstash.warehouses.confirmDelete)) return;
    try {
      await deleteMut.mutateAsync(warehouse.id);
      toast.success(ts.weldstash.warehouses.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message || t.common.deleteFailed);
    }
  };

  return (
    <>
      <PanelEntityList<WeldstashWarehouse>
        items={warehouses}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(w) => openObjectPanel({ type: 'warehouse', id: w.id })}
        onEdit={setEditing}
        onDelete={handleDelete}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={ts.weldstash.warehouses.searchPlaceholder}
        createButton={{
          label: ts.weldstash.warehouses.newWarehouse,
          onClick: () => setCreateOpen(true),
        }}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Warehouse className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: ts.weldstash.warehouses.empty,
          description: ts.weldstash.warehouses.searchPlaceholder,
          action: {
            label: ts.weldstash.warehouses.newWarehouse,
            onClick: () => setCreateOpen(true),
          },
        }}
      />

      {createOpen && <WarehouseDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {editing && (
        <WarehouseDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(undefined)}
          warehouse={editing}
        />
      )}
    </>
  );
}
