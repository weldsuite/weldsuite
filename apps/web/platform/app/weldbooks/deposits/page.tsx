import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Wallet } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowChip,
  RowDate,
  RowText,
  RowTitle,
  StatusChip,
} from '@/components/accounting/weldbooks-row-cells';
import { useI18n } from '@/lib/i18n/provider';
import { DepositsUsOnlyGate } from './us-only-gate';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';
import { useLoadMorePages } from '@/lib/weldbooks/use-load-more-pages';
import { useBankAccounts, useBankDeposits } from '@/hooks/queries/use-weldbooks-banking-queries';
import type { BankDeposit } from '@/lib/api/domains/weldbooks-banking';
import { UndepositedFundsCallout } from '../banking/components/undeposited-funds-callout';

const PAGE_SIZE = 25;

/** Deposits are for US entities; any other entity gets a notice instead of the screen. */
export default function DepositsPageGated() {
  return (
    <DepositsUsOnlyGate>
      <DepositsPage />
    </DepositsUsOnlyGate>
  );
}

function DepositsPage() {
  const { t } = useI18n();
  const td = t.weldbooksUs.banking.deposits;
  const navigate = useNavigate();
  // Each deposit opens in the shared object panel (type 'deposit'), the same
  // panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/deposits');
  const { can } = usePermissions();
  const { formatMoney, formatDate, entityCurrency } = useWeldbooksFormat();

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const paging = useLoadMorePages<BankDeposit, string | undefined>(undefined);

  const { data: accountsRes } = useBankAccounts();
  const accounts = useMemo(() => accountsRes?.data ?? [], [accountsRes]);
  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  const bankAccountId = pillValue(activeFilters, 'bankAccountId');
  const status = pillValue(activeFilters, 'status');
  const query = useBankDeposits({
    limit: PAGE_SIZE,
    bankAccountId,
    status: status === 'posted' || status === 'void' ? status : undefined,
    cursor: paging.key,
  });
  const list = paging.view({
    rows: query.data?.data,
    nextKey: query.data?.pagination.hasMore ? (query.data.pagination.cursor ?? null) : null,
    isPlaceholder: query.isPlaceholderData,
    isError: query.isError,
  });
  const deposits = useMemo(
    () => applyExclusions(list.items, activeFilters, { bankAccountId: (d) => d.bankAccountId, status: (d) => d.status }),
    [list.items, activeFilters],
  );

  const filterConfigs: FilterConfig[] = [
    {
      field: 'bankAccountId',
      label: td.columns.bankAccount,
      options: accounts.map((a) => ({ value: a.id, label: a.name })),
    },
    {
      field: 'status',
      label: td.columns.status,
      options: [
        { value: 'posted', label: td.statuses.posted },
        { value: 'void', label: td.statuses.void },
      ],
    },
  ];

  const canCreate = can('banking:create');
  const makeDeposit = () => navigate({ to: '/weldbooks/deposits/new' });

  const columns: ColumnDef<BankDeposit>[] = [
    {
      id: 'memo',
      header: td.columns.memo,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (deposit) => (
        <RowTitle
          chips={
            deposit.bankTransactionId ? (
              <RowChip tone="green">{td.matched}</RowChip>
            ) : null
          }
        >
          {deposit.memo || td.make.depositTitle}
        </RowTitle>
      ),
    },
    {
      id: 'bankAccount',
      header: td.columns.bankAccount,
      width: 'w-[200px]',
      render: (deposit) => <RowText>{accountNames.get(deposit.bankAccountId)}</RowText>,
    },
    {
      id: 'date',
      header: td.columns.date,
      width: 'w-[120px]',
      render: (deposit) => <RowDate>{formatDate(deposit.date)}</RowDate>,
    },
    {
      id: 'amount',
      header: td.columns.amount,
      width: 'w-[130px]',
      render: (deposit) => <RowAmount>{formatMoney(deposit.amount, deposit.currency || entityCurrency)}</RowAmount>,
    },
    {
      id: 'status',
      header: td.columns.status,
      width: 'w-[110px]',
      render: (deposit) => (
        <StatusChip tone={deposit.status === 'void' ? 'gray' : 'green'}>{td.statuses[deposit.status]}</StatusChip>
      ),
    },
  ];

  if (query.isError && list.items.length === 0) {
    return (
      <p className="p-6 text-sm text-destructive" role="alert">
        {td.loadFailed}
      </p>
    );
  }

  return (
    <>
      <UndepositedFundsCallout className="m-4" />
      <WeldbooksEntityList<BankDeposit>
        items={deposits}
        isLoading={list.isLoading}
        columns={columns}
        getRowClassName={(deposit) => (deposit.status === 'void' ? 'opacity-60' : '')}
        onRowClick={(deposit) => openPanel({ type: 'deposit', id: deposit.id })}
        getRowLabel={(deposit) => deposit.memo || td.make.depositTitle}
        filters={filterConfigs}
        activeFilters={activeFilters}
        onFiltersChange={(next) => {
          setActiveFilters(next);
          paging.reset();
        }}
        hasMore={list.hasMore}
        isLoadingMore={list.isLoadingMore}
        onLoadMore={list.loadMore}
        createButton={canCreate ? { label: td.makeDeposit, onClick: makeDeposit } : undefined}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Wallet className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: td.emptyTitle,
          description: td.emptyDescription,
          action: canCreate ? { label: td.makeDeposit, onClick: makeDeposit } : undefined,
        }}
        noResultsState={{ title: t.common.empty.noResults, description: '' }}
      />
    </>
  );
}
