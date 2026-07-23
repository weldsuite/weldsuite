
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from '@/lib/router';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@weldsuite/ui/components/table";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@weldsuite/ui/components/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@weldsuite/ui/components/select";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Settings2,
  Filter,
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Package,
  ClipboardList,
  Grid3x3 as Grid3X3,
  ClipboardCheck,
  BookOpen,
  Building,
  FileEdit,
  Users,
  RotateCcw,
  Activity,
  Building2,
  ArrowRightLeft,
  FileText,
  MapPin,
  Warehouse,
  ShoppingCart,
  Tag,
  type LucideIcon,
} from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { useTranslations } from '@weldsuite/i18n/client';

// Icon name mapping for server component compatibility
const ICON_MAP: Record<string, LucideIcon> = {
  Package,
  ClipboardList,
  Grid3X3,
  ClipboardCheck,
  BookOpen,
  Building,
  FileEdit,
  Users,
  RotateCcw,
  Activity,
  Building2,
  ArrowRightLeft,
  FileText,
  MapPin,
  Warehouse,
  ShoppingCart,
  Tag,
};

export interface ColumnDefinition<T = any> {
  key: string;
  label: string;
  sortable?: boolean;
  render: (item: T) => React.ReactNode;
  width?: string;
  minWidth?: string;
  resizable?: boolean;
  className?: string;
}

// Alias for backward compatibility
export type Column<T = any> = ColumnDefinition<T>;

export interface FilterOption {
  key: string;
  label: string;
  type: "select" | "input" | "number";
  options?: { label: string; value: string }[];
  placeholder?: string;
}

export interface StatusFilter {
  key: string;
  label: string;
  value: string;
}

export interface PaginationData {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasMore: boolean;
}

export interface EntityDataTableProps<T = any> {
  data: T[];
  columns: ColumnDefinition<T>[];
  pagination: PaginationData;
  searchParams?: any;
  statusFilters?: StatusFilter[];
  additionalFilters?: FilterOption[];
  counts?: Record<string, number>;
  onFetchData?: (filters: Record<string, any>) => Promise<{
    data: T[];
    pagination: PaginationData;
    counts?: Record<string, number>;
  }>;
  onExport?: (filters: Record<string, any>) => Promise<void>;
  onRowClick?: (item: T) => void;
  emptyMessage?: string;
  emptyIcon?: string; // Icon name from lucide-react (e.g., "Package", "Users")
  hideControlsBar?: boolean; // Hide the entire controls bar (search, filters, column settings)
  leftControls?: React.ReactNode; // Custom content for the left side of the controls bar
}

export function EntityDataTable<T = any>({
  data: initialData,
  columns,
  pagination: initialPagination,
  searchParams: initialSearchParams = {},
  statusFilters = [],
  additionalFilters = [],
  counts: initialCounts = {},
  onFetchData,
  onExport,
  onRowClick,
  emptyMessage,
  emptyIcon = "Package",
  hideControlsBar = false,
  leftControls,
}: EntityDataTableProps<T>) {
  const t = useTranslations();
  const resolvedEmptyMessage = emptyMessage ?? t('sweep.entities.noItemsFound');
  // Get icon component from map
  const EmptyIcon = ICON_MAP[emptyIcon] || Package;
  const router = useRouter();
  const searchParams = useSearchParams();
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const hasInitiallyLoaded = useRef(false);

  // State
  const [loading, setLoading] = useState(false);
  const [isFiltering, setIsFiltering] = useState(false);
  const [data, setData] = useState<T[]>(initialData);
  const [counts, setCounts] = useState(initialCounts);
  const [pagination, setPagination] = useState(initialPagination);

  // Column resizing state
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    const widths: Record<string, number> = {};
    columns.forEach((col) => {
      if (col.width) {
        widths[col.key] = parseInt(col.width, 10) || 100;
      }
    });
    return widths;
  });
  const resizingRef = useRef<{
    columnKey: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  // Handle column resize start
  const handleResizeStart = useCallback(
    (e: React.MouseEvent, columnKey: string) => {
      e.preventDefault();
      e.stopPropagation();
      const column = columns.find((c) => c.key === columnKey);
      const minWidth = column?.minWidth ? parseInt(column.minWidth, 10) : 50;
      const currentWidth = columnWidths[columnKey] || (column?.width ? parseInt(column.width, 10) : 100);

      resizingRef.current = {
        columnKey,
        startX: e.clientX,
        startWidth: currentWidth,
      };
      setIsResizing(true);
    },
    [columns, columnWidths]
  );

  // Handle column resize
  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizingRef.current) return;

      const { columnKey, startX, startWidth } = resizingRef.current;
      const column = columns.find((c) => c.key === columnKey);
      const minWidth = column?.minWidth ? parseInt(column.minWidth, 10) : 50;

      const diff = e.clientX - startX;
      const newWidth = Math.max(minWidth, startWidth + diff);

      setColumnWidths((prev) => ({
        ...prev,
        [columnKey]: newWidth,
      }));
    };

    const handleMouseUp = () => {
      resizingRef.current = null;
      setIsResizing(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, columns]);

  // Update state when props change (for URL-based pagination)
  useEffect(() => {
    setData(initialData);
    setPagination(initialPagination);
    setCounts(initialCounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialData), JSON.stringify(initialPagination), JSON.stringify(initialCounts)]);

  // Filters
  const [statusFilter, setStatusFilter] = useState(initialSearchParams.status || "all");
  const [search, setSearch] = useState(initialSearchParams.search || "");
  const [sortBy, setSortBy] = useState(initialSearchParams.sortBy || "createdAt");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">(
    (initialSearchParams.sortOrder as "asc" | "desc") || "desc"
  );
  const [showFilters, setShowFilters] = useState(false);
  const [additionalFilterValues, setAdditionalFilterValues] = useState<Record<string, string>>(
    () => {
      const values: Record<string, string> = {};
      additionalFilters.forEach((filter) => {
        values[filter.key] = initialSearchParams[filter.key] || "";
      });
      return values;
    }
  );

  // Debounced search
  const debouncedSearch = useDebounce(search, 500);

  // Column visibility
  const [visibleColumns, setVisibleColumns] = useState<Record<string, boolean>>(() => {
    const visibility: Record<string, boolean> = {};
    columns.forEach((col) => {
      visibility[col.key] = true;
    });
    return visibility;
  });

  // Fetch data
  const loadData = useCallback(async () => {
    if (!onFetchData) return;

    setIsFiltering(true);

    const filters: Record<string, any> = {
      page: pagination.page,
      pageSize: pagination.pageSize,
      status: statusFilter,
      search: debouncedSearch,
      sortBy,
      sortOrder,
      ...additionalFilterValues,
    };

    try {
      const result = await onFetchData(filters);

      if (!result || !result.pagination) {
        console.error("Invalid data returned from onFetchData", result);
        setLoading(false);
        setIsFiltering(false);
        return;
      }

      setData(result.data || []);
      setPagination(result.pagination);
      setCounts(result.counts || {});
      setLoading(false);
      setIsFiltering(false);

      // Update URL params
      const newParams = new URLSearchParams(searchParams?.toString() || "");
      newParams.set("page", result.pagination.page?.toString() || "1");
      newParams.set("status", statusFilter);
      if (debouncedSearch) {
        newParams.set("search", debouncedSearch);
      } else {
        newParams.delete("search");
      }
      Object.entries(additionalFilterValues).forEach(([key, value]) => {
        if (value) {
          newParams.set(key, value);
        } else {
          newParams.delete(key);
        }
      });
      newParams.set("sortBy", sortBy);
      newParams.set("sortOrder", sortOrder);
      router.replace(`?${newParams.toString()}`, { scroll: false });
    } catch (error) {
      console.error("Error fetching data:", error);
      setLoading(false);
      setIsFiltering(false);
    }
  }, [
    pagination.page,
    pagination.pageSize,
    statusFilter,
    debouncedSearch,
    additionalFilterValues,
    sortBy,
    sortOrder,
    router,
    searchParams,
    onFetchData,
  ]);

  // Only fetch when filters change (not on initial load)
  useEffect(() => {
    if (!hasInitiallyLoaded.current) {
      hasInitiallyLoaded.current = true;
      return;
    }

    loadData();
  }, [
    pagination.page,
    pagination.pageSize,
    statusFilter,
    debouncedSearch,
    additionalFilterValues,
    sortBy,
    sortOrder,
  ]);

  // Reset page when filters change
  useEffect(() => {
    setPagination((prev) => ({ ...prev, page: 1 }));
  }, [statusFilter, debouncedSearch, additionalFilterValues]);

  // Handle sort
  const handleSort = (field: string) => {
    const newSortOrder = sortBy === field ? (sortOrder === "asc" ? "desc" : "asc") : "asc";

    setSortBy(field);
    setSortOrder(newSortOrder);

    const params = new URLSearchParams(searchParams?.toString() || "");
    params.set("sortBy", field);
    params.set("sortOrder", newSortOrder);
    params.set("page", "1");
    router.push(`?${params.toString()}`);
  };

  // Export data
  const handleExport = async () => {
    if (!onExport) return;

    const filters: Record<string, any> = {
      status: statusFilter,
      search: search,
      sortBy,
      sortOrder,
      ...additionalFilterValues,
    };

    try {
      await onExport(filters);
    } catch (error) {
      console.error("Error exporting data:", error);
    }
  };

  // Clear filters
  const handleClearFilters = () => {
    setSearch("");
    const clearedFilters: Record<string, string> = {};
    additionalFilters.forEach((filter) => {
      clearedFilters[filter.key] = "";
    });
    setAdditionalFilterValues(clearedFilters);
  };

  const hasActiveFilters =
    search ||
    Object.values(additionalFilterValues).some((value) => value !== "");

  const visibleColumnsArray = columns.filter((col) => visibleColumns[col.key]);

  return (
    <div className="space-y-4">
      {/* Controls Bar - Desktop */}
      {!hideControlsBar && (
      <div className="hidden md:flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Custom Left Controls */}
          {leftControls}
          {/* Status Filter Buttons */}
          {statusFilters.length > 0 && (
            <>
              <Button
                variant={statusFilter === "all" ? "default" : "outline"}
                onClick={() => {
                  setStatusFilter("all");
                  const params = new URLSearchParams(searchParams?.toString() || "");
                  params.delete("status");
                  params.set("page", "1");
                  router.push(`?${params.toString()}`);
                }}
                className="h-8 text-sm px-3 transition-all duration-200 relative overflow-hidden shadow-none"
                disabled={isFiltering}
              >
                <span className="relative z-10">{t('sweep.entities.all')}</span>
                {counts.total !== undefined && (
                  <span className="relative z-10 -ml-0.5 transition-all duration-300">
                    ({counts.total})
                  </span>
                )}
              </Button>
              {statusFilters.map((filter) => (
                <Button
                  key={filter.value}
                  variant={statusFilter === filter.value ? "default" : "outline"}
                  onClick={() => {
                    setStatusFilter(filter.value);
                    const params = new URLSearchParams(searchParams?.toString() || "");
                    params.set("status", filter.value);
                    params.set("page", "1");
                    router.push(`?${params.toString()}`);
                  }}
                  className="h-8 text-sm px-3 transition-all duration-200 relative overflow-hidden shadow-none"
                  disabled={isFiltering}
                >
                  <span className="relative z-10">{filter.label}</span>
                  {counts[filter.value] !== undefined && (
                    <span className="relative z-10 -ml-0.5 transition-all duration-300">
                      ({counts[filter.value]})
                    </span>
                  )}
                </Button>
              ))}
            </>
          )}

          {/* Clear Filters */}
          {hasActiveFilters && (
            <Button
              variant="link"
              onClick={handleClearFilters}
              className="text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              disabled={isFiltering}
            >
              {t('sweep.entities.clear')}
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Filter Toggle */}
          {additionalFilters.length > 0 && (
            <div className="relative">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowFilters(!showFilters)}
                className={`h-8 w-8 p-0 transition-all duration-200 shadow-none ${
                  showFilters ? "bg-muted" : ""
                }`}
                disabled={isFiltering}
              >
                <Filter className="h-4 w-4" />
              </Button>
              {hasActiveFilters && (
                <span className="absolute -top-1 -right-1 h-3 w-3 bg-primary rounded-full text-[9px] text-white flex items-center justify-center">
                  {Object.values(additionalFilterValues).filter(Boolean).length}
                </span>
              )}
            </div>
          )}

          {/* Column Settings */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 shadow-none">
                <Settings2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs">{t('sweep.entities.columnsLabel')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {columns.map((col) => (
                <DropdownMenuCheckboxItem
                  key={col.key}
                  checked={visibleColumns[col.key]}
                  onCheckedChange={(checked) =>
                    setVisibleColumns((prev) => ({ ...prev, [col.key]: checked }))
                  }
                  className="text-sm capitalize"
                >
                  {col.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Export */}
          {onExport && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExport}
              className="h-8 w-8 p-0 transition-all duration-200 shadow-none"
              disabled={isFiltering}
            >
              <Download className="h-4 w-4" />
            </Button>
          )}

          {/* Search */}
          <div className="relative ml-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
            <Input
              placeholder={t('sweep.entities.searchEllipsisPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-9 w-[250px] text-sm border border-border/50 bg-white dark:bg-background focus:bg-white dark:focus:bg-background shadow-none transition-all duration-200"
              disabled={isFiltering}
            />
            {debouncedSearch && isFiltering && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2">
                <div className="h-3 w-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Controls Bar - Mobile */}
      {!hideControlsBar && (
      <div className="flex md:hidden flex-col gap-3">
        <div className="flex items-center gap-2">
          {/* Filter Dropdown for Mobile */}
          {statusFilters.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 flex-shrink-0">
                  {t('sweep.entities.filter')}
                  {(statusFilter !== 'all' || hasActiveFilters) && (
                    <span className="ml-1.5 px-1.5 py-0.5 text-[10px] bg-primary text-primary-foreground rounded">
                      {(statusFilter !== 'all' ? 1 : 0) + Object.values(additionalFilterValues).filter(Boolean).length}
                    </span>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel className="text-xs">{t('sweep.entities.fieldStatus')}</DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => {
                    setStatusFilter("all");
                    const params = new URLSearchParams(searchParams?.toString() || "");
                    params.delete("status");
                    params.set("page", "1");
                    router.push(`?${params.toString()}`);
                  }}
                  className={cn(statusFilter === "all" && "bg-accent")}
                >
                  {t('sweep.entities.all')} {counts.total !== undefined && `(${counts.total})`}
                  {statusFilter === "all" && <span className="ml-auto text-primary">✓</span>}
                </DropdownMenuItem>
                {statusFilters.map((filter) => (
                  <DropdownMenuItem
                    key={filter.value}
                    onClick={() => {
                      setStatusFilter(filter.value);
                      const params = new URLSearchParams(searchParams?.toString() || "");
                      params.set("status", filter.value);
                      params.set("page", "1");
                      router.push(`?${params.toString()}`);
                    }}
                    className={cn(statusFilter === filter.value && "bg-accent")}
                  >
                    {filter.label} {counts[filter.value] !== undefined && `(${counts[filter.value]})`}
                    {statusFilter === filter.value && <span className="ml-auto text-primary">✓</span>}
                  </DropdownMenuItem>
                ))}
                {hasActiveFilters && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleClearFilters}>
                      {t('sweep.entities.clearAllFilters')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Search - Mobile */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
            <Input
              placeholder={t('sweep.entities.searchEllipsisPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-9 w-full text-sm border border-border/50 bg-white dark:bg-background shadow-none"
              disabled={isFiltering}
            />
          </div>

          {/* Export - Mobile */}
          {onExport && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              className="h-8 w-8 p-0 shadow-none flex-shrink-0"
              disabled={isFiltering}
            >
              <Download className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      )}

      <div className="space-y-3">
        {/* Filter Row */}
        {showFilters && additionalFilters.length > 0 && (
          <div className="flex flex-wrap gap-2 p-3 bg-gray-50 dark:bg-background/50 rounded-md border border-border/50 transition-all duration-300">
            {additionalFilters.map((filter) => (
              <div key={filter.key} className="flex flex-col gap-0.5">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide px-1">
                  {filter.label}
                </label>
                {filter.type === "select" ? (
                  <Select
                    value={additionalFilterValues[filter.key] || "all"}
                    onValueChange={(value) =>
                      setAdditionalFilterValues((prev) => ({
                        ...prev,
                        [filter.key]: value === "all" ? "" : value,
                      }))
                    }
                    disabled={isFiltering}
                  >
                    <SelectTrigger className="!h-[36px] !py-1 w-[130px] text-sm transition-all duration-200 shadow-none border border-border/50 bg-white dark:bg-card">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('sweep.entities.all')}</SelectItem>
                      {filter.options?.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={filter.type === "number" ? "number" : "text"}
                    placeholder={filter.placeholder || ""}
                    value={additionalFilterValues[filter.key] || ""}
                    onChange={(e) =>
                      setAdditionalFilterValues((prev) => ({
                        ...prev,
                        [filter.key]: e.target.value,
                      }))
                    }
                    className="!h-[36px] !py-1 w-[100px] text-sm transition-all duration-200 shadow-none border border-border/50 bg-white dark:bg-card"
                    disabled={isFiltering}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Table */}
        <div
          ref={tableContainerRef}
          className={`rounded-md border border-border/50 overflow-hidden ${isResizing ? "cursor-col-resize select-none" : ""}`}
          style={{
            minHeight: loading ? "400px" : data.length === 0 ? "200px" : "auto",
          }}
        >
          <div className={`overflow-x-auto ${isFiltering ? "no-scrollbar-transition" : ""}`}>
            <Table className="w-full min-w-[800px]">
              <TableHeader className="sticky top-0 z-5 bg-background">
                <TableRow className="border-b border-border/50">
                  {visibleColumnsArray.map((col, index) => {
                    const width = columnWidths[col.key] || (col.width ? parseInt(col.width, 10) : undefined);
                    const isResizable = col.resizable !== false; // Default to resizable
                    const isLastColumn = index === visibleColumnsArray.length - 1;

                    return (
                      <TableHead
                        key={col.key}
                        className={`h-10 px-3 bg-gray-50 dark:bg-background/50 font-medium text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap relative group ${
                          col.className || ""
                        } ${isResizing ? "select-none" : ""}`}
                        style={{ width: width ? `${width}px` : col.width, minWidth: col.minWidth }}
                      >
                        <div className="flex items-center justify-between">
                          {col.sortable ? (
                            <Button
                              variant="ghost"
                              onClick={() => handleSort(col.key)}
                              className="inline-flex items-center gap-1 hover:text-foreground transition-all duration-200 disabled:opacity-50"
                              disabled={isFiltering}
                            >
                              {col.label}
                              {sortBy === col.key ? (
                                sortOrder === "asc" ? (
                                  <ArrowUp className="h-3 w-3 text-primary" />
                                ) : (
                                  <ArrowDown className="h-3 w-3 text-primary" />
                                )
                              ) : (
                                <ArrowUpDown className="h-3 w-3 opacity-30 hover:opacity-50" />
                              )}
                            </Button>
                          ) : (
                            <span>{col.label}</span>
                          )}
                        </div>
                        {/* Resize handle */}
                        {isResizable && !isLastColumn && (
                          <div
                            className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-primary/30 active:bg-primary/50 transition-colors"
                            onMouseDown={(e) => handleResizeStart(e, col.key)}
                            style={{ touchAction: "none" }}
                          />
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody className="relative">
                {loading && !initialData.length ? (
                  // Skeleton loading rows
                  Array.from({ length: pagination.pageSize || 10 }).map((_, index) => (
                    <TableRow key={`skeleton-${index}`} className="border-b border-border/30">
                      {visibleColumnsArray.map((col) => (
                        <TableCell key={col.key} className="px-3 py-3">
                          <div className="h-4 bg-muted animate-pulse rounded w-24"></div>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : data.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={visibleColumnsArray.length}
                      className="text-center text-muted-foreground"
                    >
                      <div className="space-y-2 py-8">
                        <EmptyIcon className="h-12 w-12 mx-auto text-muted-foreground/30" />
                        <p className="font-medium">{resolvedEmptyMessage}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('sweep.entities.adjustFiltersOrSearch')}
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  data.map((item, rowIndex) => (
                    <TableRow
                      key={rowIndex}
                      className={`border-b border-border/30 hover:bg-muted/10 transition-colors duration-200 ${onRowClick ? 'cursor-pointer' : ''}`}
                      onClick={() => onRowClick?.(item)}
                    >
                      {visibleColumnsArray.map((col) => {
                        const width = columnWidths[col.key] || (col.width ? parseInt(col.width, 10) : undefined);
                        return (
                          <TableCell
                            key={col.key}
                            className={`px-3 py-3 ${col.className || ""}`}
                            style={{ width: width ? `${width}px` : col.width, minWidth: col.minWidth }}
                          >
                            {col.render(item)}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Pagination Footer */}
        <div className="flex items-center justify-center md:justify-between">
          {/* Item count - hidden on mobile */}
          <div className="hidden md:block text-sm text-muted-foreground">
            {t('sweep.entities.showingXToYOfZItems', {
              start: ((pagination.page - 1) * pagination.pageSize) + 1,
              end: Math.min(pagination.page * pagination.pageSize, pagination.totalCount),
              total: pagination.totalCount,
            })}
          </div>

          <div className="flex items-center gap-1 md:gap-2">
            {/* First page - hidden on mobile */}
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                const params = new URLSearchParams(searchParams?.toString() || "");
                params.set("page", "1");
                router.push(`?${params.toString()}`);
              }}
              disabled={pagination.page === 1 || isFiltering}
              className="h-8 w-8 shadow-none hidden md:flex"
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                const params = new URLSearchParams(searchParams?.toString() || "");
                params.set("page", (pagination.page - 1).toString());
                router.push(`?${params.toString()}`);
              }}
              disabled={pagination.page === 1 || isFiltering}
              className="h-8 w-8 shadow-none"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <span className="px-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{pagination.page}</span>
              <span className="mx-1">/</span>
              <span className="font-medium text-foreground">
                {pagination.totalPages}
              </span>
            </span>

            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                const params = new URLSearchParams(searchParams?.toString() || "");
                params.set("page", (pagination.page + 1).toString());
                router.push(`?${params.toString()}`);
              }}
              disabled={!pagination.hasMore || isFiltering}
              className="h-8 w-8 shadow-none"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {/* Last page - hidden on mobile */}
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                const params = new URLSearchParams(searchParams?.toString() || "");
                params.set("page", pagination.totalPages.toString());
                router.push(`?${params.toString()}`);
              }}
              disabled={!pagination.hasMore || isFiltering}
              className="h-8 w-8 shadow-none hidden md:flex"
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
