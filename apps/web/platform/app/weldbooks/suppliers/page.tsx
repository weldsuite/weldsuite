import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAccountingCustomers } from '@/hooks/queries/use-accounting-queries';
import { Badge } from '@weldsuite/ui/components/badge';
import { Truck } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type FilterConfig,
  type ActiveFilter,
} from '@/components/entity-list';
import { useI18n } from '@/lib/i18n/provider';

interface SupplierRow {
  id: string;
  name: string;
  email?: string | null;
  role?: string | null;
  vatNumber?: string | null;
}

export default function AccountingSuppliersPage() {
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const navigate = useNavigate();
  const { t } = useI18n();
  const tsp = t.accounting.suppliersPage;

  // Backend expands role=supplier → supplier + both. This pill lets the user
  // narrow to only the dual-role entries when auditing.
  const filterConfigs: FilterConfig[] = [
    {
      field: 'role',
      label: tsp.filterRoleLabel,
      options: [{ value: 'both', label: tsp.filterBoth }],
    },
  ];

  const roleFilter = filters.find((f) => f.field === 'role' && f.value)?.value as
    | 'both'
    | undefined;

  const { data, isLoading } = useAccountingCustomers({
    search,
    role: roleFilter ?? 'supplier',
  });

  const suppliers = (data?.data ?? []) as SupplierRow[];

  const columns: ColumnDef<SupplierRow>[] = [
    {
      id: 'name',
      header: tsp.colName,
      width: 'flex-1',
      render: (supplier) => <span className="font-medium">{supplier.name}</span>,
    },
    {
      id: 'email',
      header: tsp.colEmail,
      width: 'flex-1',
      render: (c) => <span className="text-muted-foreground">{c.email ?? '—'}</span>,
    },
    {
      id: 'role',
      header: tsp.colRole,
      width: 'w-[140px]',
      render: (c) => (
        <Badge variant="outline" className="capitalize">
          {c.role === 'both' ? tsp.roleBoth : c.role ?? '—'}
        </Badge>
      ),
    },
    {
      id: 'vat',
      header: tsp.colVat,
      width: 'w-[180px]',
      render: (c) => <span className="text-muted-foreground">{c.vatNumber ?? '—'}</span>,
    },
  ];

  return (
    <WeldbooksEntityList<SupplierRow>
      items={suppliers}
      isLoading={isLoading}
      columns={columns}
      onRowClick={(s) => navigate({ to: '/weldbooks/customers/$id', params: { id: s.id } })}
      filters={filterConfigs}
      searchQuery={search}
      onSearchChange={setSearch}
      activeFilters={filters}
      onFiltersChange={setFilters}
      searchPlaceholder={tsp.searchPlaceholder}
      createButton={{
        label: tsp.newSupplier,
        onClick: () =>
          // Same create form as customers — the role selector lets the user
          // pick 'supplier' or 'both' at creation time.
          navigate({ to: '/weldbooks/customers/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <Truck className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tsp.noSuppliers,
        description: tsp.searchPlaceholder,
        action: {
          label: tsp.newSupplier,
          onClick: () => navigate({ to: '/weldbooks/customers/add' }),
        },
      }}
    />
  );
}
