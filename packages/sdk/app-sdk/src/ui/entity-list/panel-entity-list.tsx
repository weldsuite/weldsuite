import { useId } from 'react';
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
import type { HeaderColumn, PanelEntityListProps } from './types';

export type {
  ColumnDef,
  FilterConfig,
  ActiveFilter,
  GroupConfig,
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
}: Readonly<PanelEntityListProps<T>>) {
  const rowIdPrefix = useId();
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
      className={cn(
        'wui-elist-row',
        onRowClick && 'wui-elist-row--clickable',
      )}
    >
      {onRowClick && (
        <button
          type="button"
          className="wui-elist-row__hit"
          aria-labelledby={`${rowIdPrefix}-${item.id}`}
          onClick={() => onRowClick(item)}
        />
      )}
      {columns.map((column, columnIndex) => (
        <div
          key={column.id}
          id={columnIndex === 0 ? `${rowIdPrefix}-${item.id}` : undefined}
          className={cn('wui-elist-row__cell', column.width)}
        >
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

