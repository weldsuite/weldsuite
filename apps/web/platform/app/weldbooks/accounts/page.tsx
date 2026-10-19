import { useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAccountingAccounts, useTaxLineCatalog } from '@/hooks/queries/use-accounting-queries';
import { ListTree, WalletCards } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  RowAmount,
  RowNumberChip,
  RowText,
  RowTitle,
  StatusChip,
} from '@/components/accounting/weldbooks-row-cells';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
  type GroupConfig,
} from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useI18n } from '@/lib/i18n/provider';
import { useCurrentEntityCurrency } from '@/hooks/use-current-entity-currency';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { taxLineLabel } from '@/lib/weldbooks/tax-lines';

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  currentBalance?: string | number | null;
  currency?: string | null;
  taxLine?: string | null;
}

export default function ChartOfAccountsPage() {
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const navigate = useNavigate();
  // Each account opens in the shared object panel (type 'ledger_account'), the
  // same panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/accounts');
  const { t } = useI18n();
  const tap = t.accounting.accountsPage;
  const { formatMoney } = useCurrentEntityCurrency();
  const { code: jurisdictionCode } = useCurrentJurisdiction();
  const isUs = jurisdictionCode === 'US';
  const tus = t.weldbooksUs.setup.accounts;
  const taxLineCatalog = useTaxLineCatalog(undefined, { enabled: isUs });

  const filterConfigs: FilterConfig[] = [
    {
      field: 'type',
      label: tap.filterTypeLabel,
      options: [
        { value: 'asset', label: tap.filterAsset },
        { value: 'liability', label: tap.filterLiability },
        { value: 'equity', label: tap.filterEquity },
        { value: 'revenue', label: tap.filterRevenue },
        { value: 'expense', label: tap.filterExpense },
      ],
    },
    // US: the income and expense accounts that still need a line of the tax return.
    ...(isUs
      ? [{ field: 'taxLine', label: tus.filterTaxLine, options: [{ value: 'none', label: tus.filterUnmapped }] }]
      : []),
  ];

  const typeFilter = useMemo(
    () => filters.find((f) => f.field === 'type' && f.value)?.value,
    [filters],
  );

  const taxLineFilter = useMemo(
    () => (isUs ? filters.find((f) => f.field === 'taxLine' && f.value)?.value : undefined),
    [filters, isUs],
  );

  const { data, isLoading } = useAccountingAccounts({
    type: typeFilter,
    taxLine: taxLineFilter,
    includeInactive: true,
  });

  const accounts = (data?.data ?? []) as AccountRow[];

  // Textbook accounting order. Groups are only shown when no type filter is
  // active — otherwise the lone group header is redundant.
  const groups: GroupConfig<AccountRow>[] | undefined = !typeFilter
    ? [
        { id: 'asset', label: tap.groupAssets, sortOrder: 1, filter: (a) => a.type === 'asset' },
        { id: 'liability', label: tap.groupLiabilities, sortOrder: 2, filter: (a) => a.type === 'liability' },
        { id: 'equity', label: tap.groupEquity, sortOrder: 3, filter: (a) => a.type === 'equity' },
        { id: 'revenue', label: tap.groupRevenue, sortOrder: 4, filter: (a) => a.type === 'revenue' },
        { id: 'expense', label: tap.groupExpenses, sortOrder: 5, filter: (a) => a.type === 'expense' },
      ]
    : undefined;

  const typeLabels: Record<string, string> = {
    asset: tap.filterAsset,
    liability: tap.filterLiability,
    equity: tap.filterEquity,
    revenue: tap.filterRevenue,
    expense: tap.filterExpense,
  };

  const columns: ColumnDef<AccountRow>[] = [
    {
      id: 'name',
      header: tap.colName,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (acc) => (
        <>
          <RowNumberChip>{acc.code}</RowNumberChip>
          <RowTitle>{acc.name}</RowTitle>
        </>
      ),
    },
    {
      id: 'type',
      header: tap.colType,
      width: 'w-[140px]',
      render: (acc) => <RowText>{typeLabels[acc.type] ?? acc.type}</RowText>,
    },
    ...(isUs
      ? [
          {
            id: 'taxLine',
            header: tus.colTaxLine,
            width: 'w-[240px]',
            render: (acc: AccountRow) => {
              if (acc.taxLine) {
                return <RowText>{taxLineLabel(taxLineCatalog.data, acc.taxLine)}</RowText>;
              }
              // Only income and expense accounts report on a line by default.
              return acc.type === 'revenue' || acc.type === 'expense' ? (
                <StatusChip tone="amber">{tus.unmappedBadge}</StatusChip>
              ) : (
                <RowText />
              );
            },
          },
        ]
      : []),
    {
      id: 'balance',
      header: tap.colBalance,
      width: 'w-[160px]',
      render: (acc) => <RowAmount>{formatMoney(acc.currentBalance, acc.currency)}</RowAmount>,
    },
  ];

  return (
    <WeldbooksEntityList<AccountRow>
      items={accounts}
      isLoading={isLoading}
      columns={columns}
      groups={groups}
      onRowClick={(acc) => openPanel({ type: 'ledger_account', id: acc.id })}
      getRowLabel={(acc) => `${acc.code} ${acc.name}`}
      filters={filterConfigs}
      activeFilters={filters}
      onFiltersChange={setFilters}
      actionButtons={
        isUs ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/weldbooks/accounts/tax-lines">
              <ListTree className="mr-1 h-4 w-4" aria-hidden />
              {tus.mappingLink}
            </Link>
          </Button>
        ) : undefined
      }
      createButton={{
        label: tap.newAccount,
        onClick: () => navigate({ to: '/weldbooks/accounts/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <WalletCards className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tap.noAccounts,
        description: tap.emptyDescription,
        action: {
          label: tap.newAccount,
          onClick: () => navigate({ to: '/weldbooks/accounts/add' }),
        },
      }}
    />
  );
}
