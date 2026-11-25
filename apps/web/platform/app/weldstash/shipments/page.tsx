/**
 * WeldStash > Shipments: every parcel that has a carrier label, with its
 * tracking status. Served by the Rust backend only (`stash-shipping`): the
 * route is gated in `lib/edition-routes.ts`, the sidebar entry and every query
 * check the feature too.
 */

import { Suspense, useCallback, useMemo } from 'react';
import { Truck } from 'lucide-react';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PARCEL_STATUSES, type Parcel } from '@weldsuite/app-api-client/schemas/shipping';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { PanelEntityList } from '@/components/panel-entity-list';
import { useInfiniteParcels } from '@/hooks/queries/use-shipping-queries';
import { useDebounce } from '@/hooks/use-debounce';
import { getTranslations } from '@/lib/i18n';
import { useRouter, useSearchParams } from '@/lib/router';
import { buildParcelColumns } from './config/parcel-columns';

function ShipmentsPageContent() {
  const t = getTranslations('weldstash').shipping;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { open: openObjectPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldstash/shipments');

  const search = searchParams.get('search') || '';
  const status = searchParams.get('status') || undefined;
  const serverSearch = useDebounce(search.trim(), 300);

  const setParam = useCallback(
    (key: 'search' | 'status', value: string | undefined) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      const qs = params.toString();
      router.replace(qs ? `/weldstash/shipments?${qs}` : '/weldstash/shipments');
    },
    [router, searchParams],
  );

  const filters = useMemo(
    () => ({ labelled: true, limit: 50, status, search: serverSearch || undefined }),
    [status, serverSearch],
  );
  const parcels = useInfiniteParcels(filters);
  const rows = useMemo<Parcel[]>(() => parcels.data?.pages.flatMap((page) => page.data ?? []) ?? [], [parcels.data]);
  const columns = useMemo(() => buildParcelColumns(), []);
  const statusOptions = PARCEL_STATUSES.map((value) => ({ value, label: t.statuses[value] }));

  return (
    <PanelEntityList<Parcel>
      items={rows}
      isLoading={parcels.isLoading}
      error={parcels.error as Error | null}
      columns={columns}
      onRowClick={(row) => openObjectPanel({ type: 'parcel', id: row.id })}
      objectPanel={{ type: 'parcel' }}
      searchQuery={search}
      onSearchChange={(value) => setParam('search', value)}
      searchPlaceholder={t.shipments.searchPlaceholder}
      hideFilter
      leftActionButtons={
        <FilterSelect
          value={status}
          onChange={(value) => setParam('status', value)}
          options={statusOptions}
          allLabel={t.shipments.allStatuses}
          ariaLabel={t.shipments.statusFilter}
        />
      }
      hasMore={!!parcels.hasNextPage}
      isLoadingMore={parcels.isFetchingNextPage}
      onLoadMore={() => {
        if (parcels.hasNextPage && !parcels.isFetchingNextPage) void parcels.fetchNextPage();
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Truck className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: t.shipments.empty,
        description: t.shipments.emptyDescription,
      }}
    />
  );
}

export default function WeldStashShipmentsPage() {
  return (
    <Suspense fallback={<PageLoader fullScreen={false} />}>
      <ShipmentsPageContent />
    </Suspense>
  );
}
