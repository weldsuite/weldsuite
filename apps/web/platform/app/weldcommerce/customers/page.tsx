/**
 * WeldCommerce customers — companies AND people.
 *
 * There is no commerce-specific customer table. The identity layer has two
 * objects (`companies` for organisations, `people` for individuals) and
 * "Customer" / "Supplier" / "Lead" are status flags on the row, not separate
 * object types. A customer can therefore be either, so this page reads both
 * surfaces and merges them — see `config/customer-row.ts`.
 *
 * Both are the same records WeldCRM shows; the row click opens the matching
 * existing object panel rather than a commerce-specific twin.
 */

import { Suspense, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { PageLoader } from '@/components/page-loader';
import { useInfiniteCompanies } from '@/hooks/queries/use-companies-queries';
import { useInfinitePeople } from '@/components/objects/person/use-person-data';
import type { Company } from '@weldsuite/app-api-client/schemas/companies';
import type { Person } from '@weldsuite/core-api-client/schemas/people';
import { mergeCustomerRows } from './config/customer-row';
import { CustomersList } from './components/customers-list';

function CustomersPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';

  const setSearch = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set('search', value);
      else params.delete('search');
      const qs = params.toString();
      router.replace(`/weldcommerce/customers${qs ? `?${qs}` : ''}`);
    },
    [router, searchParams],
  );

  const filters = useMemo(() => {
    const f: { limit: number; search?: string } = { limit: 25 };
    if (search) f.search = search;
    return f;
  }, [search]);

  const companiesQuery = useInfiniteCompanies(filters);
  const peopleQuery = useInfinitePeople(filters);

  const rows = useMemo(() => {
    const companies = (companiesQuery.data?.pages.flatMap((p) => p.data ?? []) ?? []) as Company[];
    const people = (peopleQuery.data?.pages.flatMap((p) => p.data ?? []) ?? []) as Person[];
    return mergeCustomerRows(companies, people);
  }, [companiesQuery.data, peopleQuery.data]);

  const isLoading = companiesQuery.isLoading || peopleQuery.isLoading;
  const hasMore = !!companiesQuery.hasNextPage || !!peopleQuery.hasNextPage;
  const isFetchingMore = companiesQuery.isFetchingNextPage || peopleQuery.isFetchingNextPage;

  // Two independent cursors — advance whichever side still has pages. Both can
  // advance in the same click; the merge re-sorts by name either way.
  const handleLoadMore = useCallback(() => {
    if (companiesQuery.hasNextPage && !companiesQuery.isFetchingNextPage) {
      companiesQuery.fetchNextPage();
    }
    if (peopleQuery.hasNextPage && !peopleQuery.isFetchingNextPage) {
      peopleQuery.fetchNextPage();
    }
  }, [companiesQuery, peopleQuery]);

  return (
    <CustomersList
      customers={rows}
      isLoading={isLoading}
      search={search}
      onSearchChange={setSearch}
      onLoadMore={handleLoadMore}
      hasMore={hasMore}
      isFetchingMore={isFetchingMore}
    />
  );
}

export default function CommerceCustomersPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <CustomersPageContent />
    </Suspense>
  );
}
