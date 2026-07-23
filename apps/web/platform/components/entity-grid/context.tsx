
import React, { createContext, useContext, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  GridContextValue,
  GridState,
  EntityGridConfig,
  EntityGridActions,
  GridColumnDef,
  GridSortConfig,
  GridFilter,
  GridPaginationState,
  EditingCell,
  OpenPopover,
  FieldType,
  CalculationType,
} from './types';
import { LucideIcon } from 'lucide-react';
import { getDefaultWidthForFieldType, getDefaultValueForFieldType, getCalculationOptions } from './utils/calculations';
import { setEditingCellValue, getEditingCellValue } from './editing-store';
import { useAppApiClient } from '@/lib/api/use-app-api';

// Create the context with a generic type
const GridContext = createContext<GridContextValue<any> | null>(null);

// Provider props
interface GridProviderProps<TEntity> {
  config: EntityGridConfig<TEntity>;
  actions: EntityGridActions<TEntity>;
  entities: TEntity[];
  pagination?: GridPaginationState;
  children: React.ReactNode;
}

export function GridProvider<TEntity>({
  config,
  actions,
  entities,
  pagination,
  children,
}: GridProviderProps<TEntity>) {
  const t = useTranslations();
  const { getClient } = useAppApiClient();
  const gridName = config.gridViewName || config.entityName.toLowerCase();

  // Apply initialVisibility from server to columns
  const applyInitialVisibility = useCallback(
    (cols: GridColumnDef<TEntity>[]): GridColumnDef<TEntity>[] => {
      const saved = config.initialVisibility;
      if (!saved || Object.keys(saved).length === 0) return cols;
      return cols.map((col) => (col.id in saved ? { ...col, visible: saved[col.id] } : col));
    },
    [config.initialVisibility]
  );

  // Initialize column widths from config, overridden by saved widths
  const initialColumnWidths = useMemo(() => {
    const widths: Record<string, number> = {};
    config.columns.forEach((col) => {
      widths[col.id] = col.width;
    });
    // Apply saved widths from server
    if (config.initialColumnWidths) {
      Object.entries(config.initialColumnWidths).forEach(([id, width]) => {
        widths[id] = width;
      });
    }
    return widths;
  }, [config.columns, config.initialColumnWidths]);

  // State — apply saved visibility from server on first render
  const [columns, setColumns] = useState<GridColumnDef<TEntity>[]>(() => applyInitialVisibility(config.columns));
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(initialColumnWidths);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  // editingCell lives in an external store (editing-store.ts) so that only the
  // specific cell subscribing via useIsCellEditing() re-renders on change.
  const setEditingCell = useCallback(
    (cell: EditingCell | null) => setEditingCellValue(cell),
    [],
  );
  const [editValue, setEditValue] = useState<any>('');
  const [openPopover, setOpenPopover] = useState<OpenPopover | null>(null);
  const [sortConfig, setSortConfig] = useState<GridSortConfig>({ field: null, direction: null });
  const [filters, setFilters] = useState<GridFilter[]>([]);
  const [fieldCalculations, setFieldCalculations] = useState<Record<string, CalculationType>>({});
  const [customFieldData, setCustomFieldData] = useState<Record<string, Record<string, any>>>({});
  const [optimisticUpdates, setOptimisticUpdates] = useState<Record<string, Partial<TEntity>>>({});
  const [isExporting, setIsExporting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Persist visibility + widths to database (debounced) whenever columns or widths change
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const visibility: Record<string, boolean> = {};
      columns.forEach((col) => {
        visibility[col.id] = col.visible !== false;
      });
      // app-api PUT /api/grid-views/:gridName (was api-worker
      // PUT /settings/grid-views/:gridName). Same body, response ignored.
      getClient().then((client) =>
        client.put(`/grid-views/${gridName}`, {
          columnVisibility: visibility,
          columnWidths,
        })
      ).catch(() => {
        // silent — best-effort persistence
      });
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [columns, columnWidths, gridName]);

  // Sync columns when config.columns changes (e.g. new custom field defs fetched)
  // Preserves user visibility overrides for existing columns, adds new ones
  const configColumnsRef = useRef(config.columns);
  useEffect(() => {
    if (configColumnsRef.current === config.columns) return;
    configColumnsRef.current = config.columns;

    setColumns((prev) => {
      const prevById = new Map(prev.map((c) => [c.id, c]));
      const merged = config.columns.map((configCol) => {
        const existing = prevById.get(configCol.id);
        if (existing) {
          // Keep user's visibility override, update the rest from config
          return { ...configCol, visible: existing.visible };
        }
        // For new columns not yet in state, apply saved visibility if available
        if (config.initialVisibility && configCol.id in config.initialVisibility) {
          return { ...configCol, visible: config.initialVisibility[configCol.id] };
        }
        return configCol;
      });
      // Keep any purely local columns (e.g. addColumn-created) that aren't in config
      const configIds = new Set(config.columns.map((c) => c.id));
      const localOnly = prev.filter((c) => !configIds.has(c.id));
      return [...merged, ...localOnly];
    });

    // Also sync widths for new columns (prefer saved widths over defaults)
    // For enrichment columns, always apply the registry default width
    setColumnWidths((prev) => {
      const next = { ...prev };
      config.columns.forEach((col) => {
        if (!(col.id in next) || col.isEnrichField) {
          next[col.id] = config.initialColumnWidths?.[col.id] ?? col.width;
        }
      });
      return next;
    });
  }, [config.columns]);

  // Get visible columns
  const getVisibleColumns = useCallback(() => {
    return columns.filter((col) => col.visible !== false);
  }, [columns]);

  // Filter entities based on active filters
  const filteredEntities = useMemo(() => {
    if (filters.length === 0) return entities;

    return entities.filter((entity) => {
      return filters.every((filter) => {
        if (!filter.field || !filter.operator) return true;

        const column = columns.find((c) => c.id === filter.field);
        if (!column) return true;

        const value = column.getValue(entity);
        const filterValue = filter.value?.toLowerCase() || '';
        const entityValue = String(value || '').toLowerCase();

        switch (filter.operator) {
          case 'contains':
            return entityValue.includes(filterValue);
          case 'equals':
            return entityValue === filterValue;
          case 'starts_with':
            return entityValue.startsWith(filterValue);
          case 'is_empty':
            return !value || entityValue.trim() === '';
          case 'is_not_empty':
            return value && entityValue.trim() !== '';
          case 'gt':
            return parseFloat(entityValue) > parseFloat(filterValue);
          case 'lt':
            return parseFloat(entityValue) < parseFloat(filterValue);
          case 'gte':
            return parseFloat(entityValue) >= parseFloat(filterValue);
          case 'lte':
            return parseFloat(entityValue) <= parseFloat(filterValue);
          default:
            return true;
        }
      });
    });
  }, [entities, filters, columns]);

  // Get entity with optimistic updates applied
  const getEntityWithOptimisticUpdates = useCallback(
    (entity: TEntity): TEntity => {
      const id = config.getEntityId(entity);
      const updates = optimisticUpdates[id];
      if (!updates) return entity;
      return { ...entity, ...updates };
    },
    [config, optimisticUpdates]
  );

  // Update entity field
  const updateEntityField = useCallback(
    async (entityId: string, fieldId: string, value: any) => {
      const column = columns.find((c) => c.id === fieldId);
      if (!column || !column.setValue) {
        console.warn(`Cannot update field ${fieldId}: no setValue defined`);
        return;
      }

      const entity = entities.find((e) => config.getEntityId(e) === entityId);
      if (!entity) return;

      const updateData = column.setValue(entity, value);

      // Apply optimistic update
      setOptimisticUpdates((prev) => ({
        ...prev,
        [entityId]: { ...prev[entityId], ...updateData } as Partial<TEntity>,
      }));

      const result = await actions.onUpdateEntity(entityId, updateData);
      if (!result.success) {
        // Revert optimistic update on failure
        setOptimisticUpdates((prev) => {
          const { [entityId]: _, ...rest } = prev;
          return rest;
        });
        toast.error(result.error || t('sweep.entities.updateFailed'));
      }
    },
    [columns, entities, config, actions, t]
  );

  // Update custom field value
  const updateCustomFieldValue = useCallback(
    (entityId: string, fieldId: string, value: any) => {
      setCustomFieldData((prev) => ({
        ...prev,
        [entityId]: {
          ...prev[entityId],
          [fieldId]: value,
        },
      }));
    },
    []
  );

  // Get custom field value
  const getCustomFieldValue = useCallback(
    (entityId: string, fieldId: string): any => {
      return customFieldData[entityId]?.[fieldId];
    },
    [customFieldData]
  );

  // Add new column
  const addColumn = useCallback(
    (type: FieldType, name: string, icon: LucideIcon) => {
      const newFieldId = `custom_${Date.now()}`;
      const newColumn: GridColumnDef<TEntity> = {
        id: newFieldId,
        name,
        type,
        width: getDefaultWidthForFieldType(type),
        icon,
        visible: true,
        editable: true,
        isCustom: true,
        options:
          type === 'single-select' || type === 'multi-select'
            ? [
                t('sweep.entities.optionN', { n: 1 }),
                t('sweep.entities.optionN', { n: 2 }),
                t('sweep.entities.optionN', { n: 3 }),
              ]
            : undefined,
        getValue: (entity: TEntity) => customFieldData[config.getEntityId(entity)]?.[newFieldId],
        setValue: (entity: TEntity, value: any) => ({ [newFieldId]: value }),
      };

      setColumns((prev) => [...prev, newColumn]);
      setColumnWidths((prev) => ({ ...prev, [newFieldId]: newColumn.width }));

      // Initialize default values for all entities
      const newCustomData: Record<string, Record<string, any>> = { ...customFieldData };
      entities.forEach((entity) => {
        const id = config.getEntityId(entity);
        if (!newCustomData[id]) {
          newCustomData[id] = {};
        }
        newCustomData[id][newFieldId] = getDefaultValueForFieldType(type);
      });
      setCustomFieldData(newCustomData);

      toast.success(t('sweep.entities.addedColumn', { name }));
    },
    [config, entities, customFieldData, t]
  );

  // Show a hidden column
  const showColumn = useCallback(
    (fieldId: string) => {
      setColumns((prev) => prev.map((c) => (c.id === fieldId ? { ...c, visible: true } : c)));
      const column = columns.find((c) => c.id === fieldId);
      if (column) {
        toast.success(t('sweep.entities.addedColumn', { name: column.name }));
      }
    },
    [columns, t]
  );

  // Delete column (enrichment columns are hidden instead of removed so they can be re-added)
  const deleteColumn = useCallback(
    (fieldId: string) => {
      const column = columns.find((c) => c.id === fieldId);
      if (!column?.isCustom) {
        toast.error(t('sweep.entities.cannotDeleteBuiltInColumns'));
        return;
      }
      if (column.isEnrichField) {
        setColumns((prev) => prev.map((c) => c.id === fieldId ? { ...c, visible: false } : c));
        toast.success(t('sweep.entities.columnHidden'));
      } else {
        setColumns((prev) => prev.filter((c) => c.id !== fieldId));
        toast.success(t('sweep.entities.columnDeleted'));
      }
    },
    [columns, t]
  );

  // Handle sort
  const handleSort = useCallback((fieldId: string, direction: 'asc' | 'desc') => {
    setSortConfig({ field: fieldId, direction });
  }, []);

  // Handle hide column
  const handleHideColumn = useCallback((fieldId: string) => {
    setColumns((prev) => prev.map((c) => (c.id === fieldId ? { ...c, visible: false } : c)));
  }, []);

  // Handle move column
  const handleMoveColumn = useCallback((fieldId: string, direction: 'left' | 'right') => {
    setColumns((prev) => {
      const currentIndex = prev.findIndex((c) => c.id === fieldId);
      if (currentIndex === -1) return prev;

      const newIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1;
      if (newIndex < 0 || newIndex >= prev.length) return prev;

      const newColumns = [...prev];
      [newColumns[currentIndex], newColumns[newIndex]] = [
        newColumns[newIndex],
        newColumns[currentIndex],
      ];
      return newColumns;
    });
  }, []);

  // Handle column resize
  const handleColumnResize = useCallback((fieldId: string, width: number) => {
    setColumnWidths((prev) => ({ ...prev, [fieldId]: width }));
  }, []);

  // Calculate total table width (sum of data columns only)
  const calculateTableWidth = useCallback(() => {
    const visibleCols = getVisibleColumns();
    return visibleCols.reduce((total, col) => total + (columnWidths[col.id] || col.width), 0);
  }, [getVisibleColumns, columnWidths]);

  // Get calculation result for a field
  const getCalculationResult = useCallback(
    (fieldId: string, fieldType: FieldType, calculationType: CalculationType): string => {
      const column = columns.find((c) => c.id === fieldId);
      if (!column) return '';

      const allValues = entities.map((entity) => {
        if (column.isCustom) {
          return customFieldData[config.getEntityId(entity)]?.[fieldId];
        }
        return column.getValue(entity);
      });

      const values = allValues.filter((v) => v !== null && v !== undefined && v !== '');

      const formatNum = (v: number) => fieldType === 'currency' ? `$${v.toLocaleString()}` : v.toLocaleString();
      const getNumericValues = () => values.filter((v) => typeof v === 'number') as number[];
      const parseDates = () => values.filter((v) => v).map((v) => new Date(v as string)).filter((d) => !isNaN(d.getTime()));

      switch (calculationType) {
        case 'count':
          return `${allValues.length}`;
        case 'count_empty':
          return `${allValues.length - values.length}`;
        case 'count_not_empty':
          return `${values.length}`;
        case 'count_unique': {
          const unique = new Set(values.map((v) => String(v)));
          return `${unique.size}`;
        }
        case 'count_duplicates': {
          const counts: Record<string, number> = {};
          values.forEach((v) => { const key = String(v); counts[key] = (counts[key] || 0) + 1; });
          const dupes = Object.values(counts).reduce((acc, c) => acc + (c > 1 ? c : 0), 0);
          return `${dupes}`;
        }
        case 'percent_empty':
          return allValues.length > 0 ? `${Math.round(((allValues.length - values.length) / allValues.length) * 100)}%` : '0%';
        case 'percent_not_empty':
          return allValues.length > 0 ? `${Math.round((values.length / allValues.length) * 100)}%` : '0%';
        case 'percent_unique': {
          const uniqueSet = new Set(values.map((v) => String(v)));
          return values.length > 0 ? `${Math.round((uniqueSet.size / values.length) * 100)}%` : '0%';
        }
        case 'sum': {
          const sum = getNumericValues().reduce((acc, v) => acc + v, 0);
          return formatNum(sum);
        }
        case 'average': {
          const nums = getNumericValues();
          const avg = nums.length > 0 ? nums.reduce((acc, v) => acc + v, 0) / nums.length : 0;
          return fieldType === 'currency' ? `$${avg.toFixed(2)}` : avg.toFixed(2);
        }
        case 'median': {
          const nums = getNumericValues().sort((a, b) => a - b);
          if (nums.length === 0) return '0';
          const mid = Math.floor(nums.length / 2);
          const med = nums.length % 2 !== 0 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
          return formatNum(med);
        }
        case 'min': {
          const nums = getNumericValues();
          return nums.length > 0 ? formatNum(Math.min(...nums)) : '0';
        }
        case 'max': {
          const nums = getNumericValues();
          return nums.length > 0 ? formatNum(Math.max(...nums)) : '0';
        }
        case 'range': {
          const nums = getNumericValues();
          if (nums.length === 0) return '0';
          return formatNum(Math.max(...nums) - Math.min(...nums));
        }
        case 'checked':
          return `${values.filter((v) => v === true).length}`;
        case 'unchecked':
          return `${allValues.filter((v) => v === false || v === null || v === undefined).length}`;
        case 'percent_checked': {
          const checked = values.filter((v) => v === true).length;
          return allValues.length > 0 ? `${Math.round((checked / allValues.length) * 100)}%` : '0%';
        }
        case 'percent_unchecked': {
          const unchecked = allValues.filter((v) => v === false || v === null || v === undefined).length;
          return allValues.length > 0 ? `${Math.round((unchecked / allValues.length) * 100)}%` : '0%';
        }
        case 'earliest': {
          const dates = parseDates();
          if (dates.length === 0) return '-';
          return new Date(Math.min(...dates.map((d) => d.getTime()))).toLocaleDateString();
        }
        case 'latest': {
          const dates = parseDates();
          if (dates.length === 0) return '-';
          return new Date(Math.max(...dates.map((d) => d.getTime()))).toLocaleDateString();
        }
        case 'date_range': {
          const dates = parseDates();
          if (dates.length < 2) return '-';
          const diffMs = Math.max(...dates.map((d) => d.getTime())) - Math.min(...dates.map((d) => d.getTime()));
          const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
          return `${days} day${days !== 1 ? 's' : ''}`;
        }
        default:
          return '';
      }
    },
    [columns, entities, customFieldData, config]
  );

  // Build state object. editingCell is kept on the type for compat but always null
  // here — consumers must use useIsCellEditing() from editing-store to check.
  const state: GridState<TEntity> = {
    columns,
    columnWidths,
    selectedRows,
    editingCell: null,
    editValue,
    openPopover,
    sortConfig,
    filters,
    fieldCalculations,
    customFieldData,
    optimisticUpdates,
    isExporting,
    isDeleting,
  };

  // Build context value
  const contextValue: GridContextValue<TEntity> = {
    config,
    actions,
    state,
    entities,
    filteredEntities,
    pagination,
    setColumns,
    setColumnWidths,
    setSelectedRows,
    setEditingCell,
    setEditValue,
    setOpenPopover,
    setSortConfig,
    setFilters,
    setFieldCalculations,
    setCustomFieldData,
    setOptimisticUpdates,
    setIsExporting,
    setIsDeleting,
    getVisibleColumns,
    getEntityWithOptimisticUpdates,
    updateEntityField,
    updateCustomFieldValue,
    getCustomFieldValue,
    addColumn,
    showColumn,
    deleteColumn,
    handleSort,
    handleHideColumn,
    handleMoveColumn,
    handleColumnResize,
    calculateTableWidth,
    getCalculationResult,
  };

  return <GridContext.Provider value={contextValue}>{children}</GridContext.Provider>;
}

// Hook to use the grid context
export function useGridContext<TEntity>(): GridContextValue<TEntity> {
  const context = useContext(GridContext);
  if (!context) {
    throw new Error('useGridContext must be used within a GridProvider');
  }
  return context as GridContextValue<TEntity>;
}
