import { Suspense, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { useDebounce } from '@/hooks/use-debounce';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useInfiniteWeldstashProducts } from '@/hooks/queries/use-weldstash-queries';
import type { CommerceProduct } from '@/hooks/queries/use-commerce-queries';
import { ProductsList } from './components/products-list';

function ProductsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';
  // The input follows the URL so typing feels immediate; only the query key
  // is debounced, so a search costs one request per pause.
  const debouncedSearch = useDebounce(search, 300);
  const status = searchParams.get('status') || undefined;

  // Search lives in the URL so it survives reloads and can be shared.
  const setSearch = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set('search', value);
      else params.delete('search');
      const qs = params.toString();
      const query = qs ? `?${qs}` : '';
      router.replace(`/weldcommerce/products${query}`);
    },
    [router, searchParams],
  );

  const filters = useMemo(() => {
    const f: { limit: number; search?: string; status?: string } = { limit: 50 };
    if (debouncedSearch) f.search = debouncedSearch;
    if (status) f.status = status;
    return f;
  }, [debouncedSearch, status]);

  // The same `/products` rows (and cache) as WeldStash's list.
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteWeldstashProducts(filters);

  const rows = useMemo<CommerceProduct[]>(() => data?.pages.flatMap((p) => p.data ?? []) ?? [], [data]);

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
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

export default function CommerceProductsPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <ProductsPageContent />
    </Suspense>
  );
}
