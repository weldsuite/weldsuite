import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { SearchIconButton } from '@/components/entity-grid';
import {
  useInfiniteSearchLeads,
  type InfiniteSearchParams,
} from '@/hooks/queries/use-welddata-queries';
import { FilterPanel, type FilterValues } from './components/filter-panel';
import { filtersForKind } from './lib/filters-catalog';
import { WelddataSearchGrid } from './components/welddata-search-grid';

type Kind = 'person' | 'company';

/**
 * Loading additional result pages requires a paid Lemlist plan. The plan now
 * supports it, so infinite scroll is on — EntityGrid's sentinel auto-loads the
 * next page as the user scrolls. Results are KV-cached server-side, so paging
 * back and forth doesn't re-hit the Lemlist rate limit.
 */
const INFINITE_SCROLL_ENABLED = true;

export default function WelddataFindLeadsPage() {
  const t = useTranslations();
  const [kind, setKind] = useState<Kind>('person');
  const [keyword, setKeyword] = useState('');
  const [filters, setFilters] = useState<FilterValues>({});
  const [excludeListIds, setExcludeListIds] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState<InfiniteSearchParams | null>(null);

  const search = useInfiniteSearchLeads(submitted);
  const { data: searchData, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = search;

  const definitions = useMemo(() => filtersForKind(kind), [kind]);
  const rows = useMemo(() => searchData?.pages.flatMap((p) => p.rows) ?? [], [searchData]);
  const totalCount = searchData?.pages[0]?.total ?? 0;
  const hasSearched = submitted !== null;

  // A search must be scoped by at least one filter (the keyword box counts —
  // it becomes a keyword filter server-side). An unfiltered search is blocked.
  const activeFilters = useMemo(
    () =>
      Object.entries(filters)
        .filter(([, v]) => v.length > 0)
        .map(([filterId, values]) => ({ filterId, values })),
    [filters],
  );
  const canSearch = activeFilters.length > 0 || keyword.trim().length > 0;

  // Surface search failures once per error.
  useEffect(() => {
    if (isError) toast.error(t('welddata.toasts.searchFailed'));
  }, [isError, t]);

  // Infinite scroll is driven by EntityGrid's own sentinel; only wire it up
  // when enabled (paid Lemlist plan).
  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  function runSearch() {
    if (!canSearch) {
      toast.error(t('welddata.search.filterRequired'));
      return;
    }
    setSubmitted({
      kind,
      filters: activeFilters,
      keyword: keyword || undefined,
      // Max page size (schema cap) — fewer pages means fewer Lemlist requests.
      size: 100,
      excludeListIds: excludeListIds.length ? excludeListIds : undefined,
    });
  }

  function switchKind(next: Kind) {
    setKind(next);
    setFilters({});
    // Lists are kind-specific, so a person-list exclusion can't carry to a
    // company search.
    setExcludeListIds([]);
    setSubmitted(null);
  }

  return (
    <div className="flex h-full">
      {/* Filters */}
      <aside className="w-[400px] shrink-0 border-r p-4 pr-3 overflow-y-auto [scrollbar-gutter:stable]">
        <FilterPanel
          definitions={definitions}
          values={filters}
          onChange={(filterId, values) => setFilters((prev) => ({ ...prev, [filterId]: values }))}
          onClear={() => {
            setFilters({});
            setExcludeListIds([]);
          }}
          kind={kind}
          onKindChange={switchKind}
          excludeListIds={excludeListIds}
          onExcludeListIdsChange={setExcludeListIds}
        />
      </aside>

      {/* Results */}
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0">
          <WelddataSearchGrid
            // Remount on kind change to reset the grid; the toolbar carries the
            // server-search bar so it shares a single row with Sort/View.
            rows={rows}
            kind={kind}
            onLoadMore={INFINITE_SCROLL_ENABLED ? handleLoadMore : undefined}
            hasMore={INFINITE_SCROLL_ENABLED && hasNextPage}
            isFetchingMore={isFetchingNextPage}
            toolbarActions={
              <div className="flex items-center gap-2">
                {hasSearched && rows.length > 0 && (
                  <span className="mr-2 font-mono text-[13px] text-muted-foreground whitespace-nowrap">
                    {t('welddata.search.resultsCount', { count: totalCount })}
                  </span>
                )}

                <SearchIconButton
                  value={keyword}
                  onChange={setKeyword}
                  onSubmit={runSearch}
                  placeholder={t('welddata.search.placeholder')}
                />

                <Button
                  className="h-8"
                  onClick={runSearch}
                  disabled={search.isLoading || !canSearch}
                >
                  {search.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('welddata.search.run')}
                </Button>
              </div>
            }
          />
        </div>
      </main>
    </div>
  );
}
