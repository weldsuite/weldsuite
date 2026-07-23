
import React, { ReactNode } from 'react';
import { Search, RefreshCw, Filter, Check } from 'lucide-react';
import { Input } from '@weldsuite/ui/components/input';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';

interface FilterOption<T extends string = string> {
  value: T;
  label: string;
}

interface ListPanelProps<T extends string = string> {
  /** Search query value */
  searchQuery: string;
  /** Callback when search query changes */
  onSearchChange: (query: string) => void;
  /** Placeholder text for search input */
  searchPlaceholder?: string;
  /** Filter options */
  filterOptions?: FilterOption<T>[];
  /** Currently active filter */
  activeFilter?: T;
  /** Callback when filter changes */
  onFilterChange?: (filter: T) => void;
  /** Whether data is loading */
  isLoading?: boolean;
  /** Callback to refresh data */
  onRefresh?: () => void;
  /** Show refresh button */
  showRefresh?: boolean;
  /** Show filter button */
  showFilter?: boolean;
  /** The list content */
  children: ReactNode;
  /** Empty state content */
  emptyState?: ReactNode;
  /** Loading state content */
  loadingState?: ReactNode;
  /** Whether the list is empty */
  isEmpty?: boolean;
  /** Additional header content (rendered between search and list) */
  headerContent?: ReactNode;
  /** Additional className for the container */
  className?: string;
}

function ListPanel<T extends string = string>({
  searchQuery,
  onSearchChange,
  searchPlaceholder,
  filterOptions,
  activeFilter,
  onFilterChange,
  isLoading = false,
  onRefresh,
  showRefresh = true,
  showFilter = true,
  children,
  emptyState,
  loadingState,
  isEmpty = false,
  headerContent,
  className,
}: ListPanelProps<T>) {
  const t = useTranslations();
  const resolvedSearchPlaceholder = searchPlaceholder ?? t('sweep.entities.searchEllipsisPlaceholder');
  const defaultLoadingState = (
    <div className="flex flex-col items-center justify-center py-20">
      <RefreshCw className="h-8 w-8 text-gray-400 animate-spin mb-3" />
      <p className="text-sm text-gray-500">{t('sweep.entities.loadingEllipsis')}</p>
    </div>
  );

  const defaultEmptyState = (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-background/50 flex items-center justify-center mb-3">
        <Search className="h-5 w-5 text-gray-400 dark:text-gray-600" />
      </div>
      <p className="text-sm text-gray-500 dark:text-muted-foreground">{t('sweep.entities.noItemsFound')}</p>
    </div>
  );

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Header */}
      <div className="pt-4 pb-3 px-3">
        {/* Search Bar, Filter and Buttons */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70" />
            <Input
              placeholder={resolvedSearchPlaceholder}
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-9 pl-9 w-full text-sm border border-border/50 bg-white focus:bg-white shadow-none transition-all duration-200"
            />
          </div>

          {showRefresh && onRefresh && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onRefresh}
              disabled={isLoading}
              className="h-9 w-9 rounded-md transition-colors flex items-center justify-center flex-shrink-0 focus:outline-none focus-visible:ring-0 border border-border/50 hover:bg-gray-100"
            >
              <RefreshCw className={cn("h-4 w-4 text-gray-500", isLoading && "animate-spin")} />
            </Button>
          )}

          {showFilter && filterOptions && filterOptions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-9 w-9 rounded-md transition-colors flex items-center justify-center flex-shrink-0 focus:outline-none focus-visible:ring-0 border border-border/50 hover:bg-gray-100",
                    activeFilter && activeFilter !== filterOptions[0]?.value && "bg-blue-50 border-blue-200 text-blue-600"
                  )}
                >
                  <Filter
                    className={cn(
                      "h-4 w-4",
                      activeFilter && activeFilter !== filterOptions[0]?.value ? "text-blue-600" : "text-gray-500"
                    )}
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {filterOptions.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    className="text-sm flex items-center justify-between"
                    onClick={() => onFilterChange?.(option.value)}
                  >
                    {option.label}
                    {activeFilter === option.value && (
                      <Check className="h-4 w-4 text-blue-600" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {headerContent}
      </div>

      {/* List Content */}
      <div
        className="flex-1 overflow-y-auto overflow-x-hidden"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(156, 163, 175, 0.3) transparent',
        }}
      >
        {isLoading ? (
          loadingState || defaultLoadingState
        ) : isEmpty ? (
          emptyState || defaultEmptyState
        ) : (
          children
        )}
      </div>
    </div>
  );
}
