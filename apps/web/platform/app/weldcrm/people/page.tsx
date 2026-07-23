
import { Suspense, useMemo, useCallback } from 'react';
import { useSearchParams } from '@/lib/router';
import { PeopleGrid } from './components/people-grid';
import { useInfinitePeople } from '@/hooks/queries/use-people-queries';
import { PageLoader } from '@/components/page-loader';
import type { Person, ListPeopleQuery } from '@weldsuite/core-api-client/schemas/people';

function PeoplePageContent() {
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || undefined;
  const status = searchParams.get('status') || undefined;
  const filter = searchParams.get('filter');
  const companyId = searchParams.get('companyId') || undefined;

  const filters: Omit<ListPeopleQuery, 'cursor'> = useMemo(() => {
    // Only real CRM members — mail/helpdesk auto-create identities with
    // inCrm=false; they surface here once a user clicks "Add to CRM".
    const f: Omit<ListPeopleQuery, 'cursor'> = { limit: 50, inCrm: true };
    if (search) f.search = search;
    if (status) f.status = status;
    if (companyId) f.companyId = companyId;
    if (filter === 'suppliers') f.isSupplier = true;
    else if (filter === 'leads') f.isLead = true;
    return f;
  }, [search, status, filter, companyId]);

  const {
    data: infiniteData,
    isLoading,
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

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <PeopleGrid
      people={rows}
      totalCount={totalCount}
      searchParams={{ search, status, filter: filter ?? undefined, companyId }}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function PeoplePage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <PeoplePageContent />
    </Suspense>
  );
}
