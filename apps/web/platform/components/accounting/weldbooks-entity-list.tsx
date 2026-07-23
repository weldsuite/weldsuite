/**
 * WeldBooks list wrapper around the shared `EntityList`.
 *
 * EntityList's built-in "columns" row renderer always appends a hard-coded
 * (non-i18n, no-op) Edit dropdown, which doesn't fit WeldBooks' navigate-to-
 * detail lists. This wrapper renders EntityList with a custom row that:
 *   - is clickable to open the record (when `onRowClick` is given),
 *   - shows a trailing chevron affordance instead of the dead action menu,
 *   - lets individual cells opt out of row navigation via stopPropagation.
 *
 * Pages pass the same `ColumnDef[]` they'd pass to EntityList, so the visual
 * language (top bar, header row, spacing, empty state) stays identical to
 * every other platform module.
 */

import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  EntityList,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
  type GroupConfig,
} from '@/components/entity-list';

interface WeldbooksEntityListProps<T extends { id: string }> {
  items: T[];
  isLoading: boolean;
  columns: ColumnDef<T>[];
  onRowClick?: (item: T) => void;

  filters?: FilterConfig[];
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

  createButton?: { label: string; onClick: () => void };
  actionButtons?: ReactNode;

  emptyState: {
    icon?: ReactNode;
    title: string;
    description: string;
    action?: { label: string; onClick: () => void };
  };
}

export function WeldbooksEntityList<T extends { id: string }>({
  items,
  isLoading,
  columns,
  onRowClick,
  filters = [],
  groups,
  searchPlaceholder,
  searchFields,
  searchQuery,
  onSearchChange,
  activeFilters,
  onFiltersChange,
  createButton,
  actionButtons,
  emptyState,
}: WeldbooksEntityListProps<T>) {
  return (
    <EntityList<T>
      items={items}
      isLoading={isLoading}
      columns={columns}
      groups={groups}
      filters={filters}
      searchFields={searchFields}
      searchQuery={searchQuery}
      onSearchChange={onSearchChange}
      activeFilters={activeFilters}
      onFiltersChange={onFiltersChange}
      searchPlaceholder={searchPlaceholder}
      createButton={createButton}
      actionButtons={actionButtons}
      emptyState={emptyState}
      renderRow={(item) => (
        <div
          key={item.id}
          onClick={onRowClick ? () => onRowClick(item) : undefined}
          className={cn(
            'group flex items-center gap-4 px-4 py-3 border-b border-border/70',
            onRowClick && 'cursor-pointer hover:bg-muted/40',
          )}
        >
          {columns.map((column) => (
            <div key={column.id} className={column.width}>
              {column.render(item, {
                onEdit: () => {},
                onDelete: () => {},
                onDuplicate: () => {},
                onUpdate: () => {},
              })}
            </div>
          ))}
          <div className="w-[40px] flex justify-end">
            {onRowClick ? (
              <ChevronRight className="h-4 w-4 text-muted-foreground/50 opacity-0 group-hover:opacity-100" />
            ) : null}
          </div>
        </div>
      )}
    />
  );
}
