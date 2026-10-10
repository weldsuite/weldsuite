
import { Suspense, useMemo, useCallback } from 'react';
import { useSearchParams } from '@/lib/router';
import { CompaniesGrid } from './components/companies-grid';
import { useInfiniteCompanies } from '@/hooks/queries/use-companies-queries';
import { usePersistedGridSort } from '@/components/entity-grid/use-persisted-grid-sort';
import { useGridViewSettings } from '@/hooks/queries/use-settings-queries';
import { EntityGridSkeleton } from '@/components/entity-grid/components/grid-skeleton';
import { ListLoadError } from '@/app/weldcrm/components/list-load-error';
import type { Company, ListCompaniesQuery } from '@weldsuite/app-api-client/schemas/companies';

function CompaniesPageContent() {
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || undefined;
  const status = searchParams.get('status') || undefined;
  const filter = searchParams.get('filter');
  // The sort in the URL, else the one the user last picked on this table.
  const { sort, sortDir } = usePersistedGridSort('company');

  const filters: Omit<ListCompaniesQuery, 'cursor'> = useMemo(() => {
    const f: Omit<ListCompaniesQuery, 'cursor'> = { limit: 50 };
    if (search) f.search = search;
    if (status) f.status = status;
    if (filter === 'suppliers') f.isSupplier = true;
    else if (filter === 'leads') f.isLead = true;
    if (sort) {
      f.sort = sort;
      if (sortDir) f.sortDir = sortDir;
    }
    return f;
  }, [search, status, filter, sort, sortDir]);

  // The grid reads the saved column view once it mounts, which is only after
  // the rows are in. Start that request now so the two do not run back to back.
  useGridViewSettings('company');

  const {
    data: infiniteData,
    isPending,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteCompanies(filters);

  const rows = useMemo<Company[]>(
    () => infiniteData?.pages.flatMap((p) => p.data ?? []) ?? [],
    [infiniteData],
  );
  const totalCount = infiniteData?.pages[0]?.pagination?.totalCount ?? 0;

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // `isPending` (no result yet), not `isLoading`: while the persisted query
  // cache is still restoring after a reload the query is idle, so `isLoading`
  // is false with no data and the grid flashed its "No companies yet" state.
  if (isPending) return <EntityGridSkeleton />;
  if (isError && !infiniteData) return <ListLoadError onRetry={() => void refetch()} />;

  return (
    <CompaniesGrid
      companies={rows}
      totalCount={totalCount}
      searchParams={{ search, status, filter: filter ?? undefined, sort, sortDir }}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function CompaniesPage() {
  return (
    <Suspense fallback={<EntityGridSkeleton />}>
      <CompaniesPageContent />
    </Suspense>
  );
}
