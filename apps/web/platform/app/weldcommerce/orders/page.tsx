import { Suspense, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { useDebounce } from '@/hooks/use-debounce';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { useInfiniteCommerceOrders, type OrderListParams, type OrderSummary } from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { OrdersList } from './components/orders-list';
import type { OrderFilterKey, OrderFilterValues } from './components/order-filters';

const FILTER_KEYS: readonly OrderFilterKey[] = ['status', 'paymentStatus', 'fulfillmentStatus', 'source', 'from', 'to'];

function OrdersPageContent() {
  const t = getTranslations('commerce').orders;
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';
  // The input follows the URL so typing feels immediate; only the query is debounced.
  const debouncedSearch = useDebounce(search, 300);

  const filterValues = useMemo<OrderFilterValues>(() => {
    const values: OrderFilterValues = {};
    for (const key of FILTER_KEYS) {
      const value = searchParams.get(key);
      if (value) values[key] = value;
    }
    return values;
  }, [searchParams]);

  // Search and filters live in the URL, so they survive a reload and can be shared.
  const setParam = useCallback(
    (key: string, value: string | undefined) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      const qs = params.toString();
      const query = qs ? `?${qs}` : '';
      router.replace(`/weldcommerce/orders${query}`);
    },
    [router, searchParams],
  );

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of FILTER_KEYS) params.delete(key);
    const qs = params.toString();
    const query = qs ? `?${qs}` : '';
    router.replace(`/weldcommerce/orders${query}`);
  }, [router, searchParams]);

  const params = useMemo<OrderListParams>(() => {
    const p: OrderListParams = { limit: 50, ...filterValues };
    if (debouncedSearch) p.search = debouncedSearch;
    return p;
  }, [debouncedSearch, filterValues]);

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteCommerceOrders(params);
  const rows = useMemo<OrderSummary[]>(() => data?.pages.flatMap((p) => p.data ?? []) ?? [], [data]);

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (isError && rows.length === 0) {
    return (
      <div className="p-6">
        <ErrorState message={t.loadFailed} onRetry={() => void refetch()} />
      </div>
    );
  }

  return (
    <OrdersList
      orders={rows}
      isLoading={isLoading}
      search={search}
      onSearchChange={(value) => setParam('search', value || undefined)}
      filters={filterValues}
      onFilterChange={setParam}
      onClearFilters={clearFilters}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function CommerceOrdersPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <OrdersPageContent />
    </Suspense>
  );
}
