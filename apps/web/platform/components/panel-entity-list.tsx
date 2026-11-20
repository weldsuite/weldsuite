/**
 * List wrapper around the shared `EntityList` for modules whose rows open an
 * object panel, such as WeldStash.
 *
 * Same reason WeldBooks has `weldbooks-entity-list.tsx`: EntityList's built-in
 * column renderer wraps every cell in `stopPropagation` (so rows can't be
 * clicked) and appends a hard-coded, non-i18n Edit/Duplicate/Delete dropdown.
 * This wrapper supplies its own `renderRow` that:
 *   - makes the whole row clickable, for opening the object panel,
 *   - renders a translated Edit / Delete dropdown, both optional,
 *   - keeps the shared top bar, header row, spacing and empty state, so these
 *     modules look like every other EntityList page in the platform.
 *
 * Pages pass the same `ColumnDef[]` they'd pass to EntityList directly.
 */

import type { ReactNode } from 'react';
import { EllipsisVertical, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { cn } from '@/lib/utils';
import { RowOverlayButton, ROW_CELL_PASSTHROUGH } from '@/components/shared/row-overlay-button';
import { getTranslations } from '@/lib/i18n';
import {
  useObjectPanelNavigationReporter,
  type ObjectPanelListNavigation,
} from '@/components/object-panel';
import {
  EntityList,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
  type GroupConfig,
  type HeaderColumn,
} from '@/components/entity-list';

export interface PanelEntityListProps<T extends { id: string }> {
  items: T[];
  isLoading: boolean;
  error?: Error | null;
  columns: ColumnDef<T>[];

  /** Row click — typically opens the object panel for this record. */
  onRowClick?: (item: T) => void;
  /**
   * What `onRowClick` opens, so that panel's previous / next arrows step
   * through these rows in the order shown.
   */
  objectPanel?: ObjectPanelListNavigation<T>;
  /** Adds an "Edit" entry to the row menu. */
  onEdit?: (item: T) => void;
  /** Adds a "Delete" entry to the row menu. */
  onDelete?: (item: T) => void;
  /**
   * The row menu's own `DropdownMenuItem`s, for records with actions beyond
   * Edit and Delete (pause, test, revoke…); replaces the Edit / Delete entries.
   * Return null for a row without a menu.
   */
  rowMenu?: (item: T) => ReactNode;

  filters?: FilterConfig[];
  groups?: GroupConfig<T>[];

  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  searchPlaceholder?: string;
  /**
   * Shows the desktop search box. Without `searchQuery` the list also matches
   * these fields itself; with it, the page does the matching.
   */
  searchFields?: (keyof T)[];
  activeFilters?: ActiveFilter[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;

  createButton?: { label: string; onClick: () => void };
  actionButtons?: ReactNode;
  /** Rendered on the left of the top bar, next to the filter pills. */
  leftActionButtons?: ReactNode;
  /**
   * Drop the built-in top bar (search, filters, buttons), for a page that
   * renders its own toolbar elsewhere. The page then filters `items` itself.
   */
  hideTopBar?: boolean;
  /** Drop the Filter button, for a list with nothing to filter on (its popover would be empty). */
  hideFilter?: boolean;
  /** Classes for the top bar (Filter, search, create button). */
  topBarClassName?: string;
  /** Puts the column header and rows in a box with these classes (see `EntityList`). */
  listClassName?: string;

  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;

  emptyState: {
    icon?: ReactNode;
    title: string;
    description: string;
    action?: { label: string; onClick: () => void };
  };
  /** Shown instead of the empty state when a search or filter matches nothing. */
  noResultsState?: { icon?: ReactNode; title: string; description: string };
}

export function PanelEntityList<T extends { id: string }>({
  items,
  isLoading,
  error,
  columns,
  onRowClick,
  objectPanel,
  onEdit,
  onDelete,
  rowMenu,
  filters = [],
  groups,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  searchFields,
  activeFilters,
  onFiltersChange,
  createButton,
  actionButtons,
  leftActionButtons,
  hideTopBar,
  hideFilter,
  topBarClassName,
  listClassName,
  hasMore,
  isLoadingMore,
  onLoadMore,
  emptyState,
  noResultsState,
}: Readonly<PanelEntityListProps<T>>) {
  const t = getTranslations('common');
  const hasRowMenu = !!onEdit || !!onDelete;
  const reportDisplayedItems = useObjectPanelNavigationReporter<T>({
    ...objectPanel,
    type: objectPanel?.type ?? '',
    hasMore,
    loadMore: onLoadMore,
    enabled: objectPanel !== undefined,
  });

  // Header widths mirror the column widths so the sticky header lines up with
  // the custom rows below. EntityList always appends its own 40px gutter to the
  // header, so every row ends with the same gutter, menu or not.
  const headerColumns: HeaderColumn[] = columns.map((c) => ({
    id: c.id,
    header: c.header,
    width: c.width,
    className: c.headerClassName,
  }));

  const renderRow = (item: T) => {
    const customMenu = rowMenu?.(item) ?? null;
    return (
      <div
        key={item.id}
        className={cn(
          'group relative flex items-center gap-4 px-4 py-3 border-b border-border/70 text-sm transition-colors',
          onRowClick && 'cursor-pointer hover:bg-muted/40',
        )}
      >
        {/* A click-only row is unreachable without a mouse, so the click target
            is a native button stretched over the row (only when it is clickable). */}
        {onRowClick ? (
          <RowOverlayButton label={t.actions.view} onClick={() => onRowClick(item)} />
        ) : null}
        {/* `min-w-0` first, so a column that sets its own minimum (the flexible
            name column) keeps it instead of being squeezed to nothing. */}
        {columns.map((column) => (
          <div key={column.id} className={cn('min-w-0', column.width, onRowClick && ROW_CELL_PASSTHROUGH)}>
            {column.render(item, {
              onEdit: () => onEdit?.(item),
              onDelete: () => onDelete?.(item),
              onDuplicate: () => {},
              onUpdate: () => {},
            })}
          </div>
        ))}
        {/* h-7 = the menu button's height, so rows without a menu are as tall as rows with one. */}
        <div className="relative z-[1] w-[40px] h-7 flex items-center justify-end">
          {(rowMenu ? customMenu !== null : hasRowMenu) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button
                  variant="ghost"
                  size="sm"
                  // Shown on hover, and whenever it has keyboard focus or its menu is open; always on touch screens.
                  className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={t.actions.title}
                >
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                {rowMenu ? customMenu : null}
                {!rowMenu && onEdit && (
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(item);
                    }}
                  >
                    <Pencil className="mr-0.5 h-4 w-4" />
                    {t.actions.edit}
                  </DropdownMenuItem>
                )}
                {!rowMenu && onDelete && (
                  <>
                    {onEdit && <DropdownMenuSeparator />}
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(item);
                      }}
                      className="text-red-600 hover:!bg-red-50 hover:!text-red-600 dark:text-red-400 dark:hover:!bg-red-950 dark:hover:!text-red-400"
                    >
                      <Trash2 className="mr-0.5 h-4 w-4 text-red-500" />
                      {t.actions.delete}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    );
  };

  return (
    // Container for the `@…/list` column breakpoints: a column can hide by the
    // width the list really has, not the viewport's (which stays wide while an
    // object panel is open). Same as `WeldbooksEntityList`.
    <div className="@container/list w-full min-w-0">
    <EntityList<T>
      items={items}
      isLoading={isLoading}
      error={error}
      columns={columns}
      headerColumns={headerColumns}
      renderRow={renderRow}
      filters={filters}
      groups={groups}
      searchQuery={searchQuery}
      onSearchChange={onSearchChange}
      searchPlaceholder={searchPlaceholder}
      // EntityList only shows its desktop search box when `searchFields` is set,
      // and ignores the fields when the search is controlled. A server-searched
      // list passes a placeholder so its search box shows on desktop too.
      searchFields={searchFields ?? (onSearchChange ? (['id'] as (keyof T)[]) : undefined)}
      activeFilters={activeFilters}
      onFiltersChange={onFiltersChange}
      createButton={createButton}
      actionButtons={actionButtons}
      leftActionButtons={leftActionButtons}
      hideTopBar={hideTopBar}
      hideFilter={hideFilter}
      topBarClassName={topBarClassName}
      listClassName={listClassName}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      onLoadMore={onLoadMore}
      onDisplayedItemsChange={objectPanel ? reportDisplayedItems : undefined}
      emptyState={emptyState}
      noResultsState={noResultsState}
    />
    </div>
  );
}

export type { ColumnDef, FilterConfig, ActiveFilter, GroupConfig };
