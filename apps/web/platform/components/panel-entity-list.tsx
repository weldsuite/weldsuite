/**
 * List wrapper around the shared `EntityList` for modules whose rows open an
 * object panel — WeldCommerce and WeldStash.
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
import { getTranslations } from '@/lib/i18n';
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
  /** Adds an "Edit" entry to the row menu. */
  onEdit?: (item: T) => void;
  /** Adds a "Delete" entry to the row menu. */
  onDelete?: (item: T) => void;

  filters?: FilterConfig[];
  groups?: GroupConfig<T>[];

  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  searchPlaceholder?: string;
  activeFilters?: ActiveFilter[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;

  createButton?: { label: string; onClick: () => void };
  actionButtons?: ReactNode;

  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;

  emptyState: {
    icon?: ReactNode;
    title: string;
    description: string;
    action?: { label: string; onClick: () => void };
  };
}

export function PanelEntityList<T extends { id: string }>({
  items,
  isLoading,
  error,
  columns,
  onRowClick,
  onEdit,
  onDelete,
  filters = [],
  groups,
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  activeFilters,
  onFiltersChange,
  createButton,
  actionButtons,
  hasMore,
  isLoadingMore,
  onLoadMore,
  emptyState,
}: PanelEntityListProps<T>) {
  const t = getTranslations('common');
  const hasRowMenu = !!onEdit || !!onDelete;

  // Header widths mirror the column widths so the sticky header lines up with
  // the custom rows below, including the trailing menu gutter.
  const headerColumns: HeaderColumn[] = [
    ...columns.map((c) => ({ id: c.id, header: c.header, width: c.width, className: c.headerClassName })),
    ...(hasRowMenu ? [{ id: '__actions', header: '', width: 'w-[40px]' }] : []),
  ];

  const renderRow = (item: T) => (
    <div
      key={item.id}
      onClick={onRowClick ? () => onRowClick(item) : undefined}
      // A click-only row is unreachable without a mouse. Give it a button role,
      // put it in the tab order, and accept the keys a button accepts. Only when
      // the row is actually clickable — otherwise these would announce an
      // interactive element that does nothing.
      role={onRowClick ? 'button' : undefined}
      tabIndex={onRowClick ? 0 : undefined}
      onKeyDown={
        onRowClick
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              // Ignore keys forwarded from a control inside the row (the row
              // menu trigger), which handles them itself.
              if (e.target !== e.currentTarget) return;
              e.preventDefault(); // Space would otherwise scroll the list.
              onRowClick(item);
            }
          : undefined
      }
      className={cn(
        'group flex items-center gap-4 px-4 py-3 border-b border-border/70 transition-colors',
        onRowClick &&
          'cursor-pointer hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
      )}
    >
      {columns.map((column) => (
        <div key={column.id} className={cn(column.width, 'min-w-0')}>
          {column.render(item, {
            onEdit: () => onEdit?.(item),
            onDelete: () => onDelete?.(item),
            onDuplicate: () => {},
            onUpdate: () => {},
          })}
        </div>
      ))}
      {hasRowMenu && (
        <div className="w-[40px] flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100"
                aria-label={t.actions.view}
              >
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {onEdit && (
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
              {onDelete && (
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
        </div>
      )}
    </div>
  );

  return (
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
      activeFilters={activeFilters}
      onFiltersChange={onFiltersChange}
      createButton={createButton}
      actionButtons={actionButtons}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      onLoadMore={onLoadMore}
      emptyState={emptyState}
    />
  );
}

export type { ColumnDef, FilterConfig, ActiveFilter, GroupConfig };
