import { Suspense, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useInfiniteWeldstashPickLists, type WeldstashPickList } from '@/hooks/queries/use-weldstash-queries';
import { PickListsList } from './components/pick-lists-list';

function PickListsPageContent() {
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
      router.replace(`/weldstash/pick-lists${qs ? `?${qs}` : ''}`);
    },
    [router, searchParams],
  );

  const filters = useMemo(() => {
    const f: { limit: number; status?: string } = { limit: 50 };
    if (status) f.status = status;
    return f;
  }, [status]);

  const {
    data: infiniteData,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteWeldstashPickLists(filters);

  const rows = useMemo<WeldstashPickList[]>(
    () => infiniteData?.pages.flatMap((p) => p.data ?? []) ?? [],
    [infiniteData],
  );

  return (
    <PickListsList
      pickLists={rows}
      isLoading={isLoading}
      search={search}
      onSearchChange={setSearch}
      onLoadMore={() => {
        if (hasNextPage && !isFetchingNextPage) fetchNextPage();
      }}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function WeldStashPickListsPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <PickListsPageContent />
    </Suspense>
  );
}
