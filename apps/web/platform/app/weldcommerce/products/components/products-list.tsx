import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Package } from 'lucide-react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useCreateIntent } from '@/hooks/use-create-intent';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useDeleteWeldstashProduct } from '@/hooks/queries/use-weldstash-queries';
import type { CommerceProduct } from '@/hooks/queries/use-commerce-queries';
import { ProductDialog } from '@/app/weldstash/products/components/product-dialog';
import { getTranslations } from '@/lib/i18n';
import { useConfirmDelete } from '../../lib/use-confirm-delete';
import { errorMessage } from '../../lib/text';
import { buildProductColumns } from '../config/product-columns';

interface ProductsListProps {
  products: CommerceProduct[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

/**
 * The WeldCommerce product list. The rows, the product form and the delete
 * are WeldStash's (one catalogue, `/products`); this list adds the selling
 * columns, and the product panel it opens adds variants and categories.
 * Create, edit and delete show only to a member who may do them.
 */
export function ProductsList({
  products,
  isLoading,
  search,
  onSearchChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: Readonly<ProductsListProps>) {
  const t = getTranslations('commerce');
  const permissions = usePermissionsMaybe();
  const canCreate = permissions?.can('products:create') ?? false;
  const canUpdate = permissions?.can('products:update') ?? false;
  const canDelete = permissions?.can('products:delete') ?? false;

  const deleteMut = useDeleteWeldstashProduct();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcommerce/products');

  const [createOpen, setCreateOpen] = useState(false);
  useCreateIntent(() => {
    if (canCreate) setCreateOpen(true);
  });
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
        toast.error(errorMessage(err, t.common.deleteFailed));
      }
    },
  });

  const create = canCreate ? { label: t.products.newButton, onClick: () => setCreateOpen(true) } : undefined;

  return (
    <>
      <PanelEntityList<CommerceProduct>
        items={products}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(p) => openObjectPanel({ type: 'product', id: p.id })}
        objectPanel={{ type: 'product' }}
        onEdit={canUpdate ? setEditing : undefined}
        onDelete={canDelete ? confirmDelete.request : undefined}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={t.products.searchPlaceholder}
        createButton={create}
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
          action: create,
        }}
        noResultsState={{ title: t.products.noResults, description: t.common.noResultsHint }}
      />
      {confirmDelete.dialog}

      {createOpen && <ProductDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {editing && (
        <ProductDialog open onOpenChange={(open) => !open && setEditing(undefined)} product={editing} />
      )}
    </>
  );
}
