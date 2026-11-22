/**
 * Reorder: the plans that need a purchase, grouped by supplier. The suggested
 * quantity is editable per row; selected rows become draft purchase orders.
 */

import { useMemo, useState } from 'react';
import { BellOff, PackageSearch, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import type { ReplenishmentPlan } from '@weldsuite/app-api-client/schemas/replenishment';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { ListTable, type ListTableColumn, type ListTableGroup } from '@weldsuite/ui/components/list-table';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useDebounce } from '@/hooks/use-debounce';
import { getLocale, getTranslations } from '@/lib/i18n';
import { plural } from '@/lib/i18n/plural';
import { useDismissPlan, useInfinitePlans } from '@/hooks/queries/use-replenishment-queries';
import { useWeldstashSuppliers } from '@/hooks/queries/use-weldstash-queries';
import { formatDate, formatMoney, formatNumber } from '../../lib/numbers';
import { OdooManagedBadge } from '../../components/odoo-managed-badge';
import { addDays, effectiveQuantity, groupBySupplier, lineValue, quantityHint, todayUtc, urgencyOf } from '../lib/reorder';
import { CreateOrdersDialog } from './create-orders-dialog';
import { EMPTY_PLAN_FILTERS, PlanFilters, planFilterQuery, type PlanFilterState } from './plan-filters';

const SNOOZE_DAYS = [7, 30] as const;

interface ReorderTabProps {
  /** Opens the item panel for a plan. */
  onOpenPlan: (planId: string) => void;
  /** Switches to the Settings tab (the CSV import lives there). */
  onOpenSettings: () => void;
}

export function ReorderTab({ onOpenPlan, onOpenSettings }: Readonly<ReorderTabProps>) {
  const t = getTranslations('weldstashReplenishment').reorder;
  const locale = getLocale();
  const { can } = usePermissions();
  const [filters, setFilters] = useState<PlanFilterState>(EMPTY_PLAN_FILTERS);
  const search = useDebounce(filters.search, 300);
  const query = useMemo(() => ({ needsReorder: true, limit: 200, ...planFilterQuery(filters, search) }), [filters, search]);
  const plansQuery = useInfinitePlans(query);
  const dismiss = useDismissPlan();
  const suppliers = useWeldstashSuppliers({ limit: 100 });

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [dialogOpen, setDialogOpen] = useState(false);

  const plans = useMemo(() => plansQuery.data?.pages.flatMap((page) => page.data ?? []) ?? [], [plansQuery.data]);
  const today = todayUtc();
  const supplierRows = suppliers.data?.data;
  const minimumOrderValues = useMemo(
    () => Object.fromEntries((supplierRows ?? []).map((s) => [s.id, s.minimumOrderValue])),
    [supplierRows],
  );
  const selectedPlans = plans.filter((p) => selected.has(p.id));
  const hasFilters = Object.keys(planFilterQuery(filters, search)).length > 0;
  const canOrder = can('purchase_orders:create');
  const canDismiss = can('inventory:update');

  const toggle = (ids: readonly string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const groups: ListTableGroup<ReplenishmentPlan>[] = groupBySupplier(plans).map((group, index) => {
    const ids = group.plans.map((p) => p.id);
    const allSelected = ids.every((id) => selected.has(id));
    const value = group.plans.reduce((sum, p) => sum + lineValue(p, effectiveQuantity(p, edits)), 0);
    return {
      id: group.supplierId ?? 'none',
      sortOrder: index,
      filter: (row) => (row.supplierId ?? null) === group.supplierId,
      label: (
        <span className="flex items-center gap-3">
          {canOrder && group.supplierId && (
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) => toggle(ids, checked === true)}
              aria-label={t.selectGroup.replace('{supplier}', group.supplierName ?? '')}
            />
          )}
          <span className="font-medium">{group.supplierName ?? t.noSupplier}</span>
          {group.supplierId ? (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {formatMoney(value, group.plans[0]?.currency, locale)}
            </span>
          ) : (
            <span className="text-xs font-normal text-muted-foreground">{t.noSupplierHint}</span>
          )}
        </span>
      ),
      renderCount: (count) => <span className="text-xs text-muted-foreground">{plural(count, t.items, getLocale())}</span>,
    };
  });

  const columns: ListTableColumn<ReplenishmentPlan>[] = [
    ...(canOrder
      ? [
          {
            id: 'select',
            header: '',
            width: 'w-[36px]',
            cell: (row: ReplenishmentPlan) => (
              <Checkbox
                checked={selected.has(row.id)}
                disabled={!row.supplierId}
                onCheckedChange={(checked) => toggle([row.id], checked === true)}
                aria-label={t.selectRow.replace('{product}', row.productName ?? '')}
              />
            ),
          } satisfies ListTableColumn<ReplenishmentPlan>,
        ]
      : []),
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
    { id: 'available', header: t.columns.available, width: 'w-[80px]', align: 'right', accessor: (row) => row.onHand - row.allocated },
    { id: 'incoming', header: t.columns.incoming, width: 'w-[80px]', align: 'right', accessor: (row) => row.incoming },
    { id: 'perDay', header: t.columns.perDay, width: 'w-[70px]', align: 'right', accessor: (row) => formatNumber(row.avgDailyDemand, 1, locale) },
    { id: 'cover', header: t.columns.cover, width: 'w-[80px]', align: 'right', accessor: (row) => formatNumber(row.daysOfCover, 0, locale) },
    {
      id: 'runsOut',
      header: t.columns.runsOut,
      width: 'w-[130px]',
      cell: (row) => {
        const urgency = urgencyOf(row, today);
        return (
          <span className="flex items-center gap-2">
            <span className="tabular-nums">{formatDate(row.stockoutDate, locale)}</span>
            {urgency && (
              <SoftBadge tone={urgency === 'review' ? 'warning' : 'danger'}>{t.urgency[urgency]}</SoftBadge>
            )}
          </span>
        );
      },
    },
    { id: 'reorderPoint', header: t.columns.reorderPoint, width: 'w-[80px]', align: 'right', accessor: (row) => row.reorderPoint ?? '' },
    {
      id: 'suggested',
      header: t.columns.suggested,
      width: 'w-[110px]',
      align: 'right',
      cell: (row) => {
        const quantity = effectiveQuantity(row, edits);
        const hint = quantityHint(row, quantity);
        return (
          <span className="flex flex-col items-end gap-0.5">
            <Input
              type="number"
              min="0"
              step="1"
              className="h-7 w-20 text-right tabular-nums"
              aria-label={t.quantityFor.replace('{product}', row.productName ?? '')}
              value={quantity}
              disabled={!canOrder}
              onChange={(e) => {
                const value = e.target.value === '' ? 0 : Math.max(0, Math.floor(Number(e.target.value)));
                setEdits((current) => ({ ...current, [row.id]: Number.isFinite(value) ? value : 0 }));
              }}
            />
            {hint && (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">
                {hint === 'below_minimum' ? t.hintMinimum.replace('{count}', String(row.minOrderQty)) : t.hintMultiple.replace('{count}', String(row.orderMultiple))}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: 'unitCost',
      header: t.columns.unitCost,
      width: 'w-[90px]',
      align: 'right',
      accessor: (row) => (row.unitCost ? formatMoney(row.unitCost, row.currency, locale) : ''),
    },
    {
      id: 'value',
      header: t.columns.value,
      width: 'w-[100px]',
      align: 'right',
      cell: (row) => (
        <span className="tabular-nums">{row.unitCost ? formatMoney(lineValue(row, effectiveQuantity(row, edits)), row.currency, locale) : ''}</span>
      ),
    },
  ];

  const snooze = async (plan: ReplenishmentPlan, days: number) => {
    try {
      await dismiss.mutateAsync({ id: plan.id, data: { until: addDays(todayUtc(), days) + 'T00:00:00.000Z' } });
      toast.success(t.toastSnoozed.replace('{days}', String(days)));
      toggle([plan.id], false);
    } catch (err) {
      toast.error((err as Error).message || t.snoozeFailed);
    }
  };

  const valueOfSelection = selectedPlans.reduce((sum, p) => sum + lineValue(p, effectiveQuantity(p, edits)), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <PlanFilters state={filters} onChange={setFilters} />
        {canOrder && (
          <div className="flex items-center gap-3">
            {selectedPlans.length > 0 && (
              <span className="text-sm text-muted-foreground tabular-nums">
                {plural(selectedPlans.length, t.selected, getLocale()).replace(
                  '{value}',
                  formatMoney(valueOfSelection, selectedPlans[0]?.currency, locale),
                )}
              </span>
            )}
            <Button size="sm" disabled={selectedPlans.length === 0} onClick={() => setDialogOpen(true)}>
              <ShoppingCart className="mr-1 size-4" />
              {t.createOrders}
            </Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {plansQuery.isLoading && <PageLoader fullScreen={false} />}
        {plansQuery.isError && (
          <div className="p-6">
            <ErrorState
              message={(plansQuery.error as Error)?.message || t.loadError}
              onRetry={() => void plansQuery.refetch()}
              retryLabel={t.retry}
            />
          </div>
        )}
        {!plansQuery.isLoading && !plansQuery.isError && plans.length === 0 && (
          <div className="p-6">
            <EmptyState
              icon={hasFilters ? PackageSearch : BellOff}
              title={hasFilters ? t.noMatchTitle : t.emptyTitle}
              description={hasFilters ? t.noMatchDescription : t.emptyDescription}
              action={
                hasFilters ? undefined : (
                  <Button variant="outline" size="sm" onClick={onOpenSettings}>
                    {t.emptyAction}
                  </Button>
                )
              }
            />
          </div>
        )}
        {plans.length > 0 && (
          <>
            {plans.some((p) => p.confidence !== 'ok') && (
              <div className="px-4 pt-3">
                <InfoBanner variant="tip" action={<Button size="sm" variant="outline" onClick={onOpenSettings}>{t.lowDataAction}</Button>}>
                  {t.lowData}
                </InfoBanner>
              </div>
            )}
            <ListTable<ReplenishmentPlan>
              columns={columns}
              data={plans}
              rowKey={(row) => row.id}
              onRowClick={(row) => onOpenPlan(row.id)}
              rowLabel={(row) => row.productName ?? row.id}
              groups={groups}
              dense
              actions={
                canDismiss
                  ? SNOOZE_DAYS.map((days) => ({
                      id: `snooze-${days}`,
                      label: t.snooze.replace('{days}', String(days)),
                      onClick: (row: ReplenishmentPlan) => void snooze(row, days),
                    }))
                  : undefined
              }
            />
            {plansQuery.hasNextPage && (
              <div className="flex justify-center p-4">
                <Button variant="outline" size="sm" disabled={plansQuery.isFetchingNextPage} onClick={() => void plansQuery.fetchNextPage()}>
                  {t.loadMore}
                </Button>
              </div>
            )}
            <p className="px-4 pb-4 text-xs text-muted-foreground">{t.footnote}</p>
          </>
        )}
      </div>

      {dialogOpen && (
        <CreateOrdersDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          plans={selectedPlans}
          edits={edits}
          minimumOrderValues={minimumOrderValues}
          onCreated={() => {
            setSelected(new Set());
            setEdits({});
          }}
        />
      )}
    </div>
  );
}
