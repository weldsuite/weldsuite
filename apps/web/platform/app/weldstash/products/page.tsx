import { Suspense, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { useDebounce } from '@/hooks/use-debounce';
import { PageLoader } from '@/components/page-loader';
import { useInfiniteWeldstashProducts } from '@/hooks/queries/use-weldstash-queries';
import type { WeldstashProduct } from '@weldsuite/core-api-client/schemas/weldstash';
import { ProductsList } from './components/products-list';

function ProductsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';
  // The input stays bound to the URL value so typing feels immediate; only the
  // value that forms the infinite-query key is debounced, so a search costs one
  // request per pause instead of one per keystroke plus a cache entry each.
  const debouncedSearch = useDebounce(search, 300);
  const status = searchParams.get('status') || undefined;

  const setSearch = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set('search', value);
      else params.delete('search');
      const qs = params.toString();
      router.replace(`/weldstash/products${qs ? `?${qs}` : ''}`);
    },
    [router, searchParams],
  );

  const filters = useMemo(() => {
    const f: { limit: number; search?: string; status?: string } = { limit: 50 };
    if (debouncedSearch) f.search = debouncedSearch;
    if (status) f.status = status;
    return f;
  }, [debouncedSearch, status]);

  const {
    data: infiniteData,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteWeldstashProducts(filters);

  const rows = useMemo<WeldstashProduct[]>(
    () => infiniteData?.pages.flatMap((p) => p.data ?? []) ?? [],
    [infiniteData],
  );

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <ProductsList
      products={rows}
      isLoading={isLoading}
      search={search}
      onSearchChange={setSearch}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function WeldStashProductsPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <ProductsPageContent />
    </Suspense>
  );
}
