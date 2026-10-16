import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ReceiptText } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { RowAmount, RowChip, RowText, RowTitle } from '@/components/accounting/weldbooks-row-cells';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';
import { useLoadMorePages } from '@/lib/weldbooks/use-load-more-pages';
import { useBankAccounts } from '@/hooks/queries/use-weldbooks-banking-queries';
import { usePaymentRuns } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import { RUN_METHODS, RUN_STATUSES, type PaymentRunSummary } from '@/lib/api/domains/weldbooks-payment-runs';
import { PaymentRunsFrame } from './components/payment-runs-frame';
import { RunMethodChip, RunStatusChip } from './components/run-badges';

const PAGE_SIZE = 25;

export default function PaymentRunsPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tl = tp.list;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { formatMoney, formatDate } = useWeldbooksFormat();

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const paging = useLoadMorePages<PaymentRunSummary, string | undefined>(undefined);

  const { data: accountsRes } = useBankAccounts();
  const accounts = useMemo(() => accountsRes?.data ?? [], [accountsRes]);

  const status = pillValue(activeFilters, 'status');
  const method = pillValue(activeFilters, 'method');
  const query = usePaymentRuns({
    limit: PAGE_SIZE,
    status: RUN_STATUSES.find((s) => s === status),
    method: RUN_METHODS.find((m) => m === method),
    bankAccountId: pillValue(activeFilters, 'bankAccountId'),
    cursor: paging.key,
  });
  const list = paging.view({
    rows: query.data?.data,
    nextKey: query.data?.pagination.hasMore ? (query.data.pagination.cursor ?? null) : null,
    isPlaceholder: query.isPlaceholderData,
    isError: query.isError,
  });
  const runs = useMemo(
    () =>
      applyExclusions(list.items, activeFilters, {
        status: (run) => run.status,
        method: (run) => run.method,
        bankAccountId: (run) => run.bankAccountId,
      }),
    [list.items, activeFilters],
  );

  const canCreate = can('banking:create');
  const newRun = () => navigate({ to: '/weldbooks/payment-runs/new' });

  const filterConfigs: FilterConfig[] = [
    { field: 'status', label: tl.columns.status, options: RUN_STATUSES.map((s) => ({ value: s, label: tp.statuses[s] })) },
    { field: 'method', label: tl.columns.method, options: RUN_METHODS.map((m) => ({ value: m, label: tp.methods[m] })) },
    { field: 'bankAccountId', label: tl.columns.bankAccount, options: accounts.map((a) => ({ value: a.id, label: a.name })) },
  ];

  const columns: ColumnDef<PaymentRunSummary>[] = [
    {
      id: 'paymentDate',
      header: tl.columns.paymentDate,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (run) => (
        <RowTitle
          chips={
            <>
              <RunMethodChip method={run.method} />
              {run.method === 'ach' && run.sameDay ? <RowChip tone="blue">{tp.sameDay}</RowChip> : null}
              {run.heldVendorCount > 0 ? (
                <RowChip tone="amber">{tl.heldVendors.replace('{count}', String(run.heldVendorCount))}</RowChip>
              ) : null}
            </>
          }
        >
          {formatDate(run.paymentDate)}
        </RowTitle>
      ),
    },
    {
      id: 'bankAccount',
      header: tl.columns.bankAccount,
      width: 'w-[180px]',
      render: (run) => <RowText>{run.bankAccountName}</RowText>,
    },
    {
      id: 'bills',
      header: tl.columns.bills,
      width: 'w-[70px]',
      render: (run) => <RowText className="tabular-nums">{String(run.billCount)}</RowText>,
    },
    {
      id: 'vendors',
      header: tl.columns.vendors,
      width: 'w-[80px]',
      render: (run) => <RowText className="tabular-nums">{String(run.paymentCount)}</RowText>,
    },
    {
      id: 'approvals',
      header: tl.columns.approvals,
      width: 'w-[100px]',
      render: (run) => (
        <RowText className="whitespace-nowrap">
          {run.status === 'draft' || run.status === 'cancelled'
            ? null
            : tl.approvalsOf.replace('{done}', String(run.approvalCount)).replace('{required}', String(run.requiredApprovals))}
        </RowText>
      ),
    },
    {
      id: 'total',
      header: tl.columns.total,
      width: 'w-[130px]',
      render: (run) => <RowAmount>{formatMoney(run.totalAmount)}</RowAmount>,
    },
    {
      id: 'status',
      header: tl.columns.status,
      width: 'w-[130px]',
      render: (run) => <RunStatusChip status={run.status} />,
    },
  ];

  let body;
  if (query.isError && list.items.length === 0) {
    body = (
      <div className="space-y-2 p-4">
        <p className="text-sm text-destructive" role="alert">{tp.common.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>{tp.common.retry}</Button>
      </div>
    );
  } else {
    body = (
      <WeldbooksEntityList<PaymentRunSummary>
        items={runs}
        isLoading={list.isLoading}
        columns={columns}
        getRowClassName={(run) => (run.status === 'cancelled' ? 'opacity-60' : '')}
        onRowClick={(run) => navigate({ to: '/weldbooks/payment-runs/$id', params: { id: run.id } })}
        filters={filterConfigs}
        activeFilters={activeFilters}
        onFiltersChange={(next) => {
          setActiveFilters(next);
          paging.reset();
        }}
        hasMore={list.hasMore}
        isLoadingMore={list.isLoadingMore}
        onLoadMore={list.loadMore}
        createButton={canCreate ? { label: tl.newRun, onClick: newRun } : undefined}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <ReceiptText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tl.emptyTitle,
          description: tl.emptyDescription,
          action: canCreate ? { label: tl.newRun, onClick: newRun } : undefined,
        }}
        noResultsState={{ title: t.common.empty.noResults, description: '' }}
      />
    );
  }

  return (
    <PaymentRunsFrame layout="list" title={tl.title} subtitle={tl.subtitle}>
      {body}
    </PaymentRunsFrame>
  );
}
