import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Package } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import {
  useDeleteCommerceProduct,
  type CommerceProduct,
} from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { buildProductColumns } from '../config/product-columns';
import { ProductDialog } from './product-dialog';

interface ProductsListProps {
  products: CommerceProduct[];
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
  const deleteMut = useDeleteCommerceProduct();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcommerce/products');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CommerceProduct | undefined>();

  const columns = useMemo(() => buildProductColumns(), []);

  const handleDelete = async (product: CommerceProduct) => {
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
      <PanelEntityList<CommerceProduct>
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
