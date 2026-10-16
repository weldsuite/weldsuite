import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Ban, BookOpen, EllipsisVertical } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EmptyStateIllustration, type ActiveFilter, type ColumnDef, type FilterConfig } from '@/components/entity-list';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowChip, RowDate, RowText, RowTitle } from '@/components/accounting/weldbooks-row-cells';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { applyExclusions, dateBounds, pillValue } from '@/lib/weldbooks/list-filters';
import { useLoadMorePages } from '@/lib/weldbooks/use-load-more-pages';
import { useBankAccounts } from '@/hooks/queries/use-weldbooks-banking-queries';
import { useCheckRegister } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import type { CheckRegisterRow, CheckStatus } from '@/lib/api/domains/weldbooks-payment-runs';
import { PaymentRunsFrame } from '../components/payment-runs-frame';
import { CheckStatusChip } from '../components/run-badges';
import { VoidCheckDialog, type VoidableCheck } from '../components/void-check-dialog';

const PAGE_SIZE = 50;
const STATUSES: readonly CheckStatus[] = ['to_print', 'printed', 'cleared', 'voided'];

/** A register row, with the `id` the list keys on. */
type CheckRow = CheckRegisterRow & { id: string };

export default function CheckRegisterPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tr = tp.register;
  const { can } = usePermissions();
  const { formatMoney, formatDate, formatDateTime } = useWeldbooksFormat();

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const paging = useLoadMorePages<CheckRow, string | undefined>(undefined);
  const [voiding, setVoiding] = useState<VoidableCheck | null>(null);

  const { data: accountsRes } = useBankAccounts();
  const accounts = useMemo(() => accountsRes?.data ?? [], [accountsRes]);
  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  const status = pillValue(activeFilters, 'status');
  const { from, to } = dateBounds(activeFilters, 'date');
  const canRead = can('banking:read');
  const query = useCheckRegister(
    {
      limit: PAGE_SIZE,
      bankAccountId: pillValue(activeFilters, 'bankAccountId'),
      status: STATUSES.find((s) => s === status),
      from,
      to,
      cursor: paging.key,
    },
    { enabled: canRead },
  );
  const pageRows = useMemo<CheckRow[] | undefined>(
    () => query.data?.data.map((row) => ({ ...row, id: row.paymentId })),
    [query.data],
  );
  const list = paging.view({
    rows: pageRows,
    nextKey: query.data?.pagination.hasMore ? (query.data.pagination.cursor ?? null) : null,
    isPlaceholder: query.isPlaceholderData,
    isError: query.isError,
  });
  const rows = useMemo(
    () =>
      applyExclusions(list.items, activeFilters, {
        bankAccountId: (row) => row.bankAccountId,
        status: (row) => row.status,
      }),
    [list.items, activeFilters],
  );
  const canVoid = can('banking:manage');

  const filterConfigs: FilterConfig[] = [
    { field: 'bankAccountId', label: tr.columns.bankAccount, options: accounts.map((a) => ({ value: a.id, label: a.name })) },
    { field: 'status', label: tr.columns.status, options: STATUSES.map((s) => ({ value: s, label: tp.checkStatuses[s] })) },
    { field: 'date', label: tr.columns.date, filterType: 'date', options: [] },
  ];

  const columns: ColumnDef<CheckRow>[] = [
    {
      id: 'number',
      header: tr.columns.number,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (row) => (
        <RowTitle
          chips={
            <>
              {row.status === 'voided' && row.voidedAt ? (
                <span title={row.notes?.split('\n').at(-1) ?? undefined} className="contents">
                  <RowChip tone="red">{tr.voidedOn.replace('{date}', formatDateTime(row.voidedAt))}</RowChip>
                </span>
              ) : null}
              {row.backupWithholdingAmount ? (
                <RowChip tone="amber">
                  {tr.withholdingLine
                    .replace('{gross}', formatMoney(row.grossAmount))
                    .replace('{withheld}', formatMoney(row.backupWithholdingAmount))}
                </RowChip>
              ) : null}
            </>
          }
        >
          {row.checkNumber ?? '—'}
        </RowTitle>
      ),
    },
    {
      id: 'payee',
      header: tr.columns.payee,
      width: 'w-[200px]',
      render: (row) => <ContactCell name={row.payeeName} />,
    },
    {
      id: 'bankAccount',
      header: tr.columns.bankAccount,
      width: 'w-[160px]',
      render: (row) => <RowText>{row.bankAccountId ? accountNames.get(row.bankAccountId) : null}</RowText>,
    },
    {
      id: 'date',
      header: tr.columns.date,
      width: 'w-[120px]',
      render: (row) => <RowDate>{formatDate(row.date)}</RowDate>,
    },
    {
      id: 'run',
      header: tr.columns.run,
      width: 'w-[100px]',
      render: (row) =>
        row.runId ? (
          <Link
            to="/weldbooks/payment-runs/$id"
            params={{ id: row.runId }}
            className="truncate text-sm text-gray-600 underline underline-offset-2 hover:text-foreground dark:text-muted-foreground"
          >
            {tr.openRun}
          </Link>
        ) : (
          <RowText />
        ),
    },
    {
      id: 'amount',
      header: tr.columns.amount,
      width: 'w-[130px]',
      render: (row) => <RowAmount>{formatMoney(row.amount)}</RowAmount>,
    },
    {
      id: 'status',
      header: tr.columns.status,
      width: 'w-[110px]',
      render: (row) => <CheckStatusChip status={row.status} />,
    },
  ];

  const renderRowMenu = (row: CheckRow) => {
    const voidable = canVoid && (row.status === 'printed' || row.status === 'to_print');
    if (!voidable) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t.common.actions.openMenu}
            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
          >
            <EllipsisVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
            onClick={() =>
              setVoiding({
                paymentId: row.paymentId,
                checkNumber: row.checkNumber,
                payeeName: row.payeeName,
                amount: row.amount,
                backupWithholdingAmount: row.backupWithholdingAmount,
              })
            }
          >
            <Ban className="mr-0.5 h-3.5 w-3.5 text-red-600" />
            {tr.voidAction}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const summary = query.data?.summary;

  let body;
  if (!canRead) {
    body = <p className="p-4 text-sm text-muted-foreground">{tp.common.noPermission}</p>;
  } else if (query.isError && list.items.length === 0) {
    body = (
      <div className="space-y-2 p-4">
        <p className="text-sm text-destructive" role="alert">{tp.common.loadFailed}</p>
        <Button variant="outline" size="sm" onClick={() => query.refetch()}>{tp.common.retry}</Button>
      </div>
    );
  } else {
    body = (
      <>
        {summary && list.items.length > 0 ? (
          <div className="flex flex-wrap gap-2 p-4 pb-0 text-sm">
            {STATUSES.map((s) => {
              const entry = summary[s];
              return (
                <span key={s} className="rounded-md border px-3 py-1.5">
                  <span className="text-muted-foreground">{tp.checkStatuses[s]}: </span>
                  <span className="font-medium tabular-nums">{entry?.count ?? 0}</span>
                  {entry ? <span className="text-muted-foreground"> · {formatMoney(entry.total)}</span> : null}
                </span>
              );
            })}
          </div>
        ) : null}
        <WeldbooksEntityList<CheckRow>
          items={rows}
          isLoading={list.isLoading}
          columns={columns}
          getRowClassName={(row) => (row.status === 'voided' ? 'opacity-60' : '')}
          renderRowMenu={renderRowMenu}
          filters={filterConfigs}
          activeFilters={activeFilters}
          onFiltersChange={(next) => {
            setActiveFilters(next);
            paging.reset();
          }}
          hasMore={list.hasMore}
          isLoadingMore={list.isLoadingMore}
          onLoadMore={list.loadMore}
          emptyState={{
            icon: (
              <EmptyStateIllustration>
                <BookOpen className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
              </EmptyStateIllustration>
            ),
            title: tr.emptyTitle,
            description: tr.emptyDescription,
          }}
          noResultsState={{ title: t.common.empty.noResults, description: '' }}
        />
      </>
    );
  }

  return (
    <PaymentRunsFrame layout="list" title={tr.title} subtitle={tr.subtitle}>
      {body}
      <VoidCheckDialog
        check={voiding}
        onOpenChange={(open) => {
          if (!open) setVoiding(null);
        }}
        onVoided={() => paging.reset()}
      />
    </PaymentRunsFrame>
  );
}
