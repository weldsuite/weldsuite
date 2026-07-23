
import { ReactNode } from 'react';

// Column definition for the entity list
export interface ColumnDef<T> {
  id: string;
  header: string;
  width: string; // e.g., 'w-[150px]', 'flex-1'
  accessorKey?: keyof T;
  render: (item: T, handlers: RowHandlers<T>) => ReactNode;
  headerClassName?: string;
}

// Filter configuration
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

// Active filter state
export interface ActiveFilter {
  id: string;
  field: string;
  operator: string;
  value: string;
}

// Group configuration for organizing items
export interface GroupConfig<T> {
  id: string;
  label: string;
  filter: (item: T) => boolean;
  sortOrder: number;
  /** Optional content rendered on the right side of the group header. */
  rightContent?: ReactNode;
  /** Optional content rendered on the left side of the group header, before the label. */
  leadingContent?: ReactNode;
}

// Handlers passed to row renderers
export interface RowHandlers<T> {
  onEdit: (item: T) => void;
  onDelete: (id: string) => void;
  onDuplicate: (item: T) => void;
  onUpdate: (id: string, data: Partial<T>) => void;
}

// Sort state
export interface SortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

// Header column definition (simpler than full column)
export interface HeaderColumn {
  id: string;
  header: string;
  width: string;
  className?: string;
  sortable?: boolean;
}

// Props for the main EntityList component
export interface EntityListProps<T extends { id: string }> {
  // Data
  items: T[];
  isLoading: boolean;
  error?: Error | null;

  // Configuration
  columns?: ColumnDef<T>[];
  headerColumns?: HeaderColumn[];
  filters: FilterConfig[];
  groups?: GroupConfig<T>[];
  maxFilters?: number;

  // Filter logic - custom filter function that applies active filters to items
  applyFilters?: (items: T[], activeFilters: ActiveFilter[]) => T[];

  // Handlers
  onCreateItem?: (data: any) => void;
  onUpdateItem?: (id: string, data: Partial<T>) => void;
  onDeleteItem?: (id: string) => void;
  onDuplicateItem?: (item: T) => void;

  // Row configuration
  renderRow?: (item: T, handlers: RowHandlers<T>) => ReactNode;
  getRowClassName?: (item: T) => string;

  // Actions menu per row
  renderRowActions?: (item: T, handlers: RowHandlers<T>) => ReactNode;

  // Dialog
  dialogComponent?: ReactNode;

  // Empty states
  emptyState?: {
    icon?: ReactNode;
    title: string;
    description: string;
    action?: {
      label: string;
      onClick: () => void;
    };
    secondaryAction?: {
      label: string;
      onClick: () => void;
    };
  };
  noResultsState?: {
    icon?: ReactNode;
    title: string;
    description: string;
  };

  // Create button
  createButton?: {
    label: string;
    onClick: () => void;
  };

  // Additional action buttons (rendered before create button, on the right side)
  actionButtons?: ReactNode;

  // Action buttons rendered on the left side (next to filter pills)
  leftActionButtons?: ReactNode;

  // Search
  searchPlaceholder?: string;
  searchFields?: (keyof T)[];

  // Controlled-mode props (server-side filtering / search). When supplied,
  // EntityList stops doing the matching work locally and just plumbs the
  // current state up to the parent. Pages that omit these keep working with
  // the existing client-side `applyFilters` + `searchFields` behavior.
  searchQuery?: string;
  onSearchChange?: (q: string) => void;
  activeFilters?: ActiveFilter[];
  onFiltersChange?: (filters: ActiveFilter[]) => void;

  // Pagination / infinite scroll. Only kicks in if `onLoadMore` is supplied.
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;

  // Sorting
  sortState?: SortState | null;
  onSort?: (columnId: string) => void;

  // Styling
  topBarClassName?: string;
  hideTopBar?: boolean;
  emptyStateClassName?: string;
  itemsClassName?: string;
  columnGap?: string;
  stickyOffset?: number;
}

// Props for the FilterPills component
export interface FilterPillsProps {
  filters: ActiveFilter[];
  filterConfigs: FilterConfig[];
  maxFilters: number;
  onAddFilter: (field: string) => void;
  onRemoveFilter: (index: number) => void;
  onUpdateFilterOperator: (index: number, operator: string) => void;
  onUpdateFilterValue: (index: number, value: string) => void;
}
