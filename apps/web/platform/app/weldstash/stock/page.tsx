import { Suspense, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { useDebounce } from '@/hooks/use-debounce';
import { PageLoader } from '@/components/page-loader';
import { useInfiniteWeldstashStock } from '@/hooks/queries/use-weldstash-queries';
import type { WeldstashStockRow } from '@weldsuite/core-api-client/schemas/weldstash';
import { StockList } from './components/stock-list';

function StockPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';
  // The input stays bound to the URL value so typing feels immediate; only the
  // value that forms the infinite-query key is debounced, so a search costs one
  // request per pause instead of one per keystroke plus a cache entry each.
  const debouncedSearch = useDebounce(search, 300);
  const warehouseId = searchParams.get('warehouseId') || undefined;
  // The overview's low-stock card links here with ?lowStockOnly=true.
  const lowStockOnly = searchParams.get('lowStockOnly') === 'true' || undefined;

  const setSearch = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set('search', value);
      else params.delete('search');
      const qs = params.toString();
      router.replace(`/weldstash/stock${qs ? `?${qs}` : ''}`);
    },
    [router, searchParams],
  );

  const filters = useMemo(() => {
    const f: { limit: number; search?: string; warehouseId?: string; lowStockOnly?: boolean } = {
      limit: 50,
    };
    if (debouncedSearch) f.search = debouncedSearch;
    if (warehouseId) f.warehouseId = warehouseId;
    if (lowStockOnly) f.lowStockOnly = true;
    return f;
  }, [debouncedSearch, warehouseId, lowStockOnly]);

  const {
    data: infiniteData,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteWeldstashStock(filters);

  const rows = useMemo<WeldstashStockRow[]>(
    () => infiniteData?.pages.flatMap((p) => p.data ?? []) ?? [],
    [infiniteData],
  );

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <StockList
      stock={rows}
      isLoading={isLoading}
      search={search}
      onSearchChange={setSearch}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function WeldStashStockPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <StockPageContent />
    </Suspense>
  );
}
