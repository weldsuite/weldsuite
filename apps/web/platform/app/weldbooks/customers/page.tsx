import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAccountingCustomers } from '@/hooks/queries/use-accounting-queries';
import { Badge } from '@weldsuite/ui/components/badge';
import { Users } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
} from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

interface CustomerRow {
  id: string;
  name: string;
  email?: string | null;
  role?: string | null;
  vatNumber?: string | null;
}

export default function AccountingCustomersPage() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const navigate = useNavigate();
  const { t } = useI18n();
  const tcp = t.accounting.customersPage;

  // Backend expands role=customer → customer + both. This pill lets the user
  // narrow to only the dual-role entries when they want to audit them.
  const filterConfigs: FilterConfig[] = [
    {
      field: 'role',
      label: tcp.filterRoleLabel,
      options: [{ value: 'both', label: tcp.filterBoth }],
    },
  ];

  const roleFilter = filters.find((f) => f.field === 'role' && f.value)?.value as
    | 'both'
    | undefined;

  const { data, isLoading } = useAccountingCustomers({
    search,
    role: roleFilter ?? 'customer',
  });

  const customers = (data?.data ?? []) as CustomerRow[];

  const columns: ColumnDef<CustomerRow>[] = [
    {
      id: 'name',
      header: tcp.colName,
      width: 'flex-1',
      render: (customer) => <span className="font-medium">{customer.name}</span>,
    },
    {
      id: 'email',
      header: tcp.colEmail,
      width: 'flex-1',
      render: (c) => <span className="text-muted-foreground">{c.email ?? '—'}</span>,
    },
    {
      id: 'role',
      header: tcp.colRole,
      width: 'w-[140px]',
      render: (c) => (
        <Badge variant="outline" className="capitalize">
          {c.role === 'both' ? tcp.roleBoth : c.role ?? '—'}
        </Badge>
      ),
    },
    {
      id: 'vat',
      header: tcp.colVat,
      width: 'w-[180px]',
      render: (c) => <span className="text-muted-foreground">{c.vatNumber ?? '—'}</span>,
    },
  ];

  return (
    <WeldbooksEntityList<CustomerRow>
      items={customers}
      isLoading={isLoading}
      columns={columns}
      onRowClick={(c) => navigate({ to: `/weldbooks/customers/${c.id}` as any })}
      filters={filterConfigs}
      searchQuery={search}
      onSearchChange={setSearch}
      activeFilters={filters}
      onFiltersChange={setFilters}
      searchPlaceholder={tcp.searchPlaceholder}
      createButton={{
        label: tcp.newCustomer,
        onClick: () => navigate({ to: '/weldbooks/customers/add' as any }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Users className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tcp.noCustomers,
        description: tcp.searchPlaceholder,
        action: {
          label: tcp.newCustomer,
          onClick: () => navigate({ to: '/weldbooks/customers/add' as any }),
        },
      }}
    />
  );
}

