import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Calculator, SquareChartGantt } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowDate,
  RowNumberChip,
  RowText,
  RowTitle,
  StatusChip,
  type ChipTone,
} from '@/components/accounting/weldbooks-row-cells';
import { useDebounce } from '@/hooks/use-debounce';
import { useFixedAssets } from '@/hooks/queries/use-weldbooks-assets-queries';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';
import { useLoadMorePages } from '@/lib/weldbooks/use-load-more-pages';
import {
  ASSET_STATUSES,
  MACRS_CLASSES,
  type AssetStatus,
  type FixedAssetListItem,
} from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const PAGE_SIZE = 25;

const STATUS_TONE: Record<AssetStatus, ChipTone> = {
  active: 'green',
  fully_depreciated: 'blue',
  disposed: 'gray',
};

/** The fixed asset register: every asset with what it cost, what is posted and what it is worth on the books. */
export default function FixedAssetsPage() {
  const { t } = useI18n();
  const fa = t.weldbooksUs.assets.fixedAssets;
  const tl = fa.list;
  const common = t.weldbooksUs.assets.common;
  const navigate = useNavigate();
  // Each asset opens in the shared object panel (type 'fixed_asset'), the same
  // panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/fixed-assets');
  const { can } = usePermissions();
  const { code } = useCurrentJurisdiction();
  const isUs = isUsJurisdictionCode(code);
  const { formatMoney, formatDate } = useWeldbooksFormat();

  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const paging = useLoadMorePages<FixedAssetListItem, string | undefined>(undefined);
  const debouncedSearch = useDebounce(search.trim(), 300);

  const status = pillValue(activeFilters, 'status');
  const assetClass = pillValue(activeFilters, 'assetClass');
  const { data, isError, isPlaceholderData, refetch } = useFixedAssets({
    limit: PAGE_SIZE,
    status: ASSET_STATUSES.find((value) => value === status),
    assetClass: MACRS_CLASSES.find((value) => value === assetClass),
    search: debouncedSearch || undefined,
    cursor: paging.key,
  });
  const list = paging.view({
    rows: data?.data,
    nextKey: data?.pagination.hasMore ? (data.pagination.cursor ?? null) : null,
    isPlaceholder: isPlaceholderData,
    isError,
  });
  const assets = useMemo(
    () =>
      applyExclusions(list.items, activeFilters, {
        status: (asset) => asset.status,
        assetClass: (asset) => asset.assetClass,
      }),
    [list.items, activeFilters],
  );

  const openAsset = (id: string) => openPanel({ type: 'fixed_asset', id });

  const columns: ColumnDef<FixedAssetListItem>[] = [
    {
      id: 'name',
      header: tl.columns.name,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (asset) => (
        <>
          {asset.assetNumber ? <RowNumberChip>{asset.assetNumber}</RowNumberChip> : null}
          <RowTitle>{asset.name}</RowTitle>
        </>
      ),
    },
    ...(isUs
      ? [
          {
            id: 'class',
            header: tl.columns.class,
            width: 'w-[170px]',
            render: (asset: FixedAssetListItem) => (
              <RowText>
                {asset.assetClass ? ((fa.classes as Record<string, string>)[asset.assetClass] ?? asset.assetClass) : null}
              </RowText>
            ),
          },
        ]
      : []),
    {
      id: 'placedInService',
      header: tl.columns.placedInService,
      width: 'w-[120px]',
      render: (asset) => <RowDate>{formatDate(asset.placedInServiceDate)}</RowDate>,
    },
    {
      id: 'cost',
      header: tl.columns.cost,
      width: 'w-[130px]',
      render: (asset) => <RowAmount>{formatMoney(asset.cost)}</RowAmount>,
    },
    {
      id: 'accumulated',
      header: tl.columns.accumulated,
      width: 'w-[130px]',
      render: (asset) => <RowAmount>{formatMoney(asset.accumulatedPosted)}</RowAmount>,
    },
    {
      id: 'netBookValue',
      header: tl.columns.netBookValue,
      width: 'w-[130px]',
      render: (asset) => <RowAmount className="font-medium">{formatMoney(asset.netBookValuePosted)}</RowAmount>,
    },
    {
      id: 'status',
      header: tl.columns.status,
      width: 'w-[130px]',
      render: (asset) => (
        <StatusChip tone={STATUS_TONE[asset.status] ?? 'gray'}>{fa.statuses[asset.status] ?? asset.status}</StatusChip>
      ),
    },
  ];

  const filterConfigs: FilterConfig[] = [
    { field: 'status', label: tl.status, options: ASSET_STATUSES.map((value) => ({ value, label: fa.statuses[value] })) },
    ...(isUs
      ? [{ field: 'assetClass', label: tl.propertyClass, options: MACRS_CLASSES.map((value) => ({ value, label: fa.classes[value] })) }]
      : []),
  ];

  const actionButtons = (
    <>
      {isUs ? (
        <Button variant="outline" size="sm" className="h-8" asChild>
          <Link to="/weldbooks/fixed-assets/tax-depreciation">{tl.taxReport}</Link>
        </Button>
      ) : null}
      {can('journal:create') ? (
        <Button variant="outline" size="sm" className="h-8" asChild>
          <Link to="/weldbooks/fixed-assets/depreciation">
            <Calculator className="h-4 w-4" />
            <span className="hidden md:inline">{tl.runDepreciation}</span>
          </Link>
        </Button>
      ) : null}
    </>
  );

  const goToNew = () => void navigate({ to: '/weldbooks/fixed-assets/new' });
  const canAdd = can('accounts:create');

  return (
    <div>
      {isError && list.items.length === 0 ? (
        <Card className="m-4 sm:m-6">
          <CardContent className="space-y-3 py-10 text-center">
            <p className="text-sm text-destructive" role="alert">
              {tl.loadFailed}
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {common.retry}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <WeldbooksEntityList<FixedAssetListItem>
          items={assets}
          isLoading={list.isLoading}
          columns={columns}
          onRowClick={(asset) => openAsset(asset.id)}
          getRowLabel={(asset) => asset.name}
          filters={filterConfigs}
          activeFilters={activeFilters}
          onFiltersChange={(next) => {
            setActiveFilters(next);
            paging.reset();
          }}
          searchQuery={search}
          onSearchChange={(value) => {
            setSearch(value);
            paging.reset();
          }}
          searchFields={['name']}
          searchPlaceholder={tl.searchPlaceholder}
          hasMore={list.hasMore}
          isLoadingMore={list.isLoadingMore}
          onLoadMore={list.loadMore}
          actionButtons={actionButtons}
          createButton={canAdd ? { label: tl.add, onClick: goToNew } : undefined}
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <SquareChartGantt className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
              </EmptyStateIllustration>
            ),
            title: tl.emptyTitle,
            description: tl.emptyDescription,
            action: canAdd ? { label: tl.add, onClick: goToNew } : undefined,
          }}
          noResultsState={{ title: tl.emptyFiltered, description: '' }}
        />
      )}
    </div>
  );
}
