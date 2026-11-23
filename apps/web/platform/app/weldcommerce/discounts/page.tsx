import { Suspense, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from '@/lib/router';
import { useDebounce } from '@/hooks/use-debounce';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import {
  useInfiniteCommerceDiscounts,
  type CommerceDiscount,
  type DiscountListParams,
} from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';
import { DiscountsList } from './components/discounts-list';

function DiscountsPageContent() {
  const t = getTranslations('commerce').discounts;
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.get('search') || '';
  const debouncedSearch = useDebounce(search, 300);
  const effectiveStatus = searchParams.get('effectiveStatus') || undefined;

  // Search and the status filter live in the URL, so they survive a reload and can be shared.
  const setParam = useCallback(
    (key: string, value: string | undefined) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      const qs = params.toString();
      const query = qs ? `?${qs}` : '';
      router.replace(`/weldcommerce/discounts${query}`);
    },
    [router, searchParams],
  );

  const params = useMemo<DiscountListParams>(() => {
    const p: DiscountListParams = { limit: 50 };
    if (debouncedSearch) p.search = debouncedSearch;
    if (effectiveStatus) p.effectiveStatus = effectiveStatus;
    return p;
  }, [debouncedSearch, effectiveStatus]);

  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteCommerceDiscounts(params);
  const rows = useMemo<CommerceDiscount[]>(() => data?.pages.flatMap((p) => p.data ?? []) ?? [], [data]);

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
    <DiscountsList
      discounts={rows}
      isLoading={isLoading}
      search={search}
      onSearchChange={(value) => setParam('search', value || undefined)}
      effectiveStatus={effectiveStatus}
      onEffectiveStatusChange={(value) => setParam('effectiveStatus', value)}
      onLoadMore={handleLoadMore}
      hasMore={!!hasNextPage}
      isFetchingMore={isFetchingNextPage}
    />
  );
}

export default function CommerceDiscountsPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <DiscountsPageContent />
    </Suspense>
  );
}
