import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useInfiniteAccountingBills } from '@/hooks/queries/use-accounting-queries';
import { ReceiptText } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowDate, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import {
  EmptyStateIllustration,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';

/** The statuses the Status filter offers, in the order a bill moves through them. */
const BILL_STATUSES = ['draft', 'pending_approval', 'approved', 'partial', 'overdue', 'paid', 'rejected', 'disputed', 'void', 'cancelled'] as const;

interface BillRow {
  id: string;
  billNumber: string | null;
  contactName: string | null;
  contactId?: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  total?: string | number | null;
  currency?: string | null;
  status: string;
}

export default function BillsPage() {
  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteAccountingBills({
    search,
    status: pillValue(activeFilters, 'status'),
  });
  const navigate = useNavigate();
  // Each bill opens in the shared object panel (type 'bill'), the same
  // panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/bills');
  const { t } = useI18n();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const tbp = t.accounting.billsPage;
  const tsl = t.accounting.statusLabels.bill as Record<string, string>;

  // The server filters on an `is` status; an `is not` one narrows the rows it sent.
  const bills = applyExclusions((data?.rows ?? []) as unknown as BillRow[], activeFilters, { status: (bill) => bill.status });
  const filterConfigs: FilterConfig[] = [
    { field: 'status', label: tbp.colStatus, options: BILL_STATUSES.map((value) => ({ value, label: tsl[value] ?? value })) },
  ];

  // Group by lifecycle status, most-urgent first. The trailing "other" group is
  // an explicit catch-all: EntityList drops items matching no group, so any
  // status outside the known set stays visible here.
  const knownStatuses = new Set(['overdue', 'approved', 'partial', 'draft', 'paid']);
  const groups: GroupConfig<BillRow>[] = [
    { id: 'overdue', label: tbp.groupOverdue, sortOrder: 1, filter: (b) => b.status === 'overdue' },
    { id: 'approved', label: tbp.groupApproved, sortOrder: 2, filter: (b) => b.status === 'approved' || b.status === 'partial' },
    { id: 'draft', label: tbp.groupDraft, sortOrder: 3, filter: (b) => b.status === 'draft' },
    { id: 'paid', label: tbp.groupPaid, sortOrder: 4, filter: (b) => b.status === 'paid' },
    { id: 'other', label: tbp.groupOther, sortOrder: 5, filter: (b) => !knownStatuses.has(b.status) },
  ];

  const columns: ColumnDef<BillRow>[] = [
    {
      id: 'number',
      header: tbp.colNumber,
      width: 'min-w-0 flex-1 gap-2 @2xl/list:min-w-[200px]',
      render: (bill) => <RowTitle>{bill.billNumber ?? '—'}</RowTitle>,
    },
    {
      id: 'supplier',
      header: tbp.colSupplier,
      width: 'hidden shrink-0 @4xl/list:flex w-[200px]',
      render: (bill) => <ContactCell name={bill.contactName} contactId={bill.contactId} />,
    },
    {
      id: 'issueDate',
      header: tbp.colDate,
      width: 'hidden shrink-0 @4xl/list:flex w-[120px]',
      render: (bill) => <RowDate>{formatDate(bill.issueDate)}</RowDate>,
    },
    {
      id: 'dueDate',
      header: tbp.colDueDate,
      width: 'hidden shrink-0 @6xl/list:flex w-[120px]',
      render: (bill) => <RowDate>{formatDate(bill.dueDate)}</RowDate>,
    },
    {
      id: 'total',
      header: tbp.colTotal,
      width: 'shrink-0 w-[130px]',
      render: (bill) => <RowAmount>{formatMoney(bill.total ?? bill.totalAmount, bill.currency)}</RowAmount>,
    },
    {
      id: 'status',
      header: tbp.colStatus,
      // On a phone the number and the total get the row; the status shows from 512px of list width.
      width: 'hidden shrink-0 @lg/list:flex w-[110px]',
      render: (bill) => <StatusChip status={bill.status}>{tsl[bill.status] ?? bill.status}</StatusChip>,
    },
  ];

  return (
    <WeldbooksEntityList<BillRow>
      items={bills}
      isLoading={isLoading}
      columns={columns}
      groups={groups}
      hasMore={hasNextPage}
      isLoadingMore={isFetchingNextPage}
      onLoadMore={() => void fetchNextPage()}
      onRowClick={(bill) => openPanel({ type: 'bill', id: bill.id })}
      getRowLabel={(bill) => bill.billNumber ?? bill.contactName ?? bill.id}
      filters={filterConfigs}
      activeFilters={activeFilters}
      onFiltersChange={setActiveFilters}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder={tbp.searchPlaceholder}
      createButton={{
        label: tbp.newBill,
        onClick: () => navigate({ to: '/weldbooks/bills/add' }),
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <ReceiptText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tbp.noBills,
        description: tbp.emptyDescription,
        action: {
          label: tbp.newBill,
          onClick: () => navigate({ to: '/weldbooks/bills/add' }),
        },
      }}
    />
  );
}
