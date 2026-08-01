import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Package } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useDeleteWeldstashProduct } from '@/hooks/queries/use-weldstash-queries';
import type { WeldstashProduct } from '@weldsuite/core-api-client/schemas/weldstash';
import { getTranslations } from '@/lib/i18n';
import { buildWeldstashProductColumns } from '../config/product-columns';
// Same `products` table as WeldCommerce, so the form is shared rather than forked.
import { ProductDialog } from '@/app/weldcommerce/products/components/product-dialog';

interface ProductsListProps {
  products: WeldstashProduct[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

export function ProductsList({
  products,
  isLoading,
  search,
  onSearchChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: ProductsListProps) {
  const t = getTranslations('commerce').module;
  const deleteMut = useDeleteWeldstashProduct();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldstash/products');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WeldstashProduct | undefined>();

  const columns = useMemo(() => buildWeldstashProductColumns(), []);

  const handleDelete = async (product: WeldstashProduct) => {
    if (!confirm(t.products.confirmDelete)) return;
    try {
      await deleteMut.mutateAsync(product.id);
      toast.success(t.products.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message || t.common.deleteFailed);
    }
  };

  return (
    <>
      <PanelEntityList<WeldstashProduct>
        items={products}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(p) => openObjectPanel({ type: 'product', id: p.id })}
        onEdit={setEditing}
        onDelete={handleDelete}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={t.products.searchPlaceholder}
        createButton={{ label: t.products.newButton, onClick: () => setCreateOpen(true) }}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Package className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: t.products.empty,
          description: t.products.searchPlaceholder,
          action: { label: t.products.newButton, onClick: () => setCreateOpen(true) },
        }}
      />

      {createOpen && <ProductDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {editing && (
        <ProductDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(undefined)}
          product={editing}
        />
      )}
    </>
  );
}
