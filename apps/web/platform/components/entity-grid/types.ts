import { LucideIcon } from 'lucide-react';

// Field types supported by the grid
export type FieldType =
  | 'checkbox'
  | 'star'
  | 'text'
  | 'number'
  | 'email'
  | 'phone'
  | 'single-select'
  | 'multi-select'
  | 'currency'
  | 'date'
  | 'url'
  | 'location'
  | 'company'
  | 'percent'
  | 'rating';

// Status/badge styling configuration
export interface StatusStyle {
  label: string;
  color: string; // e.g., 'text-emerald-700 dark:text-emerald-400'
  bg: string; // e.g., 'bg-emerald-50 dark:bg-emerald-950'
}

// Column definition for the grid
export interface GridColumnDef<TEntity> {
  id: string;
  name: string;
  type: FieldType;
  width: number;
  icon?: LucideIcon;
  iconUrl?: string; // Image URL for provider logo (takes precedence over icon)
  visible?: boolean;
  editable?: boolean;
  sortable?: boolean;
  isCustom?: boolean;
  isEnrichField?: boolean; // Marks this as an enrichment column
  creditCost?: number; // Credit cost for enrichment columns
  options?: string[]; // For select fields
  selectConfig?: Record<string, StatusStyle>; // For styled select fields
  favoriteField?: string; // Entity field name for star toggle (used in company columns)
  // Get the value from the entity for this column
  getValue: (entity: TEntity) => any;
  // Set the value - returns the partial update to apply
  setValue?: (entity: TEntity, value: any) => Record<string, any>;
  // Custom render function (optional)
  render?: (entity: TEntity, value: any) => React.ReactNode;
  // Callback to enrich all visible entities for this column
  onEnrichAll?: (entities: TEntity[]) => void;
  // Extra actions appended to this column's header menu (e.g. edit/delete an
  // enrichment column). Rendered below the built-in move/hide items.
  headerMenuItems?: Array<{
    label: string;
    icon?: LucideIcon;
    onSelect: () => void;
    destructive?: boolean;
  }>;
}

// Configuration for the entire grid
export interface EntityGridConfig<TEntity> {
  entityName: string; // e.g., 'Customer'
  gridViewName?: string; // Override for grid view persistence key (defaults to entityName.toLowerCase())
  entityNamePlural: string; // e.g., 'Customers'
  columns: GridColumnDef<TEntity>[];
  getEntityId: (entity: TEntity) => string;
  getEntityName: (entity: TEntity) => string;
  getEntityInitials?: (entity: TEntity) => string;
  getEntityAvatar?: (entity: TEntity) => string | undefined;
  getEntitySubtitle?: (entity: TEntity) => string | undefined;
  statusField?: string; // Field ID for status display
  statusConfig?: Record<string, StatusStyle>;
  allowCustomColumns?: boolean;
  onCreateAttribute?: () => void;
  availableEnrichFields?: Array<{
    provider: string;
    operation: string;
    name: string;
    logoUrl: string;
    creditCost: number;
  }>;
  onEnableEnrichField?: (provider: string, operation: string) => void;
  initialVisibility?: Record<string, boolean> | null;
  initialColumnWidths?: Record<string, number> | null;
  enableCalculations?: boolean;
  enableInlineEditing?: boolean;
  enableRowSelection?: boolean;
  enableExport?: boolean;
  enableImport?: boolean;
  // Spreadsheet mode: show row numbers & fill viewport with empty rows
  showRowNumbers?: boolean;
  fillViewport?: boolean;
  // Optional: contributes a right-click context menu to the first cell of each
  // row. Receives the row's entity and returns the inner items rendered
  // inside a <ContextMenuContent>.
  renderRowContextMenu?: (entity: TEntity) => React.ReactNode;
}

// Actions that the grid can perform
export interface EntityGridActions<TEntity> {
  onUpdateEntity: (id: string, updates: Record<string, any>) => Promise<{ success: boolean; error?: string }>;
  onDeleteEntity: (id: string) => Promise<{ success: boolean; error?: string }>;
  onBulkDelete?: (ids: string[]) => Promise<void>;
  onBulkStatusUpdate?: (ids: string[], status: string) => Promise<void>;
  onExportCSV?: () => Promise<void>;
  onExportExcel?: () => Promise<void>;
  onImport?: () => void;
  onRowClick?: (entity: TEntity) => void;
  onAddToList?: (ids: string[], listId: string) => Promise<void>;
  onSendEmail?: (ids: string[]) => void;
  onBulkEdit?: (ids: string[], clearSelection: () => void) => void;
  onCreateEntity?: () => void;
  // Extra, module-specific bulk actions shown in the selection bar (e.g. a
  // "Move to CRM" convert action). Each receives the selected ids and a
  // clear-selection callback.
  bulkActions?: Array<{
    id: string;
    label: string;
    icon?: LucideIcon;
    onAction: (ids: string[], clearSelection: () => void) => void | Promise<void>;
  }>;
}

// Pagination information
export interface GridPaginationState {
  page: number;
  pageSize: number;
  totalCount?: number;
  total?: number;
  totalPages: number;
  hasMore?: boolean;
}

// Sort configuration
export interface GridSortConfig {
  field: string | null;
  direction: 'asc' | 'desc' | null;
}

// Filter configuration
export interface GridFilter {
  id: string;
  field: string;
  operator: 'contains' | 'equals' | 'starts_with' | 'is_empty' | 'is_not_empty' | 'gt' | 'lt' | 'gte' | 'lte';
  value: any;
}

// Calculation types
export type CalculationType =
  | 'count'
  | 'count_empty'
  | 'count_not_empty'
  | 'count_unique'
  | 'count_duplicates'
  | 'percent_empty'
  | 'percent_not_empty'
  | 'percent_unique'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  | 'checked'
  | 'unchecked'
  | 'percent_checked'
  | 'percent_unchecked'
  | 'earliest'
  | 'latest'
  | 'date_range';

// Calculation option
export interface CalculationOption {
  value: CalculationType;
  label: string;
  icon: LucideIcon;
}

// Cell editing state
export interface EditingCell {
  rowId: string;
  fieldId: string;
}

// Open popover state
export interface OpenPopover {
  rowId: string;
  fieldId: string;
}

// Grid state
export interface GridState<TEntity> {
  // Column state
  columns: GridColumnDef<TEntity>[];
  columnWidths: Record<string, number>;

  // Selection state
  selectedRows: Set<string>;

  // Editing state
  editingCell: EditingCell | null;
  editValue: any;
  openPopover: OpenPopover | null;

  // Sort and filter state
  sortConfig: GridSortConfig;
  filters: GridFilter[];

  // Calculation state
  fieldCalculations: Record<string, CalculationType>;

  // Custom field data (for custom columns)
  customFieldData: Record<string, Record<string, any>>;

  // Optimistic updates
  optimisticUpdates: Record<string, Partial<TEntity>>;

  // Loading states
  isExporting: boolean;
  isDeleting: boolean;
}

// Grid context value
export interface GridContextValue<TEntity> {
  // Configuration
  config: EntityGridConfig<TEntity>;
  actions: EntityGridActions<TEntity>;

  // State
  state: GridState<TEntity>;

  // Data
  entities: TEntity[];
  filteredEntities: TEntity[];
  pagination?: GridPaginationState;

  // State setters
  setColumns: (columns: GridColumnDef<TEntity>[]) => void;
  setColumnWidths: (widths: Record<string, number>) => void;
  setSelectedRows: (selected: Set<string>) => void;
  setEditingCell: (cell: EditingCell | null) => void;
  setEditValue: (value: any) => void;
  setOpenPopover: (popover: OpenPopover | null) => void;
  setSortConfig: (config: GridSortConfig) => void;
  setFilters: (filters: GridFilter[]) => void;
  setFieldCalculations: (calculations: Record<string, CalculationType>) => void;
  setCustomFieldData: (data: Record<string, Record<string, any>>) => void;
  setOptimisticUpdates: (updates: Record<string, Partial<TEntity>>) => void;
  setIsExporting: (exporting: boolean) => void;
  setIsDeleting: (deleting: boolean) => void;

  // Helper functions
  getVisibleColumns: () => GridColumnDef<TEntity>[];
  getEntityWithOptimisticUpdates: (entity: TEntity) => TEntity;
  updateEntityField: (entityId: string, fieldId: string, value: any) => Promise<void>;
  updateCustomFieldValue: (entityId: string, fieldId: string, value: any) => void;
  getCustomFieldValue: (entityId: string, fieldId: string) => any;
  addColumn: (type: FieldType, name: string, icon: LucideIcon) => void;
  showColumn: (fieldId: string) => void;
  deleteColumn: (fieldId: string) => void;
  handleSort: (fieldId: string, direction: 'asc' | 'desc') => void;
  handleHideColumn: (fieldId: string) => void;
  handleMoveColumn: (fieldId: string, direction: 'left' | 'right') => void;
  handleColumnResize: (fieldId: string, width: number) => void;
  calculateTableWidth: () => number;
  getCalculationResult: (fieldId: string, fieldType: FieldType, calculationType: CalculationType) => string;
}

// Props for EntityGrid component
export interface EntityGridProps<TEntity> {
  config: EntityGridConfig<TEntity>;
  actions: EntityGridActions<TEntity>;
  entities: TEntity[];
  pagination?: GridPaginationState;
  searchParams?: Record<string, string | undefined>;
  listId?: string;
  listName?: string;
  availableLists?: Array<{ id: string; title: string; color: string }>;
  // Infinite scroll props
  onLoadMore?: () => void;
  hasMore?: boolean;
  isFetchingMore?: boolean;
  // Hide the built-in toolbar (when using a custom external toolbar)
  hideToolbar?: boolean;
  // Hide the toolbar's search-icon button (e.g. when search is owned by an
  // external bar, like WeldData's server-side keyword search).
  hideToolbarSearch?: boolean;
  // Hide the toolbar's Filter button + active filter pills.
  hideToolbarFilter?: boolean;
  // Extra controls rendered in the toolbar, next to the Import/Export button.
  toolbarActions?: React.ReactNode;
}

// Props for editor components
export interface EditorProps<TValue = any> {
  value: TValue;
  /** Controlled-mode change handler. Uncontrolled editors may ignore this. */
  onChange?: (value: TValue) => void;
  /** Called on commit. Uncontrolled editors pass the final value here. */
  onCommit: (finalValue?: TValue) => void;
  onCancel: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
}

// Props for select editor
export interface SelectEditorProps extends EditorProps<string | null> {
  options: string[];
  optionConfig?: Record<string, StatusStyle>;
}

// Props for multi-select editor
export interface MultiSelectEditorProps extends EditorProps<string[]> {
  options: string[];
  optionConfig?: Record<string, StatusStyle>;
}

// Props for location editor. Location is now a free-form string populated via
// Mapbox suggestions (matches the calendar's LocationAutocomplete). The legacy
// `{ city, state, country }` shape is still accepted on read for backward compat
// and is flattened to a string at display time.
type LocationValue =
  | string
  | { city?: string; state?: string; country?: string }
  | null
  | undefined;
export interface LocationEditorProps extends EditorProps<LocationValue> {}

// Props for date editor
export interface DateEditorProps extends EditorProps<Date | null | undefined> {

}

// Field type options for adding new columns
interface FieldTypeOption {
  value: FieldType;
  label: string;
  icon: LucideIcon;
}

// New row data structure
interface NewRow {
  id: string;
  data: Record<string, any>;
}
