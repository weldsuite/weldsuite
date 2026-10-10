
import { Suspense, useMemo, useCallback } from 'react';
import { useSearchParams } from '@/lib/router';
import { PeopleGrid } from './components/people-grid';
import { useInfinitePeople } from '@/hooks/queries/use-people-queries';
import { usePersistedGridSort } from '@/components/entity-grid/use-persisted-grid-sort';
import { useGridViewSettings } from '@/hooks/queries/use-settings-queries';
import { EntityGridSkeleton } from '@/components/entity-grid/components/grid-skeleton';
import { ListLoadError } from '@/app/weldcrm/components/list-load-error';
import type { Person, ListPeopleQuery } from '@weldsuite/core-api-client/schemas/people';

function PeoplePageContent() {
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || undefined;
  const status = searchParams.get('status') || undefined;
  const filter = searchParams.get('filter');
  const companyId = searchParams.get('companyId') || undefined;
  // The sort in the URL, else the one the user last picked on this table.
  const { sort, sortDir } = usePersistedGridSort('person');

  const filters: Omit<ListPeopleQuery, 'cursor'> = useMemo(() => {
    // Only real CRM members — mail/helpdesk auto-create identities with
    // inCrm=false; they surface here once a user clicks "Add to CRM".
    const f: Omit<ListPeopleQuery, 'cursor'> = { limit: 50, inCrm: true };
    if (search) f.search = search;
    if (status) f.status = status;
    if (companyId) f.companyId = companyId;
    if (filter === 'suppliers') f.isSupplier = true;
    else if (filter === 'leads') f.isLead = true;
    if (sort) {
      f.sort = sort;
      if (sortDir) f.sortDir = sortDir;
    }
    return f;
  }, [search, status, filter, companyId, sort, sortDir]);

  // The grid reads the saved column view once it mounts, which is only after
  // the rows are in. Start that request now so the two do not run back to back.
  useGridViewSettings('person');

  const {
    data: infiniteData,
    isPending,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfinitePeople(filters);

  const rows = useMemo<Person[]>(
    () => infiniteData?.pages.flatMap((p) => p.data ?? []) ?? [],
    [infiniteData],
  );
  const totalCount = infiniteData?.pages[0]?.pagination?.totalCount ?? 0;

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // `isPending` (no result yet), not `isLoading`: while the persisted query
  // cache is still restoring after a reload the query is idle, so `isLoading`
  // is false with no data and the grid flashed its "No people yet" state.
  if (isPending) return <EntityGridSkeleton />;
  if (isError && !infiniteData) return <ListLoadError onRetry={() => void refetch()} />;

  return (
    <PeopleGrid
      people={rows}
      totalCount={totalCount}
      searchParams={{ search, status, filter: filter ?? undefined, companyId, sort, sortDir }}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function PeoplePage() {
  return (
    <Suspense fallback={<EntityGridSkeleton />}>
      <PeoplePageContent />
    </Suspense>
  );
}
