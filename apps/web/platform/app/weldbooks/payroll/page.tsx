import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { EllipsisVertical, HandCoins, Plug, Undo2 } from 'lucide-react';
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
import { RowAmount, RowChip, RowDate, RowText, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { usePayrollImports } from '@/hooks/queries/use-weldbooks-assets-queries';
import type { PayrollImport } from '@/lib/api/domains/weldbooks-assets';
import { useI18n } from '@/lib/i18n/provider';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';
import { useLoadMorePages } from '@/lib/weldbooks/use-load-more-pages';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { ReversePayrollDialog } from './components/reverse-dialog';

const PAGE_SIZE = 25;
const SOURCES = ['csv', 'gusto'] as const;
const STATUSES = ['posted', 'reversed'] as const;

/** The two amounts a payroll is known by: gross wages and net pay (a ledger export has neither, so they are left out). */
function headline(summary: PayrollImport['summary']): { gross: number | null; net: number | null } {
  return { gross: summary?.gross_wages ?? null, net: summary?.net_pay ?? null };
}

/** Payrolls imported into the ledger, from a CSV file or from Gusto. */
export default function PayrollImportsPage() {
  const { t } = useI18n();
  const tp = t.weldbooksUs.assets.payroll;
  const tl = tp.list;
  const common = t.weldbooksUs.assets.common;
  const navigate = useNavigate();
  const { can } = usePermissions();
  const { formatMoney, formatDate } = useWeldbooksFormat();

  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const paging = useLoadMorePages<PayrollImport, string | undefined>(undefined);
  const [reversing, setReversing] = useState<PayrollImport | null>(null);

  const status = pillValue(activeFilters, 'status');
  const source = pillValue(activeFilters, 'source');
  const query = usePayrollImports({
    limit: PAGE_SIZE,
    status: STATUSES.find((s) => s === status),
    source: SOURCES.find((s) => s === source),
    cursor: paging.key,
  });
  const list = paging.view({
    rows: query.data?.data,
    nextKey: query.data?.pagination.hasMore ? (query.data.pagination.cursor ?? null) : null,
    isPlaceholder: query.isPlaceholderData,
    isError: query.isError,
  });
  const imports = useMemo(
    () => applyExclusions(list.items, activeFilters, { status: (row) => row.status, source: (row) => row.source }),
    [list.items, activeFilters],
  );

  const canCreate = can('journal:create');
  const canReverse = can('journal:delete');
  const importCsv = () => void navigate({ to: '/weldbooks/payroll/import' });

  const filterConfigs: FilterConfig[] = [
    { field: 'status', label: tl.columns.status, options: STATUSES.map((s) => ({ value: s, label: tp.statuses[s] })) },
    { field: 'source', label: tl.columns.source, options: SOURCES.map((s) => ({ value: s, label: tp.sources[s] })) },
  ];

  const columns: ColumnDef<PayrollImport>[] = [
    {
      id: 'payDate',
      header: tl.columns.payDate,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (row) => (
        <RowTitle chips={<RowChip tone="gray">{tp.sources[row.source]}</RowChip>}>{formatDate(row.payDate)}</RowTitle>
      ),
    },
    {
      id: 'period',
      header: tl.columns.period,
      width: 'w-[200px]',
      render: (row) => (
        <RowDate>
          {row.periodStart && row.periodEnd ? `${formatDate(row.periodStart)} – ${formatDate(row.periodEnd)}` : null}
        </RowDate>
      ),
    },
    {
      id: 'file',
      header: tl.columns.source,
      width: 'w-[180px]',
      render: (row) => <RowText>{row.sourceFileName}</RowText>,
    },
    {
      id: 'grossWages',
      header: tl.columns.grossWages,
      width: 'w-[130px]',
      render: (row) => {
        const { gross } = headline(row.summary);
        return <RowAmount>{gross === null ? null : formatMoney(gross)}</RowAmount>;
      },
    },
    {
      id: 'netPay',
      header: tl.columns.netPay,
      width: 'w-[130px]',
      render: (row) => {
        const { net } = headline(row.summary);
        return <RowAmount>{net === null ? null : formatMoney(net)}</RowAmount>;
      },
    },
    {
      id: 'status',
      header: tl.columns.status,
      width: 'w-[110px]',
      render: (row) => <StatusChip status={row.status}>{tp.statuses[row.status]}</StatusChip>,
    },
  ];

  const renderRowMenu = (row: PayrollImport) => {
    if (row.status !== 'posted' || !canReverse) return null;
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
            onClick={() => setReversing(row)}
          >
            <Undo2 className="mr-0.5 h-3.5 w-3.5 text-red-600" />
            {tl.reverse}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  if (query.isError && list.items.length === 0) {
    return (
      <div className="space-y-3 p-6 text-center">
        <p className="text-sm text-destructive" role="alert">
          {tl.loadFailed}
        </p>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {common.retry}
        </Button>
      </div>
    );
  }

  return (
    <>
      <WeldbooksEntityList<PayrollImport>
        items={imports}
        isLoading={list.isLoading}
        columns={columns}
        getRowClassName={(row) => (row.status === 'reversed' ? 'opacity-60' : '')}
        onRowClick={(row) => void navigate({ to: '/weldbooks/payroll/$id', params: { id: row.id } })}
        getRowLabel={(row) => formatDate(row.payDate)}
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
        actionButtons={
          <Button variant="outline" size="sm" className="h-8" asChild>
            <Link to="/weldbooks/payroll/connections">
              <Plug className="h-4 w-4 md:mr-0.5" />
              <span className="hidden md:inline">{tl.gusto}</span>
            </Link>
          </Button>
        }
        createButton={canCreate ? { label: tl.importCsv, onClick: importCsv } : undefined}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <HandCoins className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tl.emptyTitle,
          description: tl.emptyDescription,
          action: canCreate ? { label: tl.importCsv, onClick: importCsv } : undefined,
        }}
        noResultsState={{ title: tl.emptyFiltered, description: '' }}
      />

      {reversing ? (
        <ReversePayrollDialog
          payroll={reversing}
          open
          onOpenChange={(open) => (open ? undefined : setReversing(null))}
          onReversed={() => paging.reset()}
        />
      ) : null}
    </>
  );
}
