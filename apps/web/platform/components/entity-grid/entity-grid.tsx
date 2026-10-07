
import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { GridProvider, useGridContext } from './context';
import {
  GridToolbar,
  GridTable,
  GridSelectionBar,
  GridPagination,
} from './components';
import { EntityGridProps, GridSortConfig } from './types';

export function EntityGrid<TEntity>({
  config,
  actions,
  entities,
  pagination,
  searchParams,
  listName,
  availableLists = [],
  onLoadMore,
  hasMore,
  isFetchingMore,
  hideToolbar,
  hideToolbarSearch,
  hideToolbarFilter,
  toolbarActions,
}: Readonly<EntityGridProps<TEntity>>) {
  const router = useRouter();
  const searchParamsHook = useSearchParams();
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Search state initialized from URL
  const [searchValue, setSearchValue] = useState(searchParams?.search || '');

  // Sync search state when URL params change externally
  useEffect(() => {
    setSearchValue(searchParams?.search || '');
  }, [searchParams?.search]);

  // Sort — synced to the `sort`/`sortDir` URL params the same way search is,
  // so a paginated grid (which only ever holds one fetched page) can ask its
  // caller to re-fetch the whole result set in the new order rather than
  // reordering just the visible rows.
  const sortField = searchParams?.sort || null;
  const sortDirection = (searchParams?.sortDir as 'asc' | 'desc' | undefined) || null;
  const initialSort: GridSortConfig = { field: sortField, direction: sortField ? sortDirection : null };

  const handleSortChange = useCallback((sort: GridSortConfig) => {
    const params = new URLSearchParams(searchParamsHook?.toString() || '');
    if (sort.field) {
      params.set('sort', sort.field);
      if (sort.direction) params.set('sortDir', sort.direction);
      else params.delete('sortDir');
    } else {
      params.delete('sort');
      params.delete('sortDir');
    }
    router.push(`?${params.toString()}`);
  }, [router, searchParamsHook]);

  // Debounced search that updates URL params
  const handleSearchChange = useCallback((value: string) => {
    setSearchValue(value);

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParamsHook?.toString() || '');
      if (value) {
        params.set('search', value);
      } else {
        params.delete('search');
      }
      params.delete('page');
      router.push(`?${params.toString()}`);
    }, 300);
  }, [router, searchParamsHook]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  // Handle page navigation
  const handlePageChange = (page: number) => {
    const params = new URLSearchParams(searchParamsHook?.toString() || '');
    params.set('page', page.toString());
    router.push(`?${params.toString()}`);
  };

  
  
  return (
    <GridProvider
      config={config}
      actions={actions}
      entities={entities}
      pagination={pagination}
      initialSort={initialSort}
      onSortChange={handleSortChange}
    >
      <div
        data-testid="entity-grid"
        data-testid-entity={config.entityName.toLowerCase()}
        className="flex flex-col bg-background relative h-full overflow-hidden"
      >
        {/* Toolbar */}
        {!hideToolbar && (
          <GridToolbar
            onCreateEntity={actions.onCreateEntity}
            onImport={actions.onImport}
            onExportCSV={actions.onExportCSV}
            onExportExcel={actions.onExportExcel}
            createButtonLabel={`New ${config.entityName.toLowerCase()}`}
            searchValue={searchValue}
            onSearchChange={hideToolbarSearch ? undefined : handleSearchChange}
            // Use the config's own plural (e.g. "Companies", "People")
            // rather than naively appending "s" to the singular name, which
            // mangled irregular plurals ("Search companys...").
            searchPlaceholder={`Search ${(config.entityNamePlural || `${config.entityName}s`).toLowerCase()}...`}
            hideFilter={hideToolbarFilter}
            extraActions={toolbarActions}
          />
        )}

        {/* Table — GridFooter is rendered inside the table's scroll container
            (sticky bottom) so the calculation row scrolls horizontally with
            the table natively, eliminating the JS scroll-sync lag and the
            scroll-width drift at the right edge. */}
        <GridTable
          onLoadMore={onLoadMore}
          hasMore={hasMore}
          isFetchingMore={isFetchingMore}
        />

        {/* Selection Bar */}
        <GridSelectionBarWrapper
          availableLists={availableLists}
          actions={actions}
          listName={listName}
        />

        {/* Pagination (hidden when using infinite scroll) */}
        {!onLoadMore && pagination && pagination.totalPages > 1 && (
          <GridPagination onPageChange={handlePageChange} />
        )}
      </div>
    </GridProvider>
  );
}

// Wrapper component for selection bar to access context
function GridSelectionBarWrapper<TEntity>({
  availableLists,
  actions,
  listName,
}: Readonly<{
  availableLists: Array<{ id: string; title: string; color: string }>;
  actions: EntityGridProps<TEntity>['actions'];
  listName?: string;
}>) {
  const { state, setSelectedRows, setIsDeleting } = useGridContext<TEntity>();
  const { selectedRows, isDeleting } = state;

  const handleAddToList = async (listId: string) => {
    if (actions.onAddToList) {
      const ids = Array.from(selectedRows);
      await actions.onAddToList(ids, listId);
      setSelectedRows(new Set());
    }
  };

  const handleSendEmail = () => {
    if (actions.onSendEmail) {
      const ids = Array.from(selectedRows);
      actions.onSendEmail(ids);
    }
  };

  const handleBulkEdit = () => {
    if (actions.onBulkEdit) {
      const ids = Array.from(selectedRows);
      actions.onBulkEdit(ids, () => setSelectedRows(new Set()));
    }
  };

  const handleBulkDelete = async () => {
    if (actions.onBulkDelete) {
      setIsDeleting(true);
      try {
        const ids = Array.from(selectedRows);
        await actions.onBulkDelete(ids);
        setSelectedRows(new Set());
      } finally {
        setIsDeleting(false);
      }
    }
  };

  const customActions = actions.bulkActions?.map((action) => ({
    id: action.id,
    label: action.label,
    icon: action.icon,
    onClick: () => action.onAction(Array.from(selectedRows), () => setSelectedRows(new Set())),
  }));

  return (
    <GridSelectionBar
      availableLists={availableLists}
      onAddToList={actions.onAddToList ? handleAddToList : undefined}
      onSendEmail={actions.onSendEmail ? handleSendEmail : undefined}
      onBulkEdit={actions.onBulkEdit ? handleBulkEdit : undefined}
      onBulkDelete={actions.onBulkDelete ? handleBulkDelete : undefined}
      customActions={customActions}
      isDeleting={isDeleting}
      listName={listName}
    />
  );
}
