
import React, { useState, useRef, useEffect, useMemo } from 'react';
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
  X,
  Check,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { useGridContext } from '../context';
import type { GridColumnDef, GridFilter } from '../types';

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
}: GridToolbarProps) {
  const t = useTranslations();
  const resolvedCreateButtonLabel = createButtonLabel ?? t('sweep.entities.newLabel');
  const resolvedSearchPlaceholder = searchPlaceholder ?? t('sweep.entities.searchEllipsisPlaceholder');
  const {
    config,
    state,
    setFilters,
    setSortConfig,
    setColumns,
    getVisibleColumns,
    handleSort,
    setIsExporting,
  } = useGridContext();

  const { sortConfig, filters, columns } = state;
  const visibleColumns = getVisibleColumns();
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
    <div className="bg-background sticky top-0 z-10 w-full border-b border-border" style={{ paddingTop: '10px', paddingBottom: '10px' }}>
      <div className="flex items-center gap-2 px-3 md:px-0 overflow-x-auto md:overflow-x-visible md:flex-wrap md:justify-between w-full">
        <div className={cn(
          "flex items-center gap-2 md:flex-shrink md:flex-wrap md:pl-4 transition-all duration-200 ease-out",
          searchOpen
            ? "max-w-0 opacity-0 overflow-hidden pointer-events-none md:max-w-none md:opacity-100 md:overflow-visible md:pointer-events-auto"
            : "max-w-full opacity-100 flex-shrink-0",
        )}>
          {/* Sort */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-8 text-sm px-3 shadow-none text-muted-foreground">
                {t('sweep.entities.sort')}
                {sortConfig.field && (
                  <span className="text-[11px] font-mono text-gray-400 bg-gray-100 dark:bg-secondary border border-gray-200 dark:border-border w-[18px] h-[18px] flex items-center justify-center rounded-[5px]">1</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0 ">
              <Command>
                <CommandInput placeholder={t('sweep.entities.searchColumnsPlaceholder')} />
                <CommandList className="max-h-[400px] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-gray-200 dark:[&::-webkit-scrollbar-thumb]:bg-gray-700 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent">
                  <CommandGroup heading={t('sweep.entities.sortByHeading')}>
                    {visibleColumns.map((column) => (
                      <div
                        key={column.id}
                        className="group relative flex items-center justify-between px-2 py-1.5 text-sm rounded-sm hover:bg-accent  cursor-default"
                      >
                        <div className="flex items-center gap-2">
                          {column.icon && React.createElement(column.icon, { className: 'h-4 w-4 text-muted-foreground' })}
                          <span>{column.name}</span>
                        </div>
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSort(column.id, 'asc');
                            }}
                            className={cn(
                              'p-1 rounded-md transition-colors',
                              sortConfig.field === column.id && sortConfig.direction === 'asc'
                                ? 'bg-muted'
                                : 'opacity-0 group-hover:opacity-100 hover:bg-muted'
                            )}
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSort(column.id, 'desc');
                            }}
                            className={cn(
                              'p-1 rounded-md transition-colors',
                              sortConfig.field === column.id && sortConfig.direction === 'desc'
                                ? 'bg-muted'
                                : 'opacity-0 group-hover:opacity-100 hover:bg-muted'
                            )}
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </CommandGroup>
                  {sortConfig.field && (
                    <>
                      <div className="h-px bg-border mx-1" />
                      <div className="p-1">
                        <CommandItem
                          onSelect={() => {
                            setSortConfig({ field: null, direction: null });
                            toast.success(t('sweep.entities.sortCleared'));
                          }}
                          className="text-red-600 hover:bg-red-50 dark:hover:bg-red-950 hover:text-red-600 data-[selected=true]:bg-red-50 dark:data-[selected=true]:bg-red-950 data-[selected=true]:text-red-600"
                        >
                          <Trash2 className="h-4 w-4 text-red-600" />
                          {t('sweep.entities.clearSort')}
                        </CommandItem>
                      </div>
                    </>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>

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
                <span className="md:hidden">{t('sweep.entities.viewsShort')}</span>
                <span className="hidden md:inline">{t('sweep.entities.viewSettings')}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56 max-h-[300px] overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/10 dark:[&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-track]:bg-transparent">
              <div className="px-2 py-2 text-xs font-semibold text-muted-foreground">{t('sweep.entities.showHideFields')}</div>
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
              {columns.filter(c => c.visible === false).length > 0 && (
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
          "flex items-center gap-2 md:flex-shrink md:flex-wrap md:pr-4 md:ml-auto transition-all duration-200 ease-out",
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
                <Button variant="outline" className={cn(
                  "hidden md:flex h-8 text-sm px-3 shadow-none text-muted-foreground",
                  searchOpen && "md:flex",
                )}>
                  {t('sweep.entities.importExport')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 ">
                {onExportCSV && (
                  <DropdownMenuItem onClick={handleExportCSV} disabled={isExporting} className="">
                    <Download className="h-4 w-4 mr-2" />
                    {isExporting ? t('sweep.entities.exportingEllipsis') : t('sweep.entities.exportViewAsCsv')}
                  </DropdownMenuItem>
                )}
                {onExportExcel && (
                  <DropdownMenuItem onClick={handleExportExcel} disabled={isExporting} className="">
                    <FileSpreadsheet className="h-4 w-4 mr-2" />
                    {isExporting ? t('sweep.entities.exportingEllipsis') : t('sweep.entities.exportViewAsExcel')}
                  </DropdownMenuItem>
                )}
                {(onExportCSV || onExportExcel) && onImport && <DropdownMenuSeparator />}
                {onImport && (
                  <DropdownMenuItem onClick={onImport} className="">
                    <Upload className="h-4 w-4 mr-2" />
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

function getFilterOperators(
  t: (path: string) => string,
): { value: string; label: string }[] {
  return [
    { value: 'contains', label: t('sweep.entities.operatorContains') },
    { value: 'equals', label: t('sweep.entities.operatorEquals') },
    { value: 'starts_with', label: t('sweep.entities.operatorStartsWith') },
    { value: 'is_empty', label: t('sweep.entities.operatorIsEmpty') },
    { value: 'is_not_empty', label: t('sweep.entities.operatorIsNotEmpty') },
  ];
}

function GridFilterPills<TEntity>({
  filters,
  columns,
  onFiltersChange,
  maxFilters = 5,
}: {
  filters: GridFilter[];
  columns: GridColumnDef<TEntity>[];
  onFiltersChange: (filters: GridFilter[]) => void;
  maxFilters?: number;
}) {
  const t = useTranslations();
  const FILTER_OPERATORS = useMemo(() => getFilterOperators(t), [t]);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [editingOperatorIndex, setEditingOperatorIndex] = useState<number | null>(null);
  const [editingValueIndex, setEditingValueIndex] = useState<number | null>(null);
  const [textInputValue, setTextInputValue] = useState('');

  const addFilter = (fieldId: string) => {
    if (filters.length >= maxFilters) return;
    const newIndex = filters.length;
    const newFilter: GridFilter = {
      id: Date.now().toString(),
      field: fieldId,
      operator: '' as GridFilter['operator'],
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
        setEditingOperatorIndex(newIndex);
      });
    });
  };

  const removeFilter = (index: number) => {
    setEditingOperatorIndex(null);
    setEditingValueIndex(null);
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  const updateOperator = (index: number, operator: GridFilter['operator']) => {
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index], operator };

    flushSync(() => {
      setEditingOperatorIndex(null);
      onFiltersChange(newFilters);
    });

    // If value-based operator and no value yet, open value editor
    if (operator !== 'is_empty' && operator !== 'is_not_empty' && !newFilters[index].value) {
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
    newFilters[index] = { ...newFilters[index], value };
    onFiltersChange(newFilters);
    setEditingValueIndex(null);
    setTextInputValue('');
  };

  const getColumnName = (fieldId: string) => {
    return columns.find((c) => c.id === fieldId)?.name || fieldId;
  };

  const getOperatorLabel = (operator: string) => {
    return FILTER_OPERATORS.find((o) => o.value === operator)?.label || operator;
  };

  const needsValue = (operator: string) => operator !== 'is_empty' && operator !== 'is_not_empty';

  return (
    <div className="flex items-center gap-2">
      {/* Active filter pills */}
      {filters.map((filter, index) => (
        <div
          key={filter.id}
          className="flex items-center h-[30px] bg-muted/50 rounded-md border border-border text-[13px]"
        >
          {/* Field name */}
          <div className="flex items-center px-2 h-full">
            <span className="text-muted-foreground">{getColumnName(filter.field)}</span>
          </div>

          <div className="h-full w-px bg-border" />

          {/* Operator popover */}
          <Popover
            open={editingOperatorIndex === index}
            onOpenChange={(open) => setEditingOperatorIndex(open ? index : null)}
          >
            <PopoverTrigger asChild>
              <Button variant="ghost" className={`px-2 h-full hover:bg-muted transition-colors ${filter.operator ? 'text-foreground' : 'text-muted-foreground/60'}`}>
                {filter.operator ? getOperatorLabel(filter.operator) : t('sweep.entities.selectCondition')}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto min-w-28 p-1">
              {FILTER_OPERATORS.map((op) => (
                <Button
                  key={op.value}
                  variant="ghost"
                  onClick={() => updateOperator(index, op.value as GridFilter['operator'])}
                  className="flex items-center justify-between w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
                >
                  <span>{op.label}</span>
                  {filter.operator === op.value && <Check className="h-3.5 w-3.5 text-primary ml-2" />}
                </Button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Value popover (only for operators that need a value) */}
          {needsValue(filter.operator) && (
            <>
              <div className="h-full w-px bg-border" />
              <Popover
                open={editingValueIndex === index}
                onOpenChange={(open) => {
                  setEditingValueIndex(open ? index : null);
                  if (open) setTextInputValue(filter.value || '');
                }}
              >
                <PopoverTrigger asChild>
                  <Button variant="ghost" className="flex items-center px-2 h-full hover:bg-muted transition-colors">
                    {filter.value ? (
                      <span className="text-foreground">{filter.value}</span>
                    ) : (
                      <span className="text-muted-foreground/60">{t('sweep.entities.enterValue')}</span>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-auto min-w-40 p-2">
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
                      className="h-8 text-sm"
                    />
                    <Button type="submit" size="sm" className="w-full mt-2 h-7 text-xs">
                      {t('sweep.entities.apply')}
                    </Button>
                  </form>
                </PopoverContent>
              </Popover>
            </>
          )}

          <div className="h-full w-px bg-border" />

          {/* Remove button */}
          <Button
            variant="ghost"
            onClick={() => removeFilter(index)}
            className="px-[7px] text-foreground hover:text-muted-foreground h-full"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}

      {/* Add filter button */}
      <Popover open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
        <PopoverTrigger asChild>
          {filters.length > 0 && filters.length < maxFilters ? (
            <Button variant="ghost" className="flex items-center justify-center h-[30px] w-[30px] border border-dashed border-border rounded-md text-muted-foreground hover:text-foreground hover:border-border">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : filters.length === 0 ? (
            <Button variant="outline" className="h-8 text-sm px-3 shadow-none text-muted-foreground">
              {t('sweep.entities.filter')}
            </Button>
          ) : null}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-36 p-1 max-h-[300px] overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-black/10 dark:[&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-track]:bg-transparent">
          {columns
            .filter((col) => !col.isEnrichField)
            .map((col) => (
              <Button
                key={col.id}
                variant="ghost"
                onClick={() => addFilter(col.id)}
                className="w-full px-2 py-1.5 text-sm text-left hover:bg-muted rounded"
              >
                {col.name}
              </Button>
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
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Called when Enter is pressed — used by server-submit searches. */
  onSubmit?: () => void;
}) {
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
          searchOpen ? "w-full md:w-48" : "w-8",
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
          searchOpen ? "opacity-100 w-full md:w-48" : "opacity-0 w-0 pointer-events-none"
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
