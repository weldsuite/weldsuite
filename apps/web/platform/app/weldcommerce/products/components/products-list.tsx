import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Package } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useCreateIntent } from '@/hooks/use-create-intent';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import {
  useDeleteCommerceProduct,
  type CommerceProduct,
} from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { useConfirmDelete } from '../../lib/use-confirm-delete';
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
}: Readonly<ProductsListProps>) {
  const t = getTranslations('commerce').module;
  const deleteMut = useDeleteCommerceProduct();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcommerce/products');

  const [createOpen, setCreateOpen] = useState(false);
  useCreateIntent(() => setCreateOpen(true));
  const [editing, setEditing] = useState<CommerceProduct | undefined>();

  const columns = useMemo(() => buildProductColumns(), []);

  const confirmDelete = useConfirmDelete<CommerceProduct>({
    title: t.products.confirmDelete,
    name: (product) => product.name,
    onDelete: async (product) => {
      try {
        await deleteMut.mutateAsync(product.id);
        toast.success(t.products.toastDeleted);
      } catch (err) {
        toast.error((err as Error).message || t.common.deleteFailed);
      }
    },
  });

  return (
    <>
      <PanelEntityList<CommerceProduct>
        items={products}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(p) => openObjectPanel({ type: 'product', id: p.id })}
        objectPanel={{ type: 'product' }}
        onEdit={setEditing}
        onDelete={confirmDelete.request}
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
          description: t.products.emptyDescription,
          action: { label: t.products.newButton, onClick: () => setCreateOpen(true) },
        }}
        noResultsState={{ title: t.products.noResults, description: t.common.noResultsHint }}
      />
      {confirmDelete.dialog}

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
