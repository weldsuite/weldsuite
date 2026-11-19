/**
 * All items: every plan, not only those to reorder, so people can sort by days
 * of cover and spot overstock (more than 180 days). Sorting is on the loaded
 * rows; the tab loads every page (up to `MAX_ITEMS`) so the sort is complete.
 */

import { useEffect, useMemo, useState } from 'react';
import { PackageSearch, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { InlineSpinner, PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Button } from '@weldsuite/ui/components/button';
import { useDebounce } from '@/hooks/use-debounce';
import { getLocale, getTranslations } from '@/lib/i18n';
import { useInfinitePlans, useRestorePlan } from '@/hooks/queries/use-replenishment-queries';
import { formatDate, formatMoney, formatNumber, toNumberOrNull } from '../../lib/numbers';
import { OdooManagedBadge } from '../../components/odoo-managed-badge';
import { isOverstock } from '../lib/reorder';
import { EMPTY_PLAN_FILTERS, PlanFilters, planFilterQuery, type PlanFilterState } from './plan-filters';

const MAX_ITEMS = 2000;
const PAGE = 200;

export type PlanSort = 'runsOut' | 'cover' | 'name' | 'suggested';

/** Sorts a copy of the plans. Missing numbers go last in either direction of interest. */
export function sortPlans(plans: readonly ReplenishmentPlan[], sort: PlanSort): ReplenishmentPlan[] {
  const copy = [...plans];
  const num = (v: string | number | null | undefined, missing: number) => toNumberOrNull(v) ?? missing;
  switch (sort) {
    case 'runsOut':
      return copy.sort((a, b) => (a.stockoutDate ?? '9999-12-31').localeCompare(b.stockoutDate ?? '9999-12-31') || (a.productName ?? '').localeCompare(b.productName ?? ''));
    case 'cover':
      // Most cover first: the overstock sits at the top.
      return copy.sort((a, b) => num(b.daysOfCover, -1) - num(a.daysOfCover, -1));
    case 'suggested':
      return copy.sort((a, b) => b.suggestedQty - a.suggestedQty);
    case 'name':
      return copy.sort((a, b) => (a.productName ?? '').localeCompare(b.productName ?? ''));
  }
}

export function AllItemsTab({ onOpenPlan, onOpenSettings }: Readonly<{ onOpenPlan: (planId: string) => void; onOpenSettings: () => void }>) {
  const t = getTranslations('weldstashReplenishment').items;
  const locale = getLocale();
  const { can } = usePermissions();
  const [filters, setFilters] = useState<PlanFilterState>(EMPTY_PLAN_FILTERS);
  const [sort, setSort] = useState<PlanSort>('runsOut');
  const search = useDebounce(filters.search, 300);
  const query = useMemo(() => ({ limit: PAGE, ...planFilterQuery(filters, search) }), [filters, search]);
  const plansQuery = useInfinitePlans(query);
  const restore = useRestorePlan();

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = plansQuery;
  const loaded = plansQuery.data?.pages.reduce((sum, page) => sum + (page.data?.length ?? 0), 0) ?? 0;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && loaded < MAX_ITEMS) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, loaded]);

  const plans = useMemo(() => plansQuery.data?.pages.flatMap((page) => page.data ?? []) ?? [], [plansQuery.data]);
  const sorted = useMemo(() => sortPlans(plans, sort), [plans, sort]);
  const lowConfidence = plans.filter((p) => p.confidence !== 'ok').length;

  const handleRestore = async (plan: ReplenishmentPlan) => {
    try {
      await restore.mutateAsync(plan.id);
      toast.success(t.toastRestored);
    } catch (err) {
      toast.error((err as Error).message || t.restoreFailed);
    }
  };

  const columns: ListTableColumn<ReplenishmentPlan>[] = [
    {
      id: 'product',
      header: t.columns.product,
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">
            {row.productName}
            {row.variantName && <span className="font-normal text-muted-foreground"> · {row.variantName}</span>}
          </span>
          {row.productSku && <span className="truncate text-xs text-muted-foreground">{row.productSku}</span>}
        </span>
      ),
    },
    {
      id: 'warehouse',
      header: t.columns.warehouse,
      width: 'w-[140px]',
      cell: (row) => (
        <span className="flex min-w-0 flex-col items-start gap-0.5">
          <span className="truncate">{row.warehouseName}</span>
          {row.warehouseManagedByConnectionId && <OdooManagedBadge />}
        </span>
      ),
    },
    { id: 'supplier', header: t.columns.supplier, width: 'w-[140px]', accessor: (row) => row.supplierName ?? '' },
    { id: 'available', header: t.columns.available, width: 'w-[80px]', align: 'right', accessor: (row) => row.onHand - row.allocated },
    { id: 'incoming', header: t.columns.incoming, width: 'w-[80px]', align: 'right', accessor: (row) => row.incoming },
    { id: 'perDay', header: t.columns.perDay, width: 'w-[70px]', align: 'right', accessor: (row) => formatNumber(row.avgDailyDemand, 1, locale) },
    {
      id: 'cover',
      header: t.columns.cover,
      width: 'w-[130px]',
      align: 'right',
      cell: (row) => (
        <span className="flex items-center justify-end gap-2">
          {isOverstock(row) && <SoftBadge tone="warning">{t.overstock}</SoftBadge>}
          <span className="tabular-nums">{formatNumber(row.daysOfCover, 0, locale)}</span>
        </span>
      ),
    },
    { id: 'runsOut', header: t.columns.runsOut, width: 'w-[110px]', accessor: (row) => formatDate(row.stockoutDate, locale) },
    { id: 'suggested', header: t.columns.suggested, width: 'w-[90px]', align: 'right', accessor: (row) => row.suggestedQty },
    {
      id: 'value',
      header: t.columns.value,
      width: 'w-[100px]',
      align: 'right',
      accessor: (row) => (row.suggestedValue ? formatMoney(row.suggestedValue, row.currency, locale) : ''),
    },
    {
      id: 'status',
      header: t.columns.status,
      width: 'w-[110px]',
      cell: (row) => (
        <SoftBadge tone={row.reviewStatus === 'open' ? 'warning' : row.reviewStatus === 'ordered' ? 'success' : 'neutral'}>
          {(t.statuses as Record<string, string>)[row.reviewStatus] ?? row.reviewStatus}
        </SoftBadge>
      ),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <PlanFilters state={filters} onChange={setFilters} showStatus />
        <Select value={sort} onValueChange={(value) => setSort(value as PlanSort)}>
          <SelectTrigger size="sm" className="w-auto min-w-[10rem]" aria-label={t.sortBy}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(['runsOut', 'cover', 'suggested', 'name'] as const).map((key) => (
              <SelectItem key={key} value={key}>
                {t.sort[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {plansQuery.isLoading && <PageLoader fullScreen={false} />}
        {plansQuery.isError && (
          <div className="p-6">
            <ErrorState message={(plansQuery.error as Error)?.message || t.loadError} onRetry={() => void plansQuery.refetch()} retryLabel={t.retry} />
          </div>
        )}
        {!plansQuery.isLoading && !plansQuery.isError && plans.length === 0 && (
          <div className="p-6">
            <EmptyState icon={PackageSearch} title={t.emptyTitle} description={t.emptyDescription} />
          </div>
        )}
        {plans.length > 0 && (
          <>
            {lowConfidence > 0 && (
              <div className="px-4 pt-3">
                <InfoBanner
                  variant="tip"
                  action={<Button size="sm" variant="outline" onClick={onOpenSettings}>{t.lowDataAction}</Button>}
                >
                  {t.lowData.replace('{count}', String(lowConfidence))}
                </InfoBanner>
              </div>
            )}
            <ListTable<ReplenishmentPlan>
              columns={columns}
              data={sorted}
              rowKey={(row) => row.id}
              onRowClick={(row) => onOpenPlan(row.id)}
              rowLabel={(row) => row.productName ?? row.id}
              dense
              actions={
                can('inventory:update')
                  ? [
                      {
                        id: 'restore',
                        label: t.restore,
                        icon: Undo2,
                        onClick: (row) => void handleRestore(row),
                        hidden: (row) => row.reviewStatus !== 'dismissed',
                      },
                    ]
                  : undefined
              }
            />
            {isFetchingNextPage && <InlineSpinner className="py-6" />}
          </>
        )}
      </div>
    </div>
  );
}
