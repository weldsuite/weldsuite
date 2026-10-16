/**
 * WeldBooks list wrapper around the shared `EntityList`.
 *
 * EntityList's built-in "columns" row renderer always appends a hard-coded
 * (non-i18n, no-op) Edit dropdown, which doesn't fit WeldBooks' navigate-to-
 * detail lists. This wrapper renders EntityList with a custom row that:
 *   - has the WeldFlow task row's spacing, divider, hover and fixed 53px height,
 *   - is clickable to open the record (when `onRowClick` is given) via a
 *     stretched native button behind the cells,
 *   - shows a trailing row menu (`renderRowMenu`) or, failing that, a chevron
 *     affordance instead of the dead action menu,
 *   - lets interactive cell content (buttons, links, inputs) keep working on its own.
 *
 * Pages pass the same `ColumnDef[]` they'd pass to EntityList and render their
 * cells with `./weldbooks-row-cells`, so every WeldBooks list looks like the
 * task list. Each cell is a vertically centred flex box that truncates.
 */

import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { RowOverlayButton, ROW_CELL_PASSTHROUGH } from '@/components/shared/row-overlay-button';
import {
  EntityList,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
  type GroupConfig,
  type SortState,
} from '@/components/entity-list';

interface WeldbooksEntityListProps<T extends { id: string }> {
  items: T[];
  isLoading: boolean;
  error?: Error | null;
  columns: ColumnDef<T>[];
  onRowClick?: (item: T) => void;
  /** Accessible name of a row's click target; defaults to "View". */
  getRowLabel?: (item: T) => string;
  /** Extra classes per row (e.g. dimmed when void). */
  getRowClassName?: (item: T) => string;
  /** Trailing per-row menu (three-dot dropdown). Replaces the chevron. */
  renderRowMenu?: (item: T) => ReactNode;

  filters?: FilterConfig[];
  /** Client-side filtering for `filters` (omit when filtering server-side). */
  applyFilters?: (items: T[], activeFilters: ActiveFilter[]) => T[];
  /** Row grouping (e.g. accounts by type, bills by status). Group headers render above each bucket. */
  groups?: GroupConfig<T>[];
  searchPlaceholder?: string;

  // Client-side search (omit when using controlled search).
  searchFields?: (keyof T)[];

  // Controlled (server-side) search + filters.
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  activeFilters?: ActiveFilter[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;

  // Pagination (load more at the end of the list).
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;

  sortState?: SortState | null;
  onSort?: (columnId: string) => void;

  createButton?: { label: string; onClick: () => void };
  actionButtons?: ReactNode;
  leftActionButtons?: ReactNode;

  emptyState: {
    icon?: ReactNode;
    title: string;
    description: string;
    action?: { label: string; onClick: () => void };
    secondaryAction?: { label: string; onClick: () => void };
  };
  noResultsState?: { icon?: ReactNode; title: string; description: string };
}

export function WeldbooksEntityList<T extends { id: string }>({
  items,
  isLoading,
  error,
  columns,
  onRowClick,
  getRowLabel,
  getRowClassName,
  renderRowMenu,
  filters = [],
  applyFilters,
  groups,
  searchPlaceholder,
  searchFields,
  searchQuery,
  onSearchChange,
  activeFilters,
  onFiltersChange,
  hasMore,
  isLoadingMore,
  onLoadMore,
  sortState,
  onSort,
  createButton,
  actionButtons,
  leftActionButtons,
  emptyState,
  noResultsState,
}: Readonly<WeldbooksEntityListProps<T>>) {
  const t = useTranslations();
  return (
    <EntityList<T>
      items={items}
      isLoading={isLoading}
      error={error}
      columns={columns}
      groups={groups}
      filters={filters}
      applyFilters={applyFilters}
      // EntityList only shows its desktop search box when `searchFields` is set, and
      // ignores the fields when search is controlled. Server-searched lists pass a
      // placeholder so their search box shows too.
      searchFields={searchFields ?? (onSearchChange ? (['id'] as (keyof T)[]) : undefined)}
      searchQuery={searchQuery}
      onSearchChange={onSearchChange}
      activeFilters={activeFilters}
      onFiltersChange={onFiltersChange}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      onLoadMore={onLoadMore}
      sortState={sortState}
      onSort={onSort}
      searchPlaceholder={searchPlaceholder}
      createButton={createButton}
      actionButtons={actionButtons}
      leftActionButtons={leftActionButtons}
      emptyState={emptyState}
      noResultsState={noResultsState}
      renderRow={(item) => (
        <div
          key={item.id}
          className={cn(
            'group relative flex items-center gap-4 px-4 py-3 border-b border-gray-200/70 dark:border-border',
            onRowClick && 'cursor-pointer hover:bg-gray-50 dark:hover:bg-secondary/50',
            getRowClassName?.(item),
          )}
        >
          {onRowClick ? (
            <RowOverlayButton
              label={getRowLabel?.(item) ?? t('common.actions.view')}
              onClick={() => onRowClick(item)}
            />
          ) : null}
          {columns.map((column) => (
            <div
              key={column.id}
              className={cn('flex min-w-0 items-center', column.width, onRowClick && ROW_CELL_PASSTHROUGH)}
            >
              {column.render(item, {
                onEdit: () => {},
                onDelete: () => {},
                onDuplicate: () => {},
                onUpdate: () => {},
              })}
            </div>
          ))}
          {/* h-7 matches the task row's menu button, so rows share its fixed 53px height. */}
          <div className={cn('w-[40px] h-7 flex items-center justify-end', renderRowMenu && 'relative z-[1]')}>
            {renderRowMenu ? (
              renderRowMenu(item)
            ) : onRowClick ? (
              <ChevronRight className="h-4 w-4 text-muted-foreground/50 opacity-0 group-hover:opacity-100" />
            ) : null}
          </div>
        </div>
      )}
    />
  );
}
