import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAccountingAccounts } from '@/hooks/queries/use-accounting-queries';
import { Landmark } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
  type GroupConfig,
} from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  balance?: number | null;
}

export default function ChartOfAccountsPage() {
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const navigate = useNavigate();
  const { t } = useI18n();
  const tap = t.accounting.accountsPage;

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
  ];

  const typeFilter = useMemo(
    () => filters.find((f) => f.field === 'type' && f.value)?.value,
    [filters],
  );

  const { data, isLoading } = useAccountingAccounts({
    type: typeFilter,
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

  const columns: ColumnDef<AccountRow>[] = [
    {
      id: 'code',
      header: tap.colCode,
      width: 'w-[120px]',
      render: (acc) => <span className="font-mono">{acc.code}</span>,
    },
    {
      id: 'name',
      header: tap.colName,
      width: 'flex-1',
      render: (acc) => <span className="font-medium">{acc.name}</span>,
    },
    {
      id: 'type',
      header: tap.colType,
      width: 'w-[140px]',
      render: (acc) => <span className="capitalize">{acc.type}</span>,
    },
    {
      id: 'balance',
      header: tap.colBalance,
      width: 'w-[160px]',
      render: (acc) => (
        <span>
          {new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(
            Number(acc.balance ?? 0),
          )}
        </span>
      ),
    },
  ];

  return (
    <WeldbooksEntityList<AccountRow>
      items={accounts}
      isLoading={isLoading}
      columns={columns}
      groups={groups}
      onRowClick={(acc) => navigate({ to: '/weldbooks/accounts/$id', params: { id: acc.id } })}
      filters={filterConfigs}
      activeFilters={filters}
      onFiltersChange={setFilters}
      createButton={{
        label: tap.newAccount,
        onClick: () => navigate({ to: '/weldbooks/accounts/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Landmark className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tap.noAccounts,
        description: t.accounting.description,
        action: {
          label: tap.newAccount,
          onClick: () => navigate({ to: '/weldbooks/accounts/add' }),
        },
      }}
    />
  );
}
