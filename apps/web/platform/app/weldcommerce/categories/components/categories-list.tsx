import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { FolderTree } from 'lucide-react';
import { EmptyStateIllustration } from '@/components/entity-list';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import {
  useDeleteCommerceCategory,
  type CommerceCategory,
} from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
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
}: CategoriesListProps) {
  const t = getTranslations('commerce').module;
  const deleteMut = useDeleteCommerceCategory();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldcommerce/categories');

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CommerceCategory | undefined>();

  const columns = useMemo(() => buildCategoryColumns(showHierarchy), [showHierarchy]);

  const handleDelete = async (category: CommerceCategory) => {
    if (!confirm(t.categories.confirmDelete)) return;
    try {
      await deleteMut.mutateAsync(category.id);
      toast.success(t.categories.toastDeleted);
    } catch (err) {
      // The API refuses to orphan children — surface its message verbatim.
      toast.error((err as Error).message || t.common.deleteFailed);
    }
  };

  return (
    <>
      <PanelEntityList<CommerceCategory>
        items={categories}
        isLoading={isLoading}
        columns={columns}
        onRowClick={(c) => openObjectPanel({ type: 'category', id: c.id })}
        onEdit={setEditing}
        onDelete={handleDelete}
        searchQuery={search}
        onSearchChange={onSearchChange}
        searchPlaceholder={t.categories.searchPlaceholder}
        createButton={{ label: t.categories.newButton, onClick: () => setCreateOpen(true) }}
        hasMore={hasMore}
        isLoadingMore={isFetchingMore}
        onLoadMore={onLoadMore}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <FolderTree className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: t.categories.empty,
          description: t.categories.searchPlaceholder,
          action: { label: t.categories.newButton, onClick: () => setCreateOpen(true) },
        }}
      />

      {createOpen && <CategoryDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {editing && (
        <CategoryDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(undefined)}
          category={editing}
        />
      )}
    </>
  );
}
