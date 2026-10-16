import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Download, Inbox } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig, type GroupConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  ContactCell,
  RowAmount,
  RowChip,
  RowDate,
  RowText,
  RowTitle,
  StatusChip,
} from '@/components/accounting/weldbooks-row-cells';
import { BankTransactionFormDialog } from '@/components/accounting/bank-transaction-form-dialog';
import { useBankAccounts, useBankLines } from '@/hooks/queries/use-weldbooks-banking-queries';
import type { BankLine, BankLineSource } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';
import { applyExclusions, dateBounds, pillValue } from '@/lib/weldbooks/list-filters';
import { useLoadMorePages } from '@/lib/weldbooks/use-load-more-pages';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const PAGE_SIZE = 50;
const SOURCES: readonly BankLineSource[] = ['feed', 'import', 'manual'];
const STATUSES = ['unreconciled', 'reconciled', 'excluded'] as const;

export default function BankTransactionsPage() {
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const paging = useLoadMorePages<BankLine, number>(1);
  const navigate = useNavigate();
  const { t } = useI18n();
  const st = useTranslations();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const tbp = t.accounting.bankingPages;
  const tl = t.weldbooksUs.banking.lines;

  const { data: accountsRes } = useBankAccounts();
  const accounts = useMemo(() => accountsRes?.data ?? [], [accountsRes]);
  const currencyByAccountId = useMemo(() => new Map(accounts.map((a) => [a.id, a.currency])), [accounts]);

  const accountId = pillValue(activeFilters, 'bankAccountId');
  const status = pillValue(activeFilters, 'status');
  const source = pillValue(activeFilters, 'source');
  const { from, to } = dateBounds(activeFilters, 'date');
  const query = useBankLines({
    bankAccountId: accountId,
    status,
    source: SOURCES.find((s) => s === source),
    from,
    to,
    search: search || undefined,
    page: paging.key,
    pageSize: PAGE_SIZE,
  });
  const totalCount = query.data?.pagination?.totalCount ?? 0;
  const list = paging.view({
    rows: query.data?.data,
    nextKey: query.data && paging.key * PAGE_SIZE < totalCount ? paging.key + 1 : null,
    isPlaceholder: query.isPlaceholderData,
    isError: query.isError,
  });
  const transactions = useMemo(
    () =>
      applyExclusions(list.items, activeFilters, {
        bankAccountId: (line) => line.bankAccountId,
        status: (line) => line.status,
        source: (line) => line.source,
      }),
    [list.items, activeFilters],
  );

  const statusLabels: Record<(typeof STATUSES)[number], string> = {
    unreconciled: tbp.unreconciledFilter,
    reconciled: tbp.reconciledFilter,
    excluded: tbp.excludedFilter,
  };
  const statusLabel = (value: string) => statusLabels[value as (typeof STATUSES)[number]] ?? value;

  const filterConfigs: FilterConfig[] = [
    {
      field: 'bankAccountId',
      label: tbp.accountLabel,
      options: accounts.map((a) => ({ value: a.id, label: a.name })),
    },
    {
      field: 'status',
      label: tbp.statusLabel,
      options: STATUSES.map((value) => ({ value, label: statusLabels[value] })),
    },
    {
      field: 'source',
      label: tl.source,
      options: SOURCES.map((value) => ({ value, label: tl.sources[value] })),
    },
    { field: 'date', label: st('sweep.weldbooks.date'), filterType: 'date', options: [] },
  ];

  // Grouped by status like the task list, unless a status filter already picks one.
  const groups: GroupConfig<BankLine>[] | undefined = status
    ? undefined
    : [
        { id: 'unreconciled', label: st('sweep.weldbooks.bankTransactionsTable.unreconciled'), sortOrder: 1, filter: (l) => l.status === 'unreconciled' },
        { id: 'reconciled', label: st('sweep.weldbooks.bankTransactionsTable.reconciled'), sortOrder: 2, filter: (l) => l.status === 'reconciled' },
        { id: 'excluded', label: st('sweep.weldbooks.bankTransactionsTable.excluded'), sortOrder: 3, filter: (l) => l.status === 'excluded' },
      ];

  const showSource = transactions.some((line) => line.source);
  const columns: ColumnDef<BankLine>[] = [
    {
      id: 'description',
      header: st('sweep.weldbooks.description'),
      width: 'min-w-[200px] flex-1 gap-2',
      render: (line) => (
        <RowTitle
          chips={
            line.checkNumber ? (
              <RowChip tone="gray">{tl.checkNumberBadge.replace('{number}', line.checkNumber)}</RowChip>
            ) : null
          }
        >
          {line.description || '—'}
        </RowTitle>
      ),
    },
    {
      id: 'counterparty',
      header: st('sweep.weldbooks.bankTransactionsTable.counterparty'),
      width: 'w-[200px]',
      render: (line) => <ContactCell name={line.counterpartyName} />,
    },
    {
      id: 'reference',
      header: st('sweep.weldbooks.bankTransactionsTable.reference'),
      width: 'w-[160px]',
      render: (line) => <RowText>{line.reference}</RowText>,
    },
    ...(showSource
      ? [
          {
            id: 'source',
            header: tl.source,
            width: 'w-[110px]',
            render: (line: BankLine) => <RowText>{line.source ? tl.sources[line.source] : null}</RowText>,
          },
        ]
      : []),
    {
      id: 'date',
      header: st('sweep.weldbooks.date'),
      width: 'w-[120px]',
      render: (line) => <RowDate>{formatDate(line.date)}</RowDate>,
    },
    {
      id: 'amount',
      header: st('sweep.weldbooks.amount'),
      width: 'w-[130px]',
      render: (line) => (
        <RowAmount className={(Number(line.amount) || 0) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : undefined}>
          {formatMoney(line.amount, currencyByAccountId.get(line.bankAccountId))}
        </RowAmount>
      ),
    },
    {
      id: 'status',
      header: st('sweep.weldbooks.status'),
      width: 'w-[110px]',
      render: (line) => <StatusChip status={line.status}>{statusLabel(line.status)}</StatusChip>,
    },
  ];

  if (query.isError && list.items.length === 0) {
    return (
      <p className="p-6 text-sm text-destructive" role="alert">
        {t.common.toast.failedToLoad}
      </p>
    );
  }

  return (
    <>
      <WeldbooksEntityList<BankLine>
        items={transactions}
        isLoading={list.isLoading}
        columns={columns}
        groups={groups}
        filters={filterConfigs}
        activeFilters={activeFilters}
        onFiltersChange={(next) => {
          setActiveFilters(next);
          paging.reset();
        }}
        searchQuery={search}
        onSearchChange={(next) => {
          setSearch(next);
          paging.reset();
        }}
        searchFields={['description', 'counterpartyName', 'reference']}
        searchPlaceholder={tl.searchPlaceholder}
        hasMore={list.hasMore}
        isLoadingMore={list.isLoadingMore}
        onLoadMore={list.loadMore}
        createButton={{ label: tbp.addTransactionButton, onClick: () => setAddOpen(true) }}
        actionButtons={
          <Button variant="outline" size="sm" className="h-8" asChild>
            <Link to="/weldbooks/banking/import">
              <Download className="h-4 w-4 md:mr-0.5" />
              <span className="hidden md:inline">{tbp.importStatementButton}</span>
            </Link>
          </Button>
        }
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Inbox className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tbp.transactionsEmptyTitle,
          description: tbp.transactionsEmptyDescription,
          action: { label: tbp.addTransactionButton, onClick: () => setAddOpen(true) },
          secondaryAction: {
            label: tbp.importStatementButton,
            onClick: () => navigate({ to: '/weldbooks/banking/import' }),
          },
        }}
        noResultsState={{ title: tbp.noTransactionsMatch, description: '' }}
      />

      <BankTransactionFormDialog open={addOpen} onOpenChange={setAddOpen} bankAccountId={accountId} />
    </>
  );
}
