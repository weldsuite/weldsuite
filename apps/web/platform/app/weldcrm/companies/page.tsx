
import { Suspense, useMemo, useCallback } from 'react';
import { useSearchParams } from '@/lib/router';
import { CompaniesGrid } from './components/companies-grid';
import { useInfiniteCompanies } from '@/hooks/queries/use-companies-queries';
import { PageLoader } from '@/components/page-loader';
import type { Company, ListCompaniesQuery } from '@weldsuite/app-api-client/schemas/companies';

function CompaniesPageContent() {
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || undefined;
  const status = searchParams.get('status') || undefined;
  const filter = searchParams.get('filter');

  const filters: Omit<ListCompaniesQuery, 'cursor'> = useMemo(() => {
    const f: Omit<ListCompaniesQuery, 'cursor'> = { limit: 50 };
    if (search) f.search = search;
    if (status) f.status = status;
    if (filter === 'suppliers') f.isSupplier = true;
    else if (filter === 'leads') f.isLead = true;
    return f;
  }, [search, status, filter]);

  const {
    data: infiniteData,
    isLoading,
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

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <CompaniesGrid
      companies={rows}
      totalCount={totalCount}
      searchParams={{ search, status, filter: filter ?? undefined }}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function CompaniesPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <CompaniesPageContent />
    </Suspense>
  );
}
