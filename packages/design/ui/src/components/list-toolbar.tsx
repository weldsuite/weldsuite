import * as React from 'react';
import { Plus, Search } from 'lucide-react';

import { cn } from '@weldsuite/ui/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import {
  FilterPills,
  type ActiveFilter,
  type FilterConfig,
} from '@weldsuite/ui/components/filter-pills';

export type { ActiveFilter, FilterConfig } from '@weldsuite/ui/components/filter-pills';

export interface ListToolbarCreateButton {
  label: string;
  onClick: () => void;
}

export interface ListToolbarProps {
  // ─── Filters ───────────────────────────────────────────────────────────
  /** Filter chip configs. Omit to hide the filter UI entirely. */
  filterConfigs?: FilterConfig[];
  /** Active filters (controlled). */
  filters?: ActiveFilter[];
  /** Called whenever filters are added / removed / edited. */
  onFiltersChange?: (filters: ActiveFilter[]) => void;
  /** Upper bound on concurrent filters. Defaults to 5. */
  maxFilters?: number;

  // ─── Search ────────────────────────────────────────────────────────────
  /** Controlled search text. When undefined the search UI is hidden. */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;

  // ─── Slots ─────────────────────────────────────────────────────────────
  /** Extra buttons rendered on the left (next to filter pills). */
  leftActionButtons?: React.ReactNode;
  /** Extra buttons rendered on the right, before the Create button. */
  actionButtons?: React.ReactNode;
  /** Primary CTA rendered at the far right. */
  createButton?: ListToolbarCreateButton;

  // ─── Styling ───────────────────────────────────────────────────────────
  className?: string;
}

/**
 * Top-bar for list pages — direct port of the `Top Bar` block from
 * `apps/web/platform/components/entity-list/entity-list.tsx`. Filter pills on the
 * left (desktop), always-visible search on mobile, expandable icon-button
 * search on desktop, action-button slots, and a primary "Create" CTA.
 *
 * Controlled: callers own `search` and `filters` state, and render the
 * resulting filtered data in their own `ListTable` below.
 */
export function ListToolbar({
  filterConfigs,
  filters = [],
  onFiltersChange,
  maxFilters = 5,
  search,
  onSearchChange,
  searchPlaceholder = 'Search...',
  leftActionButtons,
  actionButtons,
  createButton,
  className,
}: ListToolbarProps) {
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const showFilters = !!filterConfigs && filterConfigs.length > 0 && !!onFiltersChange;
  const showSearch = search !== undefined && !!onSearchChange;

  React.useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [searchOpen]);

  return (
    <div
      className={cn(
        'flex items-center justify-between px-3 md:px-4 h-[53px] border-b border-border',
        className,
      )}
    >
      <div className="hidden md:flex items-center gap-2">
        {showFilters ? (
          <FilterPills
            filters={filters}
            filterConfigs={filterConfigs!}
            maxFilters={maxFilters}
            onFiltersChange={onFiltersChange!}
          />
        ) : null}
        {leftActionButtons}
      </div>

      {/* Mobile: search always visible */}
      {showSearch ? (
        <div className="md:hidden flex-1 mr-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => onSearchChange!(e.target.value)}
              className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
            />
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {/* Desktop: Search toggle */}
        {showSearch ? (
          <div className="relative hidden md:flex items-center">
            <div
              className={cn(
                'flex items-center transition-all duration-200 ease-out',
                searchOpen ? 'w-48' : 'w-8',
              )}
            >
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'h-8 w-8 p-0 flex-shrink-0 transition-opacity duration-200',
                  searchOpen && 'opacity-0 pointer-events-none absolute',
                )}
                onClick={() => setSearchOpen(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
              <div
                className={cn(
                  'relative transition-all duration-200 ease-out',
                  searchOpen ? 'opacity-100 w-48' : 'opacity-0 w-0 pointer-events-none',
                )}
              >
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder={searchPlaceholder}
                  value={search}
                  onChange={(e) => onSearchChange!(e.target.value)}
                  onBlur={() => !search && setSearchOpen(false)}
                  className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
                />
              </div>
            </div>
          </div>
        ) : null}

        {actionButtons}

        {/* Create button */}
        {createButton ? (
          <Button
            size="sm"
            className="h-8 bg-primary text-primary-foreground hover:bg-primary/90 relative z-10"
            onClick={createButton.onClick}
          >
            <Plus className="h-4 w-4 md:mr-0.5" />
            <span className="hidden md:inline">{createButton.label}</span>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
