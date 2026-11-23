import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { FolderTree } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useCreateIntent } from '@/hooks/use-create-intent';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useDeleteCommerceCategory, type CommerceCategory } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { useConfirmDelete } from '../../lib/use-confirm-delete';
import { errorMessage } from '../../lib/text';
import { buildCategoryColumns } from '../config/category-columns';
import { CategoryDialog } from './category-dialog';

interface CategoriesListProps {
  categories: CommerceCategory[];
  isLoading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
  /**
   * True when the rows arrived tree-ordered (parents immediately above their
   * children) rather than as a flat search result set.
   */
  showHierarchy: boolean;
}

export function CategoriesList({
  categories,
  isLoading,
  search,
  onSearchChange,
  onLoadMore,
  hasMore,
  isFetchingMore,
  showHierarchy,
}: Readonly<CategoriesListProps>) {
  const t = getTranslations('commerce');
  const tc = t.categories;
  const permissions = usePermissionsMaybe();
  const canCreate = permissions?.can('categories:create') ?? false;
  const canUpdate = permissions?.can('categories:update') ?? false;
  const canDelete = permissions?.can('categories:delete') ?? false;

  const deleteMut = useDeleteCommerceCategory();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcommerce/categories');

  const [createOpen, setCreateOpen] = useState(false);
  useCreateIntent(() => {
    if (canCreate) setCreateOpen(true);
  });
  const [editing, setEditing] = useState<CommerceCategory | undefined>();

  const columns = useMemo(() => buildCategoryColumns(showHierarchy), [showHierarchy]);

  const confirmDelete = useConfirmDelete<CommerceCategory>({
    title: tc.confirmDelete,
    name: (category) => category.name,
    onDelete: async (category) => {
      try {
        await deleteMut.mutateAsync(category.id);
        toast.success(tc.toastDeleted);
      } catch (err) {
        // The API refuses to orphan subcategories.
        toast.error(isApiError(err) && err.status === 409 ? tc.hasChildren : errorMessage(err, t.common.deleteFailed));
      }
    },
  });

  const create = canCreate ? { label: tc.newButton, onClick: () => setCreateOpen(true) } : undefined;

  return (
    <>
      <PanelEntityList<CommerceCategory>
        items={categories}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(c) => openObjectPanel({ type: 'category', id: c.id })}
        objectPanel={{ type: 'category' }}
        onEdit={canUpdate ? setEditing : undefined}
        onDelete={canDelete ? confirmDelete.request : undefined}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={tc.searchPlaceholder}
        createButton={create}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <FolderTree className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tc.empty,
          description: tc.emptyDescription,
          action: create,
        }}
        noResultsState={{ title: tc.noResults, description: t.common.noResultsHint }}
      />
      {confirmDelete.dialog}

      {createOpen && <CategoryDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {editing && <CategoryDialog open onOpenChange={(open) => !open && setEditing(undefined)} category={editing} />}
    </>
  );
}
