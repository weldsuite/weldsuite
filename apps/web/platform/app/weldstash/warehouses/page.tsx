import { Suspense, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useInfiniteWeldstashWarehouses } from '@/hooks/queries/use-weldstash-queries';
import type { WeldstashWarehouse } from '@weldsuite/core-api-client/schemas/weldstash';
import { WarehousesList } from './components/warehouses-list';

function WarehousesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';

  const setSearch = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set('search', value);
      else params.delete('search');
      const qs = params.toString();
      router.replace(`/weldstash/warehouses${qs ? `?${qs}` : ''}`);
    },
    [router, searchParams],
  );

  const filters = useMemo(() => {
    const f: { limit: number; search?: string } = { limit: 50 };
    if (search) f.search = search;
    return f;
  }, [search]);

  const {
    data: infiniteData,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteWeldstashWarehouses(filters);

  const rows = useMemo<WeldstashWarehouse[]>(
    () => infiniteData?.pages.flatMap((p) => p.data ?? []) ?? [],
    [infiniteData],
  );

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <WarehousesList
      warehouses={rows}
      isLoading={isLoading}
      search={search}
      onSearchChange={setSearch}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function WeldStashWarehousesPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <WarehousesPageContent />
    </Suspense>
  );
}
