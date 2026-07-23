
import { useState, useMemo, useRef, useEffect } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Plus,
  Search,
  EllipsisVertical,
  Loader2,
  AlertCircle,
  XCircle,
  Pencil,
  Trash2,
  Copy,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import { FilterPills } from './filter-pills';
import type {
  EntityListProps,
  ActiveFilter,
  RowHandlers,
  HeaderColumn,
} from './types';

export function EntityList<T extends { id: string }>({
  // Data
  items,
  isLoading,
  error,

  // Configuration
  columns,
  headerColumns,
  filters: filterConfigs,
  groups,
  maxFilters = 5,

  // Filter logic
  applyFilters,

  // Handlers
  onUpdateItem,
  onDeleteItem,
  onDuplicateItem,

  // Row configuration
  renderRow,
  getRowClassName,

  // Dialog
  dialogComponent,

  // Empty states
  emptyState,
  noResultsState,

  // Create button
  createButton,

  // Additional action buttons
  actionButtons,

  // Left action buttons
  leftActionButtons,

  // Search
  searchPlaceholder = 'Search...',
  searchFields,

  // Controlled-mode props
  searchQuery: searchQueryProp,
  onSearchChange,
  activeFilters: activeFiltersProp,
  onFiltersChange,

  // Pagination
  hasMore,
  isLoadingMore,
  onLoadMore,

  // Sorting
  sortState,
  onSort,

  // Styling
  topBarClassName,
  hideTopBar,
  emptyStateClassName,
  itemsClassName,
  columnGap,
  stickyOffset = 0,
}: EntityListProps<T>) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [internalSearchQuery, setInternalSearchQuery] = useState('');
  const [internalActiveFilters, setInternalActiveFilters] = useState<ActiveFilter[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  const isSearchControlled = onSearchChange !== undefined;
  const isFiltersControlled = onFiltersChange !== undefined;
  const searchQuery = isSearchControlled ? (searchQueryProp ?? '') : internalSearchQuery;
  const activeFilters = isFiltersControlled ? (activeFiltersProp ?? []) : internalActiveFilters;
  const setSearchQuery = (q: string) => {
    if (isSearchControlled) onSearchChange!(q);
    else setInternalSearchQuery(q);
  };
  const setActiveFilters = (next: ActiveFilter[] | ((prev: ActiveFilter[]) => ActiveFilter[])) => {
    if (isFiltersControlled) {
      const resolved = typeof next === 'function' ? (next as (prev: ActiveFilter[]) => ActiveFilter[])(activeFilters) : next;
      onFiltersChange!(resolved);
    } else {
      setInternalActiveFilters(next);
    }
  };

  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  // Infinite-scroll sentinel — fires `onLoadMore` when the bottom of the list
  // becomes visible. Skipped entirely if `onLoadMore` isn't provided so client-
  // side consumers are unaffected.
  useEffect(() => {
    if (!onLoadMore) return;
    const node = loadMoreSentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !isLoadingMore) {
          onLoadMore();
        }
      },
      { rootMargin: '200px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, isLoadingMore]);

  // Row handlers for actions
  const rowHandlers: RowHandlers<T> = useMemo(() => ({
    onEdit: () => {}, // Will be overridden by parent
    onDelete: (id: string) => onDeleteItem?.(id),
    onDuplicate: (item: T) => onDuplicateItem?.(item),
    onUpdate: (id: string, data: Partial<T>) => onUpdateItem?.(id, data),
  }), [onDeleteItem, onDuplicateItem, onUpdateItem]);

  // Filter and search items. In controlled mode the parent has already
  // applied search / filters via the server, so we pass items through.
  const filteredItems = useMemo(() => {
    let result = items;

    if (!isSearchControlled && searchQuery && searchFields && searchFields.length > 0) {
      const query = searchQuery.toLowerCase();
      result = result.filter(item =>
        searchFields.some(field => {
          const value = item[field];
          return value && String(value).toLowerCase().includes(query);
        })
      );
    }

    if (!isFiltersControlled && applyFilters && activeFilters.length > 0) {
      result = applyFilters(result, activeFilters);
    }

    return result;
  }, [items, searchQuery, searchFields, activeFilters, applyFilters, isSearchControlled, isFiltersControlled]);

  // Group items if groups are configured
  const groupedItems = useMemo(() => {
    if (!groups || groups.length === 0) {
      return [{ id: 'all', label: '', items: filteredItems, sortOrder: 0 }];
    }

    const sorted = [...groups].sort((a, b) => a.sortOrder - b.sortOrder);
    const result: Array<{ id: string; label: string; items: T[]; sortOrder: number; rightContent?: React.ReactNode; leadingContent?: React.ReactNode }> = [];

    for (const group of sorted) {
      const groupItems = filteredItems.filter(group.filter);
      if (groupItems.length > 0) {
        result.push({
          id: group.id,
          label: group.label,
          items: groupItems,
          sortOrder: group.sortOrder,
          rightContent: group.rightContent,
          leadingContent: group.leadingContent,
        });
      }
    }

    return result;
  }, [filteredItems, groups]);

  const hasNoResults = items.length > 0 && filteredItems.length === 0;

  // Clear all filters
  const clearFilters = () => {
    setSearchQuery('');
    setSearchOpen(false);
    setActiveFilters([]);
  };

  // Render group header
  const renderGroupHeader = (label: string, count: number, rightContent?: React.ReactNode, leadingContent?: React.ReactNode) => (
    <div className="relative flex items-center gap-2 px-3 md:px-4 h-8 bg-background border-b border-border/70 sticky z-[9]" style={{ top: 35 + stickyOffset }}>
      <div className="absolute inset-0 bg-muted/50 pointer-events-none" />
      {leadingContent && <div className="relative flex items-center">{leadingContent}</div>}
      <span className="relative text-xs font-medium text-muted-foreground">{label}</span>
      <span className="relative text-[10px] font-mono text-muted-foreground bg-muted border border-border w-[16px] h-[16px] flex items-center justify-center rounded-[5px] -translate-y-px">
        <span className="translate-y-[1px]">{count}</span>
      </span>
      {rightContent && <div className="relative ml-auto flex items-center">{rightContent}</div>}
    </div>
  );

  // Default row actions
  const renderDefaultRowActions = (item: T) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100">
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); rowHandlers.onEdit(item); }}>
          <Pencil className="mr-0.5 h-4 w-4" />
          Edit
        </DropdownMenuItem>
        {onDuplicateItem && (
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); rowHandlers.onDuplicate(item); }}>
            <Copy className="mr-0.5 h-4 w-4" />
            Duplicate
          </DropdownMenuItem>
        )}
        {onDeleteItem && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={(e) => { e.stopPropagation(); rowHandlers.onDelete(item.id); }}
              className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
            >
              <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Default row renderer
  const defaultRenderRow = (item: T) => (
    <div
      key={item.id}
      className={cn(
        "flex items-center gap-4 px-4 py-3 border-b border-border/70 group",
        getRowClassName?.(item)
      )}
    >
      {columns?.map((column) => (
        <div key={column.id} className={column.width} onClick={(e) => e.stopPropagation()}>
          {column.render(item, rowHandlers)}
        </div>
      ))}
      <div className="w-[40px] flex justify-end">
        {renderDefaultRowActions(item)}
      </div>
    </div>
  );

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 h-full min-h-[60vh]">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle className="h-10 w-10 text-red-500 mb-4" />
        <p className="text-lg font-medium">Failed to load data</p>
        <p className="text-muted-foreground">Please try again later</p>
      </div>
    );
  }

  return (
    <div className="bg-background min-w-0 w-full overflow-x-hidden">
      {/* Top Bar */}
      {!hideTopBar && (
      <div className={cn("flex items-center justify-between px-3 md:px-4 h-[53px] border-b border-border", topBarClassName)}>
        <div className="hidden md:flex items-center gap-2">
          <FilterPills
            filters={activeFilters}
            filterConfigs={filterConfigs}
            maxFilters={maxFilters}
            onFiltersChange={setActiveFilters}
          />
          {leftActionButtons}
        </div>

        {/* Mobile: search always visible */}
        <div className="md:hidden flex-1 mr-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Desktop: Search toggle */}
          {searchFields && searchFields.length > 0 && (
            <div className="relative hidden md:flex items-center">
              <div
                className={cn(
                  "flex items-center transition-all duration-200 ease-out",
                  searchOpen ? "w-48" : "w-8"
                )}
              >
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200",
                    searchOpen && "opacity-0 pointer-events-none absolute"
                  )}
                  onClick={() => setSearchOpen(true)}
                >
                  <Search className="h-4 w-4" />
                </Button>
                <div className={cn(
                  "relative transition-all duration-200 ease-out",
                  searchOpen ? "opacity-100 w-48" : "opacity-0 w-0 pointer-events-none"
                )}>
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    placeholder={searchPlaceholder}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onBlur={() => !searchQuery && setSearchOpen(false)}
                    className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                  />
                </div>
              </div>
            </div>
          )}

          {actionButtons}

          {/* Create button */}
          {createButton && (
            <Button
              size="sm"
              className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 relative z-10"
              onClick={createButton.onClick}
            >
              <Plus className="h-4 w-4 md:mr-0.5" />
              <span className="hidden md:inline">{createButton.label}</span>
            </Button>
          )}
        </div>
      </div>
      )}

      {/* Table Header - hidden on mobile */}
      {(headerColumns || columns) && (
        <div className={cn("hidden md:flex items-center px-4 h-[35px] border-b border-border/70 sticky bg-background z-10", columnGap ?? 'gap-4')} style={{ top: stickyOffset }}>
          {(headerColumns || columns || []).map((column) => {
            const isSortable = 'sortable' in column && column.sortable && onSort;
            const isActive = sortState?.columnId === column.id;
            return (
              <div key={column.id} className={cn(column.width, 'className' in column ? column.className : ('headerClassName' in column ? column.headerClassName : undefined))}>
                {isSortable ? (
                  <button
                    type="button"
                    onClick={() => onSort(column.id)}
                    className={cn(
                      "flex items-center gap-1 text-xs font-medium cursor-pointer select-none hover:text-foreground transition-colors",
                      isActive ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {column.header}
                    {isActive ? (
                      sortState.direction === 'asc'
                        ? <ArrowUp className="h-3 w-3" />
                        : <ArrowDown className="h-3 w-3" />
                    ) : (
                      <ArrowUpDown className="h-3 w-3 opacity-0 group-hover/header:opacity-100" />
                    )}
                  </button>
                ) : (
                  <span className="text-xs font-medium text-muted-foreground">
                    {column.header}
                  </span>
                )}
              </div>
            );
          })}
          <div className="w-[40px]"></div>
        </div>
      )}

      {/* Grouped Items */}
      <div>
        {groupedItems.map((group) => (
          <div key={group.id}>
            {group.label && renderGroupHeader(group.label, group.items.length, group.rightContent, group.leadingContent)}
            {itemsClassName ? (
              <div className={itemsClassName}>
                {group.items.map((item) => renderRow ? renderRow(item, rowHandlers) : defaultRenderRow(item))}
              </div>
            ) : (
              group.items.map((item) => renderRow ? renderRow(item, rowHandlers) : defaultRenderRow(item))
            )}
          </div>
        ))}

        {/* Infinite-scroll sentinel — only present when controlled pagination is wired up.
            Padding is applied only while loading so the (otherwise empty) sentinel
            doesn't leave dead space below the last row once everything is loaded. */}
        {onLoadMore && items.length > 0 && (
          <div ref={loadMoreSentinelRef} className={cn("flex items-center justify-center", isLoadingMore && "py-4")}>
            {isLoadingMore && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
        )}

        {/* No search results state */}
        {hasNoResults && noResultsState && (
          <div className="flex flex-col items-center justify-center text-center min-h-[calc(100dvh-260px)]">
            <div className="relative mb-5">
              <div className="relative py-3">
                <div className="flex gap-2 mb-2">
                  <div className="w-10 h-7 border border-dashed border-border rounded-md" />
                  <div className="w-16 h-7 border border-dashed border-border rounded-md" />
                </div>
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 rounded-full border border-border bg-background flex items-center justify-center z-10">
                  {noResultsState.icon || <XCircle className="w-4 h-4 text-gray-400" />}
                </div>
                <div className="flex gap-2">
                  <div className="w-14 h-7 border border-dashed border-border rounded-md" />
                  <div className="w-11 h-7 border border-dashed border-border rounded-md" />
                </div>
              </div>
            </div>
            <h3 className="text-sm font-medium text-foreground mb-1">{noResultsState.title}</h3>
            <p className="text-sm text-muted-foreground mb-4">{noResultsState.description}</p>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filter
            </Button>
          </div>
        )}

        {/* Empty state */}
        {items.length === 0 && emptyState && (
          <div className={cn("flex flex-col items-center justify-center text-center px-6 min-h-[calc(100dvh-260px)]", emptyStateClassName)}>
            {emptyState.icon}
            <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{emptyState.title}</h3>
            <p className="text-sm text-muted-foreground mb-5 max-w-[320px] leading-relaxed whitespace-pre-line">{emptyState.description}</p>
            {(emptyState.action || emptyState.secondaryAction) && (
              <div className="flex items-center gap-2">
                {emptyState.action && (
                  <Button
                    size="sm"
                    className="bg-primary text-primary-foreground hover:bg-primary/90"
                    onClick={emptyState.action.onClick}
                  >
                    <Plus className="h-4 w-4 mr-0.5" />
                    <span>{emptyState.action.label}</span>
                  </Button>
                )}
                {emptyState.secondaryAction && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={emptyState.secondaryAction.onClick}
                  >
                    <span>{emptyState.secondaryAction.label}</span>
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dialog */}
      {dialogComponent}
    </div>
  );
}
