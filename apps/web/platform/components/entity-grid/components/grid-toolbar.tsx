
import React, { useState, useRef, useEffect } from 'react';
import { flushSync } from 'react-dom';
import {
  Plus,
  ArrowUp,
  ArrowDown,
  Trash2,
  Eye,
  EyeOff,
  Download,
  Upload,
  FileSpreadsheet,
  Search,
  Check,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  FilterAddButton,
  FilterButton,
  FilterMenuItem,
  FilterPill,
  FilterPillButton,
  FilterPillDivider,
  FilterPillLabel,
  FilterPillRemove,
} from '@weldsuite/ui/components/filter-button';
import { Input } from '@weldsuite/ui/components/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { useGridContext } from '../context';
import type { GridColumnDef, GridFilter } from '../types';
import {
  coerceFilterValue,
  filterValueList,
  getFilterOperators,
  isSelectFilterColumn,
  operatorNeedsValue,
  type FilterOperator,
} from '../utils/grid-filter';

interface GridToolbarProps {
  onCreateEntity?: () => void;
  onImport?: () => void;
  onExportCSV?: () => Promise<void>;
  onExportExcel?: () => Promise<void>;
  createButtonLabel?: string;
  isExporting?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Hide the Filter button + active filter pills. */
  hideFilter?: boolean;
  /** Extra controls rendered next to the Import/Export button. */
  extraActions?: React.ReactNode;
}

export function GridToolbar({
  onCreateEntity,
  onImport,
  onExportCSV,
  onExportExcel,
  createButtonLabel,
  isExporting = false,
  searchValue = '',
  onSearchChange,
  searchPlaceholder,
  hideFilter = false,
  extraActions,
}: Readonly<GridToolbarProps>) {
  const t = useTranslations();
  const resolvedCreateButtonLabel = createButtonLabel ?? t('sweep.entities.newLabel');
  const resolvedSearchPlaceholder = searchPlaceholder ?? t('sweep.entities.searchEllipsisPlaceholder');
  const {
  state,
  setFilters,
  setColumns,
  getVisibleColumns,
  handleSort,
  clearSort,
  setIsExporting,
} = useGridContext();

  const { sortConfig, filters, columns } = state;
  const visibleColumns = getVisibleColumns();
  // Only columns the grid can actually sort server-side (location/currency
  // placeholders etc. opt out via `sortable: false`).
  const sortableColumns = visibleColumns.filter((c) => c.sortable !== false);
  // Search open state lifted from <SearchIconButton/> so the toolbar can hide
  // sibling buttons + let the search field expand to the full row on mobile.
  const [searchOpen, setSearchOpen] = useState(!!searchValue);

  const handleExportCSV = async () => {
    if (onExportCSV) {
      setIsExporting(true);
      try {
        await onExportCSV();
      } finally {
        setIsExporting(false);
      }
    }
  };

  const handleExportExcel = async () => {
    if (onExportExcel) {
      setIsExporting(true);
      try {
        await onExportExcel();
      } finally {
        setIsExporting(false);
      }
    }
  };

  return (
    // `@container`: the toolbar compacts by its own width, not the viewport's,
    // so it also fits when a detail panel narrows the page beside it.
    <div className="@container bg-background sticky top-0 z-10 w-full border-b border-border" style={{ paddingTop: '10px', paddingBottom: '10px' }}>
      <div className="flex items-center gap-2 px-3 md:px-0 overflow-x-auto [scrollbar-width:none] md:flex-nowrap md:justify-between w-full">
        {/* Left group: on md+ it gives way to the right group (search, import,
            "New ...") and scrolls sideways, so a few active filters cannot push
            the create button off-screen. */}
        <div className={cn(
          // `py-1 -my-1 pr-1`: room inside the scroll box so focus rings are not clipped.
          "flex items-center gap-2 md:min-w-0 md:overflow-x-auto md:[scrollbar-width:none] md:pl-4 md:pr-1 md:py-1 md:-my-1 transition-all duration-200 ease-out",
          searchOpen
            ? "max-w-0 opacity-0 overflow-hidden pointer-events-none md:max-w-none md:opacity-100 md:pointer-events-auto"
            : "max-w-full opacity-100 flex-shrink-0 md:flex-shrink",
        )}>
          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "h-8 text-sm px-3 shadow-none text-muted-foreground",
                  sortConfig.field && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary dark:border-primary/40 dark:bg-primary/10 dark:hover:bg-primary/15",
                )}
              >
                {t('sweep.entities.sort')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 max-h-[300px] overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/10 dark:[&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-track]:bg-transparent">
              {sortableColumns.map((column) => {
                const activeDirection = sortConfig.field === column.id ? sortConfig.direction : null;
                return (
                  <DropdownMenuSub key={column.id}>
                    <DropdownMenuSubTrigger className="gap-2">
                      {column.icon && React.createElement(column.icon, { className: 'h-4 w-4' })}
                      <span>{column.name}</span>
                      {activeDirection === 'asc' && <ArrowUp className="h-4 w-4 text-muted-foreground" />}
                      {activeDirection === 'desc' && <ArrowDown className="h-4 w-4 text-muted-foreground" />}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => handleSort(column.id, 'asc')}>
                        <ArrowUp className="h-4 w-4" />
                        <span>{t('sweep.entities.sortAscending')}</span>
                        {activeDirection === 'asc' && <Check className="ml-auto h-4 w-4" />}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleSort(column.id, 'desc')}>
                        <ArrowDown className="h-4 w-4" />
                        <span>{t('sweep.entities.sortDescending')}</span>
                        {activeDirection === 'desc' && <Check className="ml-auto h-4 w-4" />}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                );
              })}
              {sortConfig.field && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      clearSort();
                      toast.success(t('sweep.entities.sortCleared'));
                    }}
                    className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950"
                  >
                    <Trash2 className="h-4 w-4 text-red-600" />
                    {t('sweep.entities.clearSort')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Filter pills */}
          {!hideFilter && (
            <GridFilterPills
              filters={filters}
              columns={visibleColumns}
              onFiltersChange={setFilters}
              maxFilters={5}
            />
          )}

          {/* View settings */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-8 text-sm px-3 shadow-none text-muted-foreground">
                <span className="@min-[761px]:hidden">{t('sweep.entities.viewsShort')}</span>
                <span className="hidden @min-[761px]:inline">{t('sweep.entities.viewSettings')}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 max-h-[300px] overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/10 dark:[&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-track]:bg-transparent">
              {columns.map((column) => (
                <DropdownMenuItem
                  key={column.id}
                  onClick={(e) => {
                    e.preventDefault();
                    setColumns(columns.map(c => c.id === column.id ? { ...c, visible: !c.visible } : c));
                  }}
                  className="flex items-center justify-between "
                >
                  <div className="flex items-center gap-2">
                    {column.icon && React.createElement(column.icon, { className: 'h-4 w-4' })}
                    <span>{column.name}</span>
                  </div>
                  {column.visible !== false ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4 text-muted-foreground" />}
                </DropdownMenuItem>
              ))}
              {columns.some(c => c.visible === false) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      setColumns(columns.map(c => ({ ...c, visible: true })));
                      toast.success(t('sweep.entities.allFieldsShown'));
                    }}
                    className="text-red-600 focus:text-red-600 focus:bg-red-50 dark:focus:bg-red-950"
                  >
                    <Trash2 className="h-4 w-4 text-red-600" />
                    {t('sweep.entities.clearAll')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className={cn(
          "flex items-center gap-2 md:flex-shrink-0 md:pr-4 md:ml-auto transition-all duration-200 ease-out",
          searchOpen ? "flex-1 ml-0 md:flex-none md:ml-auto" : "flex-shrink-0 ml-auto",
        )}>
          {/* Search */}
          {onSearchChange && (
            <SearchIconButton
              value={searchValue}
              onChange={onSearchChange}
              placeholder={resolvedSearchPlaceholder}
              isOpen={searchOpen}
              onOpenChange={setSearchOpen}
            />
          )}

          {/* Import/Export */}
          {(onExportCSV || onExportExcel || onImport) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  aria-label={t('sweep.entities.importExport')}
                  className={cn(
                    "hidden md:flex h-8 text-sm px-3 shadow-none text-muted-foreground",
                    searchOpen && "md:flex",
                  )}
                >
                  {/* Narrow toolbar: the label collapses to an icon. */}
                  <span className="hidden @min-[761px]:inline">{t('sweep.entities.importExport')}</span>
                  <FileSpreadsheet className="h-4 w-4 @min-[761px]:hidden" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {onExportCSV && (
                  <DropdownMenuItem onClick={handleExportCSV} disabled={isExporting}>
                    <Download className="h-4 w-4" />
                    {isExporting ? t('sweep.entities.exportingEllipsis') : t('sweep.entities.exportViewAsCsv')}
                  </DropdownMenuItem>
                )}
                {onExportExcel && (
                  <DropdownMenuItem onClick={handleExportExcel} disabled={isExporting}>
                    <FileSpreadsheet className="h-4 w-4" />
                    {isExporting ? t('sweep.entities.exportingEllipsis') : t('sweep.entities.exportViewAsExcel')}
                  </DropdownMenuItem>
                )}
                {(onExportCSV || onExportExcel) && onImport && <DropdownMenuSeparator />}
                {onImport && (
                  <DropdownMenuItem onClick={onImport}>
                    <Upload className="h-4 w-4" />
                    {t('sweep.entities.importCsvExcel')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {extraActions}

          {/* Create button */}
          {onCreateEntity && (
            <Button
              data-testid="entity-grid-create-btn"
              className={cn(
                "h-8 text-sm pl-[10px] pr-[14px] shadow-none",
                searchOpen && "hidden md:inline-flex",
              )}
              onClick={onCreateEntity}
            >
              <Plus className="h-3.5 w-3.5 -mr-[1px]" />
              {resolvedCreateButtonLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Filter pills — inline pill-based filter UI (matches entity-list filter-pills)
// =============================================================================

/**
 * Operator labels. "equals" reads "is" on a select column (Status is Active),
 * where the value is picked from a list rather than typed.
 */
function getOperatorLabels(
  t: (path: string) => string,
  isSelectColumn: boolean,
): Record<FilterOperator, string> {
  return {
    contains: t('sweep.entities.operatorContains'),
    equals: isSelectColumn ? t('sweep.entities.operatorIs') : t('sweep.entities.operatorEquals'),
    not_equals: t('sweep.entities.operatorIsNot'),
    in: t('sweep.entities.operatorIsAnyOf'),
    starts_with: t('sweep.entities.operatorStartsWith'),
    is_empty: t('sweep.entities.operatorIsEmpty'),
    is_not_empty: t('sweep.entities.operatorIsNotEmpty'),
    gt: '>',
    lt: '<',
    gte: '≥',
    lte: '≤',
  };
}

function GridFilterPills<TEntity>({
  filters,
  columns,
  onFiltersChange,
  maxFilters = 5,
}: Readonly<{
  filters: GridFilter[];
  columns: GridColumnDef<TEntity>[];
  onFiltersChange: (filters: GridFilter[]) => void;
  maxFilters?: number;
}>) {
  const t = useTranslations();
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [editingOperatorIndex, setEditingOperatorIndex] = useState<number | null>(null);
  const [editingValueIndex, setEditingValueIndex] = useState<number | null>(null);
  const [textInputValue, setTextInputValue] = useState('');
  const [valueSearchQuery, setValueSearchQuery] = useState('');

  const getColumn = (fieldId: string) => columns.find((c) => c.id === fieldId);

  const addFilter = (fieldId: string) => {
    if (filters.length >= maxFilters) return;
    const newIndex = filters.length;
    // A select column (Status, ...) starts on "is" and goes straight to its
    // option list; other columns ask for the condition first.
    const isSelectColumn = isSelectFilterColumn(getColumn(fieldId));
    const newFilter: GridFilter = {
      id: Date.now().toString(),
      field: fieldId,
      operator: isSelectColumn ? 'equals' : ('' as GridFilter['operator']),
      value: '',
    };

    flushSync(() => {
      setEditingOperatorIndex(null);
      setEditingValueIndex(null);
      setFilterMenuOpen(false);
      setTextInputValue('');
      onFiltersChange([...filters, newFilter]);
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (isSelectColumn) setEditingValueIndex(newIndex);
        else setEditingOperatorIndex(newIndex);
      });
    });
  };

  const removeFilter = (index: number) => {
    setEditingOperatorIndex(null);
    setEditingValueIndex(null);
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  const updateOperator = (index: number, operator: FilterOperator) => {
    const value = coerceFilterValue(filters[index]!.value, operator);
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index]!, operator, value };

    flushSync(() => {
      setEditingOperatorIndex(null);
      onFiltersChange(newFilters);
    });

    // If value-based operator and no value yet, open value editor. "Is any of"
    // opens it too: the point of switching to it is to add more values.
    if (operatorNeedsValue(operator) && (operator === 'in' || filterValueList(value).length === 0)) {
      setTextInputValue('');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setEditingValueIndex(index);
        });
      });
    }
  };

  const updateValue = (index: number, value: string) => {
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index]!, value };
    onFiltersChange(newFilters);
    setEditingValueIndex(null);
    setTextInputValue('');
  };

  // "is any of": the popover stays open so several options can be ticked.
  const toggleValue = (index: number, option: string) => {
    const current = filterValueList(filters[index]!.value);
    const next = current.includes(option) ? current.filter((v) => v !== option) : [...current, option];
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index]!, value: next };
    onFiltersChange(newFilters);
  };

  const getColumnName = (fieldId: string) => {
    return getColumn(fieldId)?.name || fieldId;
  };

  const getOperatorLabel = (filter: GridFilter) => {
    const labels = getOperatorLabels(t, isSelectFilterColumn(getColumn(filter.field)));
    return labels[filter.operator] || filter.operator;
  };

  // Single/multi-select columns (e.g. Status) carry a fixed `options` list
  // and a `selectConfig` of display labels — the filter value is picked from
  // those, not typed as free text, since the stored value is the option's
  // slug/key (e.g. "active"), not its label ("Active").
  const getFilterColumnOptions = (fieldId: string): string[] | null => {
    const column = getColumn(fieldId);
    return isSelectFilterColumn(column) ? (column?.options ?? null) : null;
  };

  const getValueLabel = (fieldId: string, value: string): string => {
    return getColumn(fieldId)?.selectConfig?.[value]?.label ?? value;
  };

  /** What the value button shows: the picked option(s), or null while none is picked. */
  const getValueSummary = (filter: GridFilter): string | null => {
    const labels = filterValueList(filter.value).map((v) => getValueLabel(filter.field, v));
    if (labels.length === 0) return null;
    if (labels.length <= 2) return labels.join(', ');
    return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
  };

  // Built from the shared filter controls, like the entity-list FilterPills
  // (WeldFlow My Tasks), so both filter rows look the same.
  let filterTrigger: React.ReactNode = null;
  if (filters.length > 0 && filters.length < maxFilters) {
    filterTrigger = <FilterAddButton aria-label={t('sweep.entities.filter')} />;
  } else if (filters.length === 0) {
    filterTrigger = <FilterButton>{t('sweep.entities.filter')}</FilterButton>;
  }

  return (
    <div className="flex items-center gap-2 shrink-0">
      {/* Active filter pills */}
      {filters.map((filter, index) => {
        const selectOptions = getFilterColumnOptions(filter.field);
        const isMulti = filter.operator === 'in';
        const selectedValues = filterValueList(filter.value);
        const valueSummary = getValueSummary(filter);
        return (
        <FilterPill key={filter.id}>
          <FilterPillLabel>{getColumnName(filter.field)}</FilterPillLabel>

          <FilterPillDivider />

          {/* Operator popover */}
          <Popover
            open={editingOperatorIndex === index}
            onOpenChange={(open) => setEditingOperatorIndex(open ? index : null)}
          >
            <PopoverTrigger asChild>
              <FilterPillButton empty={!filter.operator}>
                {filter.operator ? getOperatorLabel(filter) : t('sweep.entities.selectCondition')}
              </FilterPillButton>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto min-w-28 p-1">
              {getFilterOperators(getColumn(filter.field)).map((operator) => (
                <FilterMenuItem key={operator} onClick={() => updateOperator(index, operator)}>
                  <span>{getOperatorLabels(t, selectOptions !== null)[operator]}</span>
                  {filter.operator === operator && <Check className="h-3.5 w-3.5 text-primary" />}
                </FilterMenuItem>
              ))}
            </PopoverContent>
          </Popover>

          {/* Value popover (only for operators that need a value) */}
          {operatorNeedsValue(filter.operator) && (
            <>
              <FilterPillDivider />
              <Popover
                open={editingValueIndex === index}
                onOpenChange={(open) => {
                  setEditingValueIndex(open ? index : null);
                  if (open) setTextInputValue(filterValueList(filter.value)[0] ?? '');
                  if (!open) setValueSearchQuery('');
                }}
              >
                <PopoverTrigger asChild>
                  <FilterPillButton empty={!valueSummary}>
                    {valueSummary ??
                      (selectOptions
                        ? t('sweep.entities.selectFieldValue', { field: getColumnName(filter.field).toLowerCase() })
                        : t('sweep.entities.enterValue'))}
                  </FilterPillButton>
                </PopoverTrigger>
                <PopoverContent align="start" className={cn('w-auto min-w-40', selectOptions ? 'p-0' : 'p-1')}>
                  {selectOptions ? (
                    // Single/multi-select column — pick from its configured
                    // options instead of typing free text (a filter on e.g.
                    // Status would otherwise never match anything, since the
                    // stored value is the status slug, not what's displayed).
                    <>
                      <div className="flex items-center gap-1.5 px-3 h-[36px] border-b border-border">
                        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0 -translate-y-[0.5px]" />
                        <input
                          autoFocus
                          value={valueSearchQuery}
                          onChange={(e) => setValueSearchQuery(e.target.value)}
                          placeholder={t('sweep.entities.searchEllipsisPlaceholder')}
                          className="flex-1 text-[13px] bg-transparent outline-none placeholder:text-muted-foreground"
                        />
                      </div>
                      <div className="max-h-[200px] overflow-y-auto p-1">
                        {(() => {
                          const query = valueSearchQuery.toLowerCase();
                          const matching = selectOptions.filter((option) =>
                            getValueLabel(filter.field, option).toLowerCase().includes(query),
                          );
                          if (matching.length === 0) {
                            return (
                              <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                                {t('sweep.entities.noOptionFound')}
                              </div>
                            );
                          }
                          return matching.map((option) => {
                            const isSelected = selectedValues.includes(option);
                            return (
                              <FilterMenuItem
                                key={option}
                                onClick={() => {
                                  if (isMulti) {
                                    toggleValue(index, option);
                                  } else {
                                    updateValue(index, option);
                                    setValueSearchQuery('');
                                  }
                                }}
                              >
                                <span>{getValueLabel(filter.field, option)}</span>
                                {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                              </FilterMenuItem>
                            );
                          });
                        })()}
                      </div>
                    </>
                  ) : (
                    <div className="p-2">
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (textInputValue.trim()) {
                            updateValue(index, textInputValue.trim());
                          }
                        }}
                      >
                        <Input
                          autoFocus
                          value={textInputValue}
                          onChange={(e) => setTextInputValue(e.target.value)}
                          placeholder={t('sweep.entities.enterValueEllipsis')}
                          className="h-8 text-sm shadow-none focus-visible:ring-0"
                        />
                        <Button type="submit" size="sm" className="w-full mt-2 h-8 text-sm">
                          {t('sweep.entities.apply')}
                        </Button>
                      </form>
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </>
          )}

          <FilterPillDivider />

          <FilterPillRemove onClick={() => removeFilter(index)} />
        </FilterPill>
        );
      })}

      {/* Add filter: field picker (Filter / + button) */}
      <Popover open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
        <PopoverTrigger asChild>
          {filterTrigger}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          // No close animation: the trigger moves when a pill is added, and the
          // closing popover would visibly follow it. Focus moves into the new
          // filter's own popover, not back to the trigger.
          className="w-56 max-h-[300px] overflow-y-auto p-1 data-[state=closed]:!animate-none data-[state=closed]:!duration-0"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {columns
            .filter((col) => !col.isEnrichField)
            .map((col) => (
              <FilterMenuItem key={col.id} onClick={() => addFilter(col.id)}>
                {col.name}
              </FilterMenuItem>
            ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function SearchIconButton({
  value,
  onChange,
  placeholder,
  isOpen,
  onOpenChange,
  onSubmit,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called when Enter is pressed — used by server-submit searches. */
  onSubmit?: () => void;
}>) {
  const [internalOpen, setInternalOpen] = useState(!!value);
  const searchOpen = isOpen ?? internalOpen;
  const setSearchOpen = onOpenChange ?? setInternalOpen;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [searchOpen]);

  return (
    <div className={cn(
      "relative flex items-center",
      // On mobile, allow the search to fill all available width when open
      // (the parent toolbar row stretches it via flex-1).
      searchOpen && "w-full md:w-auto",
    )}>
      <div
        className={cn(
          "flex items-center transition-all duration-200 ease-out",
          searchOpen ? "max-md:w-full md:@max-[760px]:w-32 md:@min-[761px]:w-48" : "w-8",
        )}
      >
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 w-8 p-0 flex-shrink-0 shadow-none transition-opacity duration-200",
            searchOpen && "opacity-0 pointer-events-none absolute"
          )}
          onClick={() => setSearchOpen(true)}
        >
          <Search className="h-4 w-4" />
        </Button>
        <div className={cn(
          "relative transition-all duration-200 ease-out",
          searchOpen ? "opacity-100 max-md:w-full md:@max-[760px]:w-32 md:@min-[761px]:w-48" : "opacity-0 w-0 pointer-events-none"
        )}>
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onSubmit) onSubmit();
            }}
            onBlur={() => !value && setSearchOpen(false)}
            data-testid="entity-grid-search"
            className="h-8 w-full pl-8 pr-3 text-sm border border-gray-200 dark:border-border rounded-md bg-white dark:bg-background focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
}
