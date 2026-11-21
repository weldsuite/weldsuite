import { Package, ClipboardList, Truck, Wallet } from 'lucide-react';
import { KpiGrid, KpiCard } from '@weldsuite/ui/components/kpi-card';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { ListTable, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { formatPanelDate, formatPanelMoney } from '@/components/objects/_shared/simple-object-panel';
import { useCommerceOverview, type CommerceRecentOrder } from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { fill } from './lib/text';

function statusTone(status: string | null): SoftTone {
  switch (status) {
    case 'completed':
    case 'paid':
    case 'fulfilled':
      return 'success';
    case 'cancelled':
    case 'canceled':
    case 'failed':
    case 'refunded':
      return 'danger';
    case 'pending':
    case 'on_hold':
    case 'unfulfilled':
    case 'partial':
    case 'picking':
      return 'warning';
    default:
      return 'neutral';
  }
}

function StatusBadge({ value }: Readonly<{ value: string | null }>) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <SoftBadge tone={statusTone(value)}>{value.replace(/_/g, ' ')}</SoftBadge>;
}

/**
 * The WeldCommerce overview (phase 0 of the rebuild): catalogue and order
 * counts, revenue of the last 30 days per currency, and the newest orders.
 * Each section shows only when the member may read it.
 */
export default function WeldCommerceOverview() {
  const t = getTranslations('commerce').overview;
  const { data, isLoading, error, refetch } = useCommerceOverview();
  const overview = data?.data;

  if (error) {
    return (
      <div className="container mx-auto max-w-[1600px] p-6">
        <ErrorState message={t.loadFailed} onRetry={() => void refetch()} />
      </div>
    );
  }

  const columns: ListTableColumn<CommerceRecentOrder>[] = [
    { id: 'order', header: t.columns.order, accessor: (row) => row.orderNumber ?? row.id },
    { id: 'customer', header: t.columns.customer, accessor: (row) => row.customerName ?? '—' },
    { id: 'status', header: t.columns.status, cell: (row) => <StatusBadge value={row.status} /> },
    { id: 'payment', header: t.columns.payment, cell: (row) => <StatusBadge value={row.paymentStatus} /> },
    { id: 'fulfilment', header: t.columns.fulfilment, cell: (row) => <StatusBadge value={row.fulfillmentStatus} /> },
    {
      id: 'total',
      header: t.columns.total,
      align: 'right',
      accessor: (row) => formatPanelMoney(row.total, row.currency ?? 'EUR') ?? '—',
    },
    { id: 'date', header: t.columns.date, accessor: (row) => formatPanelDate(row.createdAt) ?? '—' },
  ];

  return (
    <div className="container mx-auto max-w-[1600px] p-6 space-y-6">
      <KpiGrid>
        {(isLoading || overview?.products) && (
          <KpiCard
            label={t.products}
            value={overview?.products?.total ?? '—'}
            hint={
              overview?.products
                ? fill(t.productsHint, { active: overview.products.active, draft: overview.products.draft })
                : undefined
            }
            icon={Package}
            loading={isLoading}
          />
        )}
        {(isLoading || overview?.orders) && (
          <>
            <KpiCard label={t.openOrders} value={overview?.orders?.open ?? '—'} icon={ClipboardList} loading={isLoading} />
            <KpiCard
              label={t.awaitingFulfilment}
              value={overview?.orders?.awaitingFulfilment ?? '—'}
              icon={Truck}
              loading={isLoading}
            />
            <KpiCard
              label={t.unpaid}
              value={overview?.orders?.unpaid ?? '—'}
              icon={Wallet}
              tone={(overview?.orders?.unpaid ?? 0) > 0 ? 'warning' : 'default'}
              loading={isLoading}
            />
          </>
        )}
      </KpiGrid>

      {overview?.revenueLast30Days && (
        <SectionCard title={t.revenueTitle} description={t.revenueDescription}>
          {overview.revenueLast30Days.length === 0 ? (
            <EmptyText>{t.revenueEmpty}</EmptyText>
          ) : (
            <ul className="divide-y">
              {overview.revenueLast30Days.map((row) => (
                <li key={row.currency} className="flex items-center justify-between py-2">
                  <span className="font-medium tabular-nums">{formatPanelMoney(row.revenue, row.currency)}</span>
                  <span className="text-sm text-muted-foreground">{fill(t.revenueOrders, { count: row.orders })}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {overview?.recentOrders && (
        <SectionCard title={t.recentTitle}>
          <ListTable
            columns={columns}
            data={overview.recentOrders}
            rowKey={(row) => row.id}
            emptyMessage={t.recentEmpty}
            dense
          />
        </SectionCard>
      )}

      <InfoBanner variant="info">{t.comingSoon}</InfoBanner>
    </div>
  );
}
