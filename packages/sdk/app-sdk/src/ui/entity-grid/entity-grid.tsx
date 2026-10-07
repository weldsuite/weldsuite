/**
 * Required CSS (shipped in @weldsuite/app-sdk/ui/styles.css):
 * .wui-egrid, .wui-egrid-toolbar*, .wui-egrid-table*, .wui-egrid-row*,
 * .wui-egrid-cell*, .wui-egrid-selection*, .wui-egrid-editor*, .wui-egrid-badge*
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '../cn';
import { Button } from '../button';
import { Input } from '../input';
import { CheckboxEditor, NumberEditor, SelectEditor, TextEditor } from './editors';
import type {
  EditingCell,
  EntityGridActions,
  EntityGridConfig,
  EntityGridLabels,
  EntityGridProps,
  GridColumnDef,
  GridSortConfig,
} from './types';
import {
  exportEntitiesCsv,
  filterEntities,
  formatDisplayValue,
  sortEntities,
} from './utils';

const DEFAULT_LABELS = {
  newEntity: 'New',
  search: 'Search…',
  export: 'Export CSV',
  selected: 'selected',
  delete: 'Delete',
  clearSelection: 'Clear',
  noResults: 'No results',
  loading: 'Loading…',
} as const;

export function EntityGrid<TEntity>({
  config,
  actions,
  entities,
  isLoading,
  searchValue: controlledSearch,
  onSearchChange,
  searchPlaceholder,
  serverSearch = false,
  labels,
  hideToolbar,
  toolbarActions,
  onLoadMore,
  hasMore,
  isFetchingMore,
}: Readonly<EntityGridProps<TEntity>>) {
  const mergedLabels = { ...DEFAULT_LABELS, ...labels };
  const [internalSearch, setInternalSearch] = useState('');
  const searchValue = controlledSearch ?? internalSearch;
  const setSearchValue = onSearchChange ?? setInternalSearch;

  const [sort, setSort] = useState<GridSortConfig>({ field: null, direction: null });
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [optimistic, setOptimistic] = useState<Record<string, Record<string, unknown>>>({});

  const columns = useMemo(
    () => config.columns.filter((c) => c.visible !== false),
    [config.columns],
  );

  const displayEntities = useMemo(() => {
    let rows = entities;
    if (!serverSearch && searchValue.trim()) {
      rows = filterEntities(rows, columns, searchValue);
    }
    rows = sortEntities(rows, columns, sort);
    return rows;
  }, [entities, columns, searchValue, serverSearch, sort]);

  const getEntityWithOptimistic = useCallback(
    (entity: TEntity): TEntity => {
      const id = config.getEntityId(entity);
      const patch = optimistic[id];
      if (!patch) return entity;
      return { ...entity, ...patch } as TEntity;
    },
    [config, optimistic],
  );

  const handleSort = (fieldId: string) => {
    setSort((prev) => {
      if (prev.field !== fieldId) return { field: fieldId, direction: 'asc' };
      if (prev.direction === 'asc') return { field: fieldId, direction: 'desc' };
      return { field: null, direction: null };
    });
  };

  const toggleRow = (id: string) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedRows.size === displayEntities.length) {
      setSelectedRows(new Set());
      return;
    }
    setSelectedRows(new Set(displayEntities.map((e) => config.getEntityId(e))));
  };

  const commitEdit = async (entity: TEntity, column: GridColumnDef<TEntity>, value: unknown) => {
    const id = config.getEntityId(entity);
    setEditingCell(null);
    if (!column.setValue) return;
    const updates = column.setValue(entity, value);
    setOptimistic((prev) => ({ ...prev, [id]: { ...prev[id], ...updates } }));
    const result = await actions.onUpdateEntity(id, updates);
    if (!result.success) {
      setOptimistic((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handleExport = async () => {
    if (actions.onExportCSV) {
      await actions.onExportCSV();
      return;
    }
    exportEntitiesCsv(
      displayEntities.map(getEntityWithOptimistic),
      columns,
      `${config.entityNamePlural.toLowerCase().replace(/\s+/g, '-')}.csv`,
    );
  };

  const handleBulkDelete = async () => {
    if (!actions.onBulkDelete || selectedRows.size === 0) return;
    const ids = Array.from(selectedRows);
    await actions.onBulkDelete(ids);
    setSelectedRows(new Set());
  };

  const sentinelRef = useLoadMoreSentinel(onLoadMore, hasMore, isFetchingMore);

  const tableWidth = computeTableWidth(config, columns);

  return (
    <div className="wui-egrid" data-testid="entity-grid">
      {!hideToolbar && (
        <GridToolbar
          config={config}
          actions={actions}
          labels={labels}
          mergedLabels={mergedLabels}
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          searchPlaceholder={searchPlaceholder}
          toolbarActions={toolbarActions}
          onExport={() => void handleExport()}
        />
      )}

      {selectedRows.size > 0 && config.enableRowSelection ? (
        <GridSelectionBar
          count={selectedRows.size}
          mergedLabels={mergedLabels}
          canBulkDelete={!!actions.onBulkDelete}
          onBulkDelete={() => void handleBulkDelete()}
          onClear={() => setSelectedRows(new Set())}
        />
      ) : null}

      <div className="wui-egrid-scroll">
        {isLoading ? (
          <div className="wui-egrid-loading">
            <Loader2 className="wui-egrid-icon wui-egrid-icon--spin" />
            {mergedLabels.loading}
          </div>
        ) : (
          <table className="wui-egrid-table" style={{ minWidth: tableWidth }}>
            <GridTableHead
              config={config}
              columns={columns}
              sort={sort}
              onSort={handleSort}
              allSelected={displayEntities.length > 0 && selectedRows.size === displayEntities.length}
              onToggleAll={toggleAll}
            />
            <tbody>
              {displayEntities.length === 0 ? (
                <GridEmptyRow
                  colSpan={computeColumnSpan(config, columns)}
                  label={mergedLabels.noResults}
                />
              ) : (
                displayEntities.map((raw, index) => {
                  const entity = getEntityWithOptimistic(raw);
                  const id = config.getEntityId(entity);
                  return (
                    <GridRow
                      key={id}
                      entity={entity}
                      id={id}
                      index={index}
                      selected={selectedRows.has(id)}
                      columns={columns}
                      config={config}
                      editingCell={editingCell}
                      onRowClick={actions.onRowClick}
                      onToggle={toggleRow}
                      onStartEdit={setEditingCell}
                      onStopEdit={() => setEditingCell(null)}
                      onCommit={(col, next) => void commitEdit(entity, col, next)}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        )}
        {onLoadMore && hasMore ? (
          <div ref={sentinelRef} className="wui-egrid-sentinel">
            {isFetchingMore ? <Loader2 className="wui-egrid-icon wui-egrid-icon--spin" /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function computeTableWidth<TEntity>(
  config: EntityGridConfig<TEntity>,
  columns: GridColumnDef<TEntity>[],
): number {
  return (
    columns.reduce((sum, c) => sum + c.width, 0) +
    (config.enableRowSelection ? 40 : 0) +
    (config.showRowNumbers ? 48 : 0)
  );
}

function computeColumnSpan<TEntity>(
  config: EntityGridConfig<TEntity>,
  columns: GridColumnDef<TEntity>[],
): number {
  return columns.length + (config.enableRowSelection ? 1 : 0) + (config.showRowNumbers ? 1 : 0);
}

function GridEmptyRow({ colSpan, label }: Readonly<{ colSpan: number; label: string }>) {
  return (
    <tr>
      <td className="wui-egrid-empty" colSpan={colSpan}>
        {label}
      </td>
    </tr>
  );
}

type ResolvedLabels = Record<keyof typeof DEFAULT_LABELS, string>;

function useLoadMoreSentinel(
  onLoadMore: (() => void) | undefined,
  hasMore: boolean | undefined,
  isFetchingMore: boolean | undefined,
) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingMore) onLoadMore();
      },
      { rootMargin: '120px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, isFetchingMore]);
  return sentinelRef;
}

function GridToolbar<TEntity>({
  config,
  actions,
  labels,
  mergedLabels,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  toolbarActions,
  onExport,
}: Readonly<{
  config: EntityGridConfig<TEntity>;
  actions: EntityGridActions<TEntity>;
  labels: EntityGridLabels | undefined;
  mergedLabels: ResolvedLabels;
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string | undefined;
  toolbarActions: ReactNode;
  onExport: () => void;
}>) {
  return (
    <div className="wui-egrid-toolbar">
      <div className="wui-egrid-toolbar__left">
        {actions.onCreateEntity ? (
          <Button size="sm" onClick={actions.onCreateEntity}>
            <Plus className="wui-egrid-icon" />
            {labels?.newEntity ?? `New ${config.entityName.toLowerCase()}`}
          </Button>
        ) : null}
        {toolbarActions}
      </div>
      <div className="wui-egrid-toolbar__right">
        <div className="wui-egrid-search">
          <Search className="wui-egrid-search__icon" />
          <Input
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder ?? mergedLabels.search}
            className="wui-egrid-search__input"
            aria-label={mergedLabels.search}
          />
        </div>
        {config.enableExport !== false ? (
          <Button variant="outline" size="sm" onClick={onExport}>
            <Download className="wui-egrid-icon" />
            {mergedLabels.export}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function GridSelectionBar({
  count,
  mergedLabels,
  canBulkDelete,
  onBulkDelete,
  onClear,
}: Readonly<{
  count: number;
  mergedLabels: ResolvedLabels;
  canBulkDelete: boolean;
  onBulkDelete: () => void;
  onClear: () => void;
}>) {
  return (
    <div className="wui-egrid-selection">
      <span>
        {count} {mergedLabels.selected}
      </span>
      <div className="wui-egrid-selection__actions">
        {canBulkDelete ? (
          <Button variant="destructive" size="sm" onClick={onBulkDelete}>
            <Trash2 className="wui-egrid-icon" />
            {mergedLabels.delete}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X className="wui-egrid-icon" />
          {mergedLabels.clearSelection}
        </Button>
      </div>
    </div>
  );
}

function GridTableHead<TEntity>({
  config,
  columns,
  sort,
  onSort,
  allSelected,
  onToggleAll,
}: Readonly<{
  config: EntityGridConfig<TEntity>;
  columns: GridColumnDef<TEntity>[];
  sort: GridSortConfig;
  onSort: (fieldId: string) => void;
  allSelected: boolean;
  onToggleAll: () => void;
}>) {
  return (
    <thead>
      <tr>
        {config.enableRowSelection ? (
          <th className="wui-egrid-th wui-egrid-th--check">
            <input
              type="checkbox"
              className="wui-egrid-checkbox"
              checked={allSelected}
              onChange={onToggleAll}
              aria-label="Select all"
            />
          </th>
        ) : null}
        {config.showRowNumbers ? <th className="wui-egrid-th wui-egrid-th--num">#</th> : null}
        {columns.map((col) => (
          <GridHeaderCell key={col.id} column={col} sort={sort} onSort={onSort} />
        ))}
      </tr>
    </thead>
  );
}

function sortIconFor(active: boolean, direction: GridSortConfig['direction']) {
  if (!active || !direction) return ArrowUpDown;
  return direction === 'asc' ? ArrowUp : ArrowDown;
}

function GridHeaderCell<TEntity>({
  column,
  sort,
  onSort,
}: Readonly<{
  column: GridColumnDef<TEntity>;
  sort: GridSortConfig;
  onSort: (fieldId: string) => void;
}>) {
  const active = sort.field === column.id;
  const SortIcon = sortIconFor(active, sort.direction);
  return (
    <th className="wui-egrid-th" style={{ width: column.width, minWidth: column.width }}>
      {column.sortable !== false ? (
        <button
          type="button"
          className={cn('wui-egrid-th__sort', active && 'wui-egrid-th__sort--active')}
          onClick={() => onSort(column.id)}
        >
          {column.icon ? <column.icon className="wui-egrid-icon" /> : null}
          <span>{column.name}</span>
          <SortIcon className="wui-egrid-icon wui-egrid-icon--sm" />
        </button>
      ) : (
        <span className="wui-egrid-th__label">
          {column.icon ? <column.icon className="wui-egrid-icon" /> : null}
          {column.name}
        </span>
      )}
    </th>
  );
}

/** Whether a cell may be edited inline (grid-level flag + column-level flags). */
function isCellEditable<TEntity>(
  config: EntityGridConfig<TEntity>,
  column: GridColumnDef<TEntity>,
): boolean {
  return config.enableInlineEditing !== false && column.editable !== false && !!column.setValue;
}

function GridRow<TEntity>({
  entity,
  id,
  index,
  selected,
  columns,
  config,
  editingCell,
  onRowClick,
  onToggle,
  onStartEdit,
  onStopEdit,
  onCommit,
}: Readonly<{
  entity: TEntity;
  id: string;
  index: number;
  selected: boolean;
  columns: GridColumnDef<TEntity>[];
  config: EntityGridConfig<TEntity>;
  editingCell: EditingCell | null;
  onRowClick?: (entity: TEntity) => void;
  onToggle: (id: string) => void;
  onStartEdit: (cell: EditingCell) => void;
  onStopEdit: () => void;
  onCommit: (column: GridColumnDef<TEntity>, value: unknown) => void;
}>) {
  return (
    <tr
      className={cn('wui-egrid-row', selected && 'wui-egrid-row--selected')}
      onClick={() => onRowClick?.(entity)}
    >
      {config.enableRowSelection ? (
        <td className="wui-egrid-td wui-egrid-td--check" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            className="wui-egrid-checkbox"
            checked={selected}
            onChange={() => onToggle(id)}
            aria-label={`Select ${config.getEntityName(entity)}`}
          />
        </td>
      ) : null}
      {config.showRowNumbers ? (
        <td className="wui-egrid-td wui-egrid-td--num">{index + 1}</td>
      ) : null}
      {columns.map((col) => {
        const editable = isCellEditable(config, col);
        const isEditing =
          editable && editingCell?.rowId === id && editingCell?.fieldId === col.id;
        return (
          <td
            key={col.id}
            className="wui-egrid-td"
            style={{ width: col.width, minWidth: col.width }}
            onDoubleClick={(e) => {
              if (!editable) return;
              e.stopPropagation();
              onStartEdit({ rowId: id, fieldId: col.id });
            }}
          >
            <GridCellContent
              entity={entity}
              column={col}
              editable={editable}
              isEditing={isEditing}
              onCommit={(next) => onCommit(col, next)}
              onCancel={onStopEdit}
            />
          </td>
        );
      })}
    </tr>
  );
}

function GridCellContent<TEntity>({
  entity,
  column,
  editable,
  isEditing,
  onCommit,
  onCancel,
}: Readonly<{
  entity: TEntity;
  column: GridColumnDef<TEntity>;
  editable: boolean;
  isEditing: boolean;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}>) {
  const value = column.getValue(entity);
  if (isEditing) {
    return (
      <div onClick={(e) => e.stopPropagation()}>
        <CellEditor column={column} value={value} onCommit={onCommit} onCancel={onCancel} />
      </div>
    );
  }
  if (column.type === 'checkbox' && editable) {
    return <CheckboxEditor value={!!value} onCommit={onCommit} />;
  }
  if (column.render) {
    return <>{column.render(entity, value)}</>;
  }
  return <DefaultCell column={column} value={value} />;
}

function DefaultCell<TEntity>({
  column,
  value,
}: Readonly<{
  column: GridColumnDef<TEntity>;
  value: unknown;
}>) {
  if (column.type === 'single-select' && typeof value === 'string' && column.selectConfig?.[value]) {
    const style = column.selectConfig[value];
    return (
      <span
        className="wui-egrid-badge"
        style={{
          color: style.color,
          background: style.bg,
        }}
      >
        {style.label}
      </span>
    );
  }
  const text = formatDisplayValue(column.type, value);
  return <span className="wui-egrid-cell-text">{text || '—'}</span>;
}

function toEditorNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  return value == null ? null : Number(value);
}

const TEXT_INPUT_TYPES: Partial<Record<string, 'email' | 'url' | 'tel'>> = {
  email: 'email',
  url: 'url',
  phone: 'tel',
};

function textInputTypeFor(columnType: string): 'email' | 'url' | 'tel' | 'text' {
  return TEXT_INPUT_TYPES[columnType] ?? 'text';
}

function CellEditor<TEntity>({
  column,
  value,
  onCommit,
  onCancel,
}: Readonly<{
  column: GridColumnDef<TEntity>;
  value: unknown;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}>) {
  if (column.type === 'number' || column.type === 'currency' || column.type === 'percent') {
    return (
      <NumberEditor
        value={toEditorNumber(value)}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (column.type === 'single-select' && column.options) {
    return (
      <SelectEditor
        value={typeof value === 'string' ? value : null}
        options={column.options}
        optionConfig={column.selectConfig}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }
  if (column.type === 'checkbox') {
    return <CheckboxEditor value={!!value} onCommit={onCommit} />;
  }
  return (
    <TextEditor
      value={value == null ? '' : String(value)}
      type={textInputTypeFor(column.type)}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
}

export type { EntityGridProps, EntityGridConfig, EntityGridActions, GridColumnDef } from './types';
