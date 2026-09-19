import type { ComponentType, ReactNode } from 'react';

export type FieldType =
  | 'checkbox'
  | 'text'
  | 'number'
  | 'email'
  | 'phone'
  | 'single-select'
  | 'multi-select'
  | 'currency'
  | 'date'
  | 'url'
  | 'percent'
  | 'rating';

export interface StatusStyle {
  label: string;
  /** Inline CSS color for text. */
  color?: string;
  /** Inline CSS background. */
  bg?: string;
}

export interface GridColumnDef<TEntity> {
  id: string;
  name: string;
  type: FieldType;
  width: number;
  icon?: ComponentType<{ className?: string }>;
  visible?: boolean;
  editable?: boolean;
  sortable?: boolean;
  options?: string[];
  selectConfig?: Record<string, StatusStyle>;
  getValue: (entity: TEntity) => unknown;
  setValue?: (entity: TEntity, value: unknown) => Record<string, unknown>;
  render?: (entity: TEntity, value: unknown) => ReactNode;
}

export interface EntityGridConfig<TEntity> {
  entityName: string;
  entityNamePlural: string;
  columns: GridColumnDef<TEntity>[];
  getEntityId: (entity: TEntity) => string;
  getEntityName: (entity: TEntity) => string;
  enableInlineEditing?: boolean;
  enableRowSelection?: boolean;
  enableExport?: boolean;
  showRowNumbers?: boolean;
}

export interface EntityGridActions<TEntity> {
  onUpdateEntity: (
    id: string,
    updates: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string }>;
  onDeleteEntity?: (id: string) => Promise<{ success: boolean; error?: string }>;
  onBulkDelete?: (ids: string[]) => Promise<void>;
  onRowClick?: (entity: TEntity) => void;
  onCreateEntity?: () => void;
  /** When omitted and enableExport is true, built-in CSV export is used. */
  onExportCSV?: () => Promise<void>;
}

export interface EntityGridLabels {
  newEntity?: string;
  search?: string;
  export?: string;
  selected?: string;
  delete?: string;
  clearSelection?: string;
  noResults?: string;
  loading?: string;
}

export interface EntityGridProps<TEntity> {
  config: EntityGridConfig<TEntity>;
  actions: EntityGridActions<TEntity>;
  entities: TEntity[];
  isLoading?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /**
   * When true, `searchValue` is display-only and entities are not filtered
   * client-side (server/owner already filtered the list).
   */
  serverSearch?: boolean;
  labels?: EntityGridLabels;
  hideToolbar?: boolean;
  toolbarActions?: ReactNode;
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
}

export interface GridSortConfig {
  field: string | null;
  direction: 'asc' | 'desc' | null;
}

export interface EditingCell {
  rowId: string;
  fieldId: string;
}
