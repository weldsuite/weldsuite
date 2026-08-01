import { Suspense, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useInfiniteCommerceProducts, type CommerceProduct } from '@/hooks/queries/use-commerce-queries';
import { ProductsList } from './components/products-list';

function ProductsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';
  const status = searchParams.get('status') || undefined;

  // Search lives in the URL so it survives reloads and is shareable, matching
  // the other list screens.
  const setSearch = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set('search', value);
      else params.delete('search');
      const qs = params.toString();
      router.replace(`/weldcommerce/products${qs ? `?${qs}` : ''}`);
    },
    [router, searchParams],
  );

  const filters = useMemo(() => {
    const f: { limit: number; search?: string; status?: string } = { limit: 50 };
    if (search) f.search = search;
    if (status) f.status = status;
    return f;
  }, [search, status]);

  const {
    data: infiniteData,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteCommerceProducts(filters);

  const rows = useMemo<CommerceProduct[]>(
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

export default function CommerceProductsPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <ProductsPageContent />
    </Suspense>
  );
}
