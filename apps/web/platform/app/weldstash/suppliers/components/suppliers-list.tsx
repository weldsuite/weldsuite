import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Truck } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import {
  useDeleteWeldstashSupplier,
  type WmsSupplier,
} from '@/hooks/queries/use-weldstash-queries';
import { getTranslations } from '@/lib/i18n';
import { buildSupplierColumns } from '../config/supplier-columns';
import { SupplierDialog } from './supplier-dialog';

interface SuppliersListProps {
  suppliers: WmsSupplier[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

export function SuppliersList({
  suppliers,
  isLoading,
  search,
  onSearchChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: SuppliersListProps) {
  const t = getTranslations('commerce').module;
  const ts = getTranslations('common');
  const deleteMut = useDeleteWeldstashSupplier();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldstash/suppliers');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WmsSupplier | undefined>();

  const columns = useMemo(() => buildSupplierColumns(), []);

  const handleDelete = async (supplier: WmsSupplier) => {
    if (!confirm(ts.weldstash.suppliers.confirmDelete)) return;
    try {
      await deleteMut.mutateAsync(supplier.id);
      toast.success(ts.weldstash.suppliers.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message || t.common.deleteFailed);
    }
  };

  return (
    <>
      <PanelEntityList<WmsSupplier>
        items={suppliers}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(s) => openObjectPanel({ type: 'supplier', id: s.id })}
        onEdit={setEditing}
        onDelete={handleDelete}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={ts.weldstash.suppliers.searchPlaceholder}
        createButton={{
          label: ts.weldstash.suppliers.newSupplier,
          onClick: () => setCreateOpen(true),
        }}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Truck className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: ts.weldstash.suppliers.empty,
          description: ts.weldstash.suppliers.searchPlaceholder,
          action: {
            label: ts.weldstash.suppliers.newSupplier,
            onClick: () => setCreateOpen(true),
          },
        }}
      />

      {createOpen && <SupplierDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {editing && (
        <SupplierDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(undefined)}
          supplier={editing}
        />
      )}
    </>
  );
}
