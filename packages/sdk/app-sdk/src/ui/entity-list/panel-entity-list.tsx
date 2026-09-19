import { EllipsisVertical, Pencil, Trash2 } from 'lucide-react';
import { cn } from '../cn';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { EntityList } from './entity-list';
import type {
  ColumnDef,
  FilterConfig,
  ActiveFilter,
  GroupConfig,
  HeaderColumn,
  PanelEntityListProps,
} from './types';

const DEFAULT_LABELS = {
  edit: 'Edit',
  delete: 'Delete',
  rowMenuAriaLabel: 'Row actions',
} as const;

export function PanelEntityList<T extends { id: string }>({
  items,
  isLoading,
  error,
  columns,
  onRowClick,
  onEdit,
  onDelete,
  labels,
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
  hasMore,
  isLoadingMore,
  onLoadMore,
  emptyState,
}: PanelEntityListProps<T>) {
  const mergedLabels = { ...DEFAULT_LABELS, ...labels };
  const hasRowMenu = !!onEdit || !!onDelete;

  const headerColumns: HeaderColumn[] = [
    ...columns.map((c) => ({
      id: c.id,
      header: c.header,
      width: c.width,
      className: c.headerClassName,
    })),
    ...(hasRowMenu ? [{ id: '__actions', header: '', width: 'wui-elist-col-actions' }] : []),
  ];

  const renderRow = (item: T) => (
    <div
      key={item.id}
      onClick={onRowClick ? () => onRowClick(item) : undefined}
      role={onRowClick ? 'button' : undefined}
      tabIndex={onRowClick ? 0 : undefined}
      onKeyDown={
        onRowClick
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              if (e.target !== e.currentTarget) return;
              e.preventDefault();
              onRowClick(item);
            }
          : undefined
      }
      className={cn(
        'wui-elist-row',
        onRowClick && 'wui-elist-row--clickable',
      )}
    >
      {columns.map((column) => (
        <div key={column.id} className={cn('wui-elist-row__cell', column.width)}>
          {column.render(item, {
            onEdit: () => onEdit?.(item),
            onDelete: () => onDelete?.(item),
            onDuplicate: () => {},
            onUpdate: () => {},
          })}
        </div>
      ))}
      {hasRowMenu && (
        <div className="wui-elist-row__actions">
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="sm"
                className="wui-elist-row__menu-trigger"
                aria-label={mergedLabels.rowMenuAriaLabel}
              >
                <EllipsisVertical className="wui-elist-icon" />
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
                  <Pencil className="wui-elist-icon" />
                  {mergedLabels.edit}
                </DropdownMenuItem>
              )}
              {onDelete && (
                <>
                  {onEdit && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    className="wui-dropdown-item--destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(item);
                    }}
                  >
                    <Trash2 className="wui-elist-icon" />
                    {mergedLabels.delete}
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
      searchFields={searchFields}
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

export type { ColumnDef, FilterConfig, ActiveFilter, GroupConfig, PanelEntityListProps };
