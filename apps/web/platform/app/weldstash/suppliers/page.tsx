import { Suspense, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import {
  useInfiniteWeldstashSuppliers,
  type WmsSupplier,
} from '@/hooks/queries/use-weldstash-queries';
import { SuppliersList } from './components/suppliers-list';

function SuppliersPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';
  const status = searchParams.get('status') || undefined;

  const setSearch = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set('search', value);
      else params.delete('search');
      const qs = params.toString();
      router.replace(`/weldstash/suppliers${qs ? `?${qs}` : ''}`);
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
  } = useInfiniteWeldstashSuppliers(filters);

  const rows = useMemo<WmsSupplier[]>(
    () => infiniteData?.pages.flatMap((p) => p.data ?? []) ?? [],
    [infiniteData],
  );

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <SuppliersList
      suppliers={rows}
      isLoading={isLoading}
      search={search}
      onSearchChange={setSearch}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function WeldStashSuppliersPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <SuppliersPageContent />
    </Suspense>
  );
}
