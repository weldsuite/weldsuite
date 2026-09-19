/**
 * Required CSS (shipped in @weldsuite/app-sdk/ui/styles.css):
 * .wui-egrid, .wui-egrid-toolbar*, .wui-egrid-table*, .wui-egrid-row*,
 * .wui-egrid-cell*, .wui-egrid-selection*, .wui-egrid-editor*, .wui-egrid-badge*
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
}: EntityGridProps<TEntity>) {
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
    setOptimistic((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...updates } }));
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

  const tableWidth =
    columns.reduce((sum, c) => sum + c.width, 0) +
    (config.enableRowSelection ? 40 : 0) +
    (config.showRowNumbers ? 48 : 0);

  return (
    <div className="wui-egrid" data-testid="entity-grid">
      {!hideToolbar && (
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
                onChange={(e) => setSearchValue(e.target.value)}
                placeholder={searchPlaceholder ?? mergedLabels.search}
                className="wui-egrid-search__input"
                aria-label={mergedLabels.search}
              />
            </div>
            {config.enableExport !== false ? (
              <Button variant="outline" size="sm" onClick={() => void handleExport()}>
                <Download className="wui-egrid-icon" />
                {mergedLabels.export}
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {selectedRows.size > 0 && config.enableRowSelection ? (
        <div className="wui-egrid-selection">
          <span>
            {selectedRows.size} {mergedLabels.selected}
          </span>
          <div className="wui-egrid-selection__actions">
            {actions.onBulkDelete ? (
              <Button variant="destructive" size="sm" onClick={() => void handleBulkDelete()}>
                <Trash2 className="wui-egrid-icon" />
                {mergedLabels.delete}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => setSelectedRows(new Set())}>
              <X className="wui-egrid-icon" />
              {mergedLabels.clearSelection}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="wui-egrid-scroll">
        {isLoading ? (
          <div className="wui-egrid-loading">
            <Loader2 className="wui-egrid-icon wui-egrid-icon--spin" />
            {mergedLabels.loading}
          </div>
        ) : (
          <table className="wui-egrid-table" style={{ minWidth: tableWidth }}>
            <thead>
              <tr>
                {config.enableRowSelection ? (
                  <th className="wui-egrid-th wui-egrid-th--check">
                    <input
                      type="checkbox"
                      className="wui-egrid-checkbox"
                      checked={
                        displayEntities.length > 0 && selectedRows.size === displayEntities.length
                      }
                      onChange={toggleAll}
                      aria-label="Select all"
                    />
                  </th>
                ) : null}
                {config.showRowNumbers ? (
                  <th className="wui-egrid-th wui-egrid-th--num">#</th>
                ) : null}
                {columns.map((col) => {
                  const active = sort.field === col.id;
                  const SortIcon =
                    !active || !sort.direction
                      ? ArrowUpDown
                      : sort.direction === 'asc'
                        ? ArrowUp
                        : ArrowDown;
                  return (
                    <th
                      key={col.id}
                      className="wui-egrid-th"
                      style={{ width: col.width, minWidth: col.width }}
                    >
                      {col.sortable !== false ? (
                        <button
                          type="button"
                          className={cn('wui-egrid-th__sort', active && 'wui-egrid-th__sort--active')}
                          onClick={() => handleSort(col.id)}
                        >
                          {col.icon ? <col.icon className="wui-egrid-icon" /> : null}
                          <span>{col.name}</span>
                          <SortIcon className="wui-egrid-icon wui-egrid-icon--sm" />
                        </button>
                      ) : (
                        <span className="wui-egrid-th__label">
                          {col.icon ? <col.icon className="wui-egrid-icon" /> : null}
                          {col.name}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {displayEntities.length === 0 ? (
                <tr>
                  <td
                    className="wui-egrid-empty"
                    colSpan={
                      columns.length +
                      (config.enableRowSelection ? 1 : 0) +
                      (config.showRowNumbers ? 1 : 0)
                    }
                  >
                    {mergedLabels.noResults}
                  </td>
                </tr>
              ) : (
                displayEntities.map((raw, index) => {
                  const entity = getEntityWithOptimistic(raw);
                  const id = config.getEntityId(entity);
                  const selected = selectedRows.has(id);
                  return (
                    <tr
                      key={id}
                      className={cn('wui-egrid-row', selected && 'wui-egrid-row--selected')}
                      onClick={() => actions.onRowClick?.(entity)}
                    >
                      {config.enableRowSelection ? (
                        <td
                          className="wui-egrid-td wui-egrid-td--check"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            className="wui-egrid-checkbox"
                            checked={selected}
                            onChange={() => toggleRow(id)}
                            aria-label={`Select ${config.getEntityName(entity)}`}
                          />
                        </td>
                      ) : null}
                      {config.showRowNumbers ? (
                        <td className="wui-egrid-td wui-egrid-td--num">{index + 1}</td>
                      ) : null}
                      {columns.map((col) => {
                        const value = col.getValue(entity);
                        const isEditing =
                          config.enableInlineEditing !== false &&
                          editingCell?.rowId === id &&
                          editingCell?.fieldId === col.id &&
                          col.editable !== false &&
                          !!col.setValue;

                        return (
                          <td
                            key={col.id}
                            className="wui-egrid-td"
                            style={{ width: col.width, minWidth: col.width }}
                            onDoubleClick={(e) => {
                              if (
                                config.enableInlineEditing === false ||
                                col.editable === false ||
                                !col.setValue
                              ) {
                                return;
                              }
                              e.stopPropagation();
                              setEditingCell({ rowId: id, fieldId: col.id });
                            }}
                          >
                            {isEditing ? (
                              <div onClick={(e) => e.stopPropagation()}>
                                <CellEditor
                                  column={col}
                                  value={value}
                                  onCommit={(next) => void commitEdit(entity, col, next)}
                                  onCancel={() => setEditingCell(null)}
                                />
                              </div>
                            ) : col.type === 'checkbox' &&
                              col.editable !== false &&
                              col.setValue &&
                              config.enableInlineEditing !== false ? (
                              <CheckboxEditor
                                value={!!value}
                                onCommit={(next) => void commitEdit(entity, col, next)}
                              />
                            ) : col.render ? (
                              col.render(entity, value)
                            ) : (
                              <DefaultCell column={col} value={value} />
                            )}
                          </td>
                        );
                      })}
                    </tr>
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

function DefaultCell<TEntity>({
  column,
  value,
}: {
  column: GridColumnDef<TEntity>;
  value: unknown;
}) {
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

function CellEditor<TEntity>({
  column,
  value,
  onCommit,
  onCancel,
}: {
  column: GridColumnDef<TEntity>;
  value: unknown;
  onCommit: (value: unknown) => void;
  onCancel: () => void;
}) {
  if (column.type === 'number' || column.type === 'currency' || column.type === 'percent') {
    return (
      <NumberEditor
        value={typeof value === 'number' ? value : value == null ? null : Number(value)}
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
  const inputType =
    column.type === 'email' ? 'email' : column.type === 'url' ? 'url' : column.type === 'phone' ? 'tel' : 'text';
  return (
    <TextEditor
      value={value == null ? '' : String(value)}
      type={inputType}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
}

export type { EntityGridProps, EntityGridConfig, EntityGridActions, GridColumnDef } from './types';
