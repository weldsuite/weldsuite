/**
 * Required CSS (add to app stylesheet alongside @weldsuite/app-sdk/ui/styles.css):
 *
 * .wui-elist — root; min-width 0; width 100%; background var(--wui-background)
 * .wui-elist-loading — flex center; min-height 60vh; gap 0.5rem
 * .wui-elist-error — flex column center; padding 5rem 1rem; text-align center
 * .wui-elist-topbar — flex; justify-between; align-items center; height 53px; padding 0 1rem; border-bottom
 * .wui-elist-topbar__left — flex; gap 0.5rem; align-items center (hidden on small screens via media query)
 * .wui-elist-topbar__right — flex; gap 0.5rem; align-items center
 * .wui-elist-search-mobile — flex-1; display block on small screens only
 * .wui-elist-search-wrap — position relative
 * .wui-elist-search-icon — absolute left; pointer-events none; color muted
 * .wui-elist-search-input — full width input height 2rem; padding-left for icon
 * .wui-elist-search-desktop — hidden on mobile; flex align center
 * .wui-elist-search-desktop--open — expanded width ~12rem
 * .wui-elist-search-desktop--closed — width 2rem
 * .wui-elist-header — sticky row; height 35px; border-bottom; display flex; padding 0 1rem; gap 1rem
 * .wui-elist-header__cell — flex child; font-size 0.75rem; font-weight 500; color muted
 * .wui-elist-header__sort — button reset; flex; gap 0.25rem; cursor pointer
 * .wui-elist-header__sort--active — foreground color
 * .wui-elist-group-header — sticky; flex; gap 0.5rem; height 2rem; padding 0 1rem; border-bottom; background muted tint
 * .wui-elist-group-header__count — mono badge 16px square
 * .wui-elist-row — flex; align-items center; gap 1rem; padding 0.75rem 1rem; border-bottom
 * .wui-elist-row--clickable — cursor pointer; hover background
 * .wui-elist-row__cell — min-width 0
 * .wui-elist-row__actions — width 40px; flex justify end
 * .wui-elist-row__menu-trigger — opacity 0; .wui-elist-row:hover & — opacity 1
 * .wui-elist-sentinel — flex center; optional padding when loading
 * .wui-elist-no-results — centered column; min-height calc(100dvh - 260px)
 * .wui-elist-no-results__graphic — relative decorative blocks
 * .wui-elist-empty — centered column; min-height calc(100dvh - 260px); padding 1.5rem
 * .wui-elist-empty__actions — flex gap 0.5rem
 * .wui-elist-icon — width/height 1rem; .wui-elist-icon--sm — 0.875rem
 * .wui-elist-icon--spin — animation spin
 * .wui-elist-filters, .wui-elist-filter-pill*, .wui-elist-filter-popover* — filter pill bar
 * .wui-dropdown-content, .wui-dropdown-item, .wui-dropdown-separator — row action menu
 * .wui-popover-content — filter popovers
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { cn } from '../cn';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { FilterPills } from './filter-pills';
import type { ActiveFilter, EntityListProps, RowHandlers } from './types';

export function EntityList<T extends { id: string }>({
  items,
  isLoading,
  error,
  columns,
  headerColumns,
  filters: filterConfigs = [],
  groups,
  maxFilters = 5,
  applyFilters,
  onUpdateItem,
  onDeleteItem,
  onDuplicateItem,
  renderRow,
  getRowClassName,
  renderRowActions,
  dialogComponent,
  emptyState,
  noResultsState,
  createButton,
  actionButtons,
  leftActionButtons,
  searchPlaceholder = 'Search...',
  searchFields,
  searchQuery: searchQueryProp,
  onSearchChange,
  activeFilters: activeFiltersProp,
  onFiltersChange,
  hasMore,
  isLoadingMore,
  onLoadMore,
  sortState,
  onSort,
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
  const activeFilters = useMemo(
    () => (isFiltersControlled ? (activeFiltersProp ?? []) : internalActiveFilters),
    [isFiltersControlled, activeFiltersProp, internalActiveFilters],
  );

  const setSearchQuery = (q: string) => {
    if (isSearchControlled) onSearchChange!(q);
    else setInternalSearchQuery(q);
  };

  const setActiveFilters = (next: ActiveFilter[] | ((prev: ActiveFilter[]) => ActiveFilter[])) => {
    if (isFiltersControlled) {
      const resolved =
        typeof next === 'function'
          ? (next as (prev: ActiveFilter[]) => ActiveFilter[])(activeFilters)
          : next;
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
      { rootMargin: '200px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, isLoadingMore]);

  const rowHandlers: RowHandlers<T> = useMemo(
    () => ({
      onEdit: () => {},
      onDelete: (id: string) => onDeleteItem?.(id),
      onDuplicate: (item: T) => onDuplicateItem?.(item),
      onUpdate: (id: string, data: Partial<T>) => onUpdateItem?.(id, data),
    }),
    [onDeleteItem, onDuplicateItem, onUpdateItem],
  );

  const filteredItems = useMemo(() => {
    let result = items;

    if (!isSearchControlled && searchQuery && searchFields && searchFields.length > 0) {
      const query = searchQuery.toLowerCase();
      result = result.filter((item) =>
        searchFields.some((field) => {
          const value = item[field];
          return value && String(value).toLowerCase().includes(query);
        }),
      );
    }

    if (!isFiltersControlled && applyFilters && activeFilters.length > 0) {
      result = applyFilters(result, activeFilters);
    }

    return result;
  }, [
    items,
    searchQuery,
    searchFields,
    activeFilters,
    applyFilters,
    isSearchControlled,
    isFiltersControlled,
  ]);

  const groupedItems = useMemo(() => {
    if (!groups || groups.length === 0) {
      return [{ id: 'all', label: '', items: filteredItems, sortOrder: 0 }];
    }

    const sorted = [...groups].sort((a, b) => a.sortOrder - b.sortOrder);
    const result: Array<{
      id: string;
      label: string;
      items: T[];
      sortOrder: number;
      rightContent?: ReactNode;
      leadingContent?: ReactNode;
    }> = [];

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

  const clearFilters = () => {
    setSearchQuery('');
    setSearchOpen(false);
    setActiveFilters([]);
  };

  const headerGapClass = columnGap ?? 'wui-elist-header--gap-default';

  const renderGroupHeader = (
    label: string,
    count: number,
    rightContent?: ReactNode,
    leadingContent?: ReactNode,
  ) => (
    <div
      className="wui-elist-group-header"
      style={{ top: 35 + stickyOffset }}
    >
      {leadingContent && <div className="wui-elist-group-header__leading">{leadingContent}</div>}
      <span className="wui-elist-group-header__label">{label}</span>
      <span className="wui-elist-group-header__count">{count}</span>
      {rightContent && <div className="wui-elist-group-header__right">{rightContent}</div>}
    </div>
  );

  const renderDefaultRowActions = (item: T) => {
    if (renderRowActions) return renderRowActions(item, rowHandlers);

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="wui-elist-row__menu-trigger">
            <EllipsisVertical className="wui-elist-icon" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              rowHandlers.onEdit(item);
            }}
          >
            <Pencil className="wui-elist-icon" />
            Edit
          </DropdownMenuItem>
          {onDuplicateItem && (
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                rowHandlers.onDuplicate(item);
              }}
            >
              <Copy className="wui-elist-icon" />
              Duplicate
            </DropdownMenuItem>
          )}
          {onDeleteItem && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="wui-dropdown-item--destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  rowHandlers.onDelete(item.id);
                }}
              >
                <Trash2 className="wui-elist-icon" />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const defaultRenderRow = (item: T) => (
    <div
      key={item.id}
      className={cn('wui-elist-row', getRowClassName?.(item))}
    >
      {columns?.map((column) => (
        <div
          key={column.id}
          className={cn('wui-elist-row__cell', column.width)}
          onClick={(e) => e.stopPropagation()}
        >
          {column.render(item, rowHandlers)}
        </div>
      ))}
      <div className="wui-elist-row__actions">{renderDefaultRowActions(item)}</div>
    </div>
  );

  if (isLoading) {
    return (
      <div className="wui-elist-loading">
        <Loader2 className="wui-elist-icon wui-elist-icon--spin" />
        <span>Loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="wui-elist-error">
        <AlertCircle className="wui-elist-icon" />
        <p className="wui-elist-error__title">Failed to load data</p>
        <p className="wui-elist-error__message">Please try again later</p>
      </div>
    );
  }

  const showSearch = searchFields && searchFields.length > 0;

  return (
    <div className="wui-elist">
      {!hideTopBar && (
        <div className={cn('wui-elist-topbar', topBarClassName)}>
          <div className="wui-elist-topbar__left">
            <FilterPills
              filters={activeFilters}
              filterConfigs={filterConfigs}
              maxFilters={maxFilters}
              onFiltersChange={setActiveFilters}
            />
            {leftActionButtons}
          </div>

          {showSearch && (
            <div className="wui-elist-search-mobile">
              <div className="wui-elist-search-wrap">
                <Search className="wui-elist-search-icon" />
                <input
                  type="text"
                  placeholder={searchPlaceholder}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="wui-elist-search-input"
                />
              </div>
            </div>
          )}

          <div className="wui-elist-topbar__right">
            {showSearch && (
              <div className="wui-elist-search-desktop">
                <div
                  className={cn(
                    'wui-elist-search-desktop__track',
                    searchOpen
                      ? 'wui-elist-search-desktop--open'
                      : 'wui-elist-search-desktop--closed',
                  )}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      'wui-elist-search-toggle',
                      searchOpen && 'wui-elist-search-toggle--hidden',
                    )}
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search className="wui-elist-icon" />
                  </Button>
                  <div
                    className={cn(
                      'wui-elist-search-wrap',
                      searchOpen
                        ? 'wui-elist-search-desktop__input--visible'
                        : 'wui-elist-search-desktop__input--hidden',
                    )}
                  >
                    <Search className="wui-elist-search-icon" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder={searchPlaceholder}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onBlur={() => !searchQuery && setSearchOpen(false)}
                      className="wui-elist-search-input"
                    />
                  </div>
                </div>
              </div>
            )}

            {actionButtons}

            {createButton && (
              <Button size="sm" className="wui-elist-create-btn" onClick={createButton.onClick}>
                <Plus className="wui-elist-icon" />
                <span className="wui-elist-create-btn__label">{createButton.label}</span>
              </Button>
            )}
          </div>
        </div>
      )}

      {(headerColumns || columns) && (
        <div
          className={cn('wui-elist-header', headerGapClass)}
          style={{ top: stickyOffset }}
        >
          {(headerColumns || columns || []).map((column) => {
            const isSortable = 'sortable' in column && column.sortable && onSort;
            const isActive = sortState?.columnId === column.id;
            return (
              <div
                key={column.id}
                className={cn(
                  'wui-elist-header__cell',
                  column.width,
                  'className' in column
                    ? column.className
                    : 'headerClassName' in column
                      ? column.headerClassName
                      : undefined,
                )}
              >
                {isSortable ? (
                  <button
                    type="button"
                    onClick={() => onSort(column.id)}
                    className={cn(
                      'wui-elist-header__sort',
                      isActive && 'wui-elist-header__sort--active',
                    )}
                  >
                    {column.header}
                    {isActive ? (
                      sortState!.direction === 'asc' ? (
                        <ArrowUp className="wui-elist-icon wui-elist-icon--sm" />
                      ) : (
                        <ArrowDown className="wui-elist-icon wui-elist-icon--sm" />
                      )
                    ) : (
                      <ArrowUpDown className="wui-elist-icon wui-elist-icon--sm wui-elist-header__sort-icon" />
                    )}
                  </button>
                ) : (
                  <span>{column.header}</span>
                )}
              </div>
            );
          })}
          <div className="wui-elist-row__actions" aria-hidden />
        </div>
      )}

      <div className="wui-elist-body">
        {groupedItems.map((group) => (
          <div key={group.id}>
            {group.label &&
              renderGroupHeader(
                group.label,
                group.items.length,
                group.rightContent,
                group.leadingContent,
              )}
            {itemsClassName ? (
              <div className={itemsClassName}>
                {group.items.map((item) =>
                  renderRow ? renderRow(item, rowHandlers) : defaultRenderRow(item),
                )}
              </div>
            ) : (
              group.items.map((item) =>
                renderRow ? renderRow(item, rowHandlers) : defaultRenderRow(item),
              )
            )}
          </div>
        ))}

        {onLoadMore && items.length > 0 && (
          <div
            ref={loadMoreSentinelRef}
            className={cn('wui-elist-sentinel', isLoadingMore && 'wui-elist-sentinel--loading')}
          >
            {isLoadingMore && <Loader2 className="wui-elist-icon wui-elist-icon--spin" />}
          </div>
        )}

        {hasNoResults && noResultsState && (
          <div className="wui-elist-no-results">
            <div className="wui-elist-no-results__graphic">
              <div className="wui-elist-no-results__rows">
                <div className="wui-elist-no-results__row wui-elist-no-results__row--short" />
                <div className="wui-elist-no-results__row wui-elist-no-results__row--long" />
              </div>
              <div className="wui-elist-no-results__badge">
                {noResultsState.icon || <XCircle className="wui-elist-icon" />}
              </div>
              <div className="wui-elist-no-results__rows">
                <div className="wui-elist-no-results__row wui-elist-no-results__row--medium" />
                <div className="wui-elist-no-results__row wui-elist-no-results__row--short" />
              </div>
            </div>
            <h3 className="wui-elist-no-results__title">{noResultsState.title}</h3>
            <p className="wui-elist-no-results__description">{noResultsState.description}</p>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filter
            </Button>
          </div>
        )}

        {items.length === 0 && emptyState && (
          <div className={cn('wui-elist-empty', emptyStateClassName)}>
            {emptyState.icon}
            <h3 className="wui-elist-empty__title">{emptyState.title}</h3>
            <p className="wui-elist-empty__description">{emptyState.description}</p>
            {(emptyState.action || emptyState.secondaryAction) && (
              <div className="wui-elist-empty__actions">
                {emptyState.action && (
                  <Button size="sm" onClick={emptyState.action.onClick}>
                    <Plus className="wui-elist-icon" />
                    <span>{emptyState.action.label}</span>
                  </Button>
                )}
                {emptyState.secondaryAction && (
                  <Button size="sm" variant="outline" onClick={emptyState.secondaryAction.onClick}>
                    <span>{emptyState.secondaryAction.label}</span>
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {dialogComponent}
    </div>
  );
}
