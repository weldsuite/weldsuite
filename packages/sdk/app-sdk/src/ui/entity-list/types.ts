import type { ReactNode } from 'react';

export interface ColumnDef<T> {
  id: string;
  header: string;
  /** Consumer-defined width class (e.g. wui-elist-col-flex). */
  width: string;
  accessorKey?: keyof T;
  render: (item: T, handlers: RowHandlers<T>) => ReactNode;
  headerClassName?: string;
}

export interface FilterConfig {
  field: string;
  label: string;
  options: FilterOption[];
  filterType?: 'select' | 'text' | 'number' | 'date' | 'boolean';
  searchable?: boolean;
  getDisplayValue?: (value: string) => string;
}

export interface FilterOption {
  value: string;
  label: string;
}

export interface ActiveFilter {
  id: string;
  field: string;
  operator: string;
  value: string;
}

export interface GroupConfig<T> {
  id: string;
  label: string;
  filter: (item: T) => boolean;
  sortOrder: number;
  rightContent?: ReactNode;
  leadingContent?: ReactNode;
}

export interface RowHandlers<T> {
  onEdit: (item: T) => void;
  onDelete: (id: string) => void;
  onDuplicate: (item: T) => void;
  onUpdate: (id: string, data: Partial<T>) => void;
}

export interface SortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface HeaderColumn {
  id: string;
  header: string;
  width: string;
  className?: string;
  sortable?: boolean;
}

export interface EntityListProps<T extends { id: string }> {
  items: T[];
  isLoading: boolean;
  error?: Error | null;

  columns?: ColumnDef<T>[];
  headerColumns?: HeaderColumn[];
  filters?: FilterConfig[];
  groups?: GroupConfig<T>[];
  maxFilters?: number;

  applyFilters?: (items: T[], activeFilters: ActiveFilter[]) => T[];

  onCreateItem?: (data: Partial<T>) => void;
  onUpdateItem?: (id: string, data: Partial<T>) => void;
  onDeleteItem?: (id: string) => void;
  onDuplicateItem?: (item: T) => void;

  renderRow?: (item: T, handlers: RowHandlers<T>) => ReactNode;
  getRowClassName?: (item: T) => string;
  renderRowActions?: (item: T, handlers: RowHandlers<T>) => ReactNode;

  dialogComponent?: ReactNode;

  emptyState?: {
    icon?: ReactNode;
    title: string;
    description: string;
    action?: { label: string; onClick: () => void };
    secondaryAction?: { label: string; onClick: () => void };
  };
  noResultsState?: {
    icon?: ReactNode;
    title: string;
    description: string;
  };

  createButton?: { label: string; onClick: () => void };
  actionButtons?: ReactNode;
  leftActionButtons?: ReactNode;

  searchPlaceholder?: string;
  searchFields?: (keyof T)[];

  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  activeFilters?: ActiveFilter[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;

  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;

  sortState?: SortState | null;
  onSort?: (columnId: string) => void;

  topBarClassName?: string;
  hideTopBar?: boolean;
  emptyStateClassName?: string;
  itemsClassName?: string;
  columnGap?: string;
  stickyOffset?: number;
}

export interface FilterPillsProps {
  filters: ActiveFilter[];
  filterConfigs: FilterConfig[];
  maxFilters: number;
  onAddFilter: (field: string) => void;
  onRemoveFilter: (index: number) => void;
  onUpdateFilterOperator: (index: number, operator: string) => void;
  onUpdateFilterValue: (index: number, value: string) => void;
}

export interface PanelEntityListLabels {
  edit?: string;
  delete?: string;
  rowMenuAriaLabel?: string;
}

export interface PanelEntityListProps<T extends { id: string }> {
  items: T[];
  isLoading: boolean;
  error?: Error | null;
  columns: ColumnDef<T>[];

  onRowClick?: (item: T) => void;
  onEdit?: (item: T) => void;
  onDelete?: (item: T) => void;
  labels?: PanelEntityListLabels;

  filters?: FilterConfig[];
  groups?: GroupConfig<T>[];

  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  searchPlaceholder?: string;
  searchFields?: (keyof T)[];
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
