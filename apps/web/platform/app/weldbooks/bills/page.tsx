import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useInfiniteAccountingBills } from '@/hooks/queries/use-accounting-queries';
import { ReceiptText } from 'lucide-react';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowDate, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { useI18n } from '@/lib/i18n/provider';
import { PaymentPendingChip } from '@/components/accounting/payment-pending-chip';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';
import { BILL_VIEWS, isBillDue, isOpenBill, useFillFilteredList } from '@/lib/weldbooks/list-views';
import { useUrlPillFilters } from '@/lib/weldbooks/use-url-pill-filters';

/** The statuses the Status filter offers, in the order a bill moves through them. */
const BILL_STATUSES = ['draft', 'pending_approval', 'approved', 'partial', 'overdue', 'paid', 'rejected', 'disputed', 'void', 'cancelled'] as const;

/** The filters the address carries: `?status=pending_approval`, `?show=due`. */
const URL_FILTER_FIELDS = ['status', 'show'] as const;
const URL_FILTER_VALUES = { status: BILL_STATUSES, show: BILL_VIEWS };

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
  // The Status and Show filters live in the address, so a link from To process or the
  // overview opens the list already filtered and the filter survives navigation.
  const { activeFilters, onFiltersChange } = useUrlPillFilters(URL_FILTER_FIELDS, URL_FILTER_VALUES);
  const show = pillValue(activeFilters, 'show');
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
  const { formatMoney, formatDate, today } = useWeldbooksFormat();
  const tv = t.weldbooksConnected.listViews;
  const tbp = t.accounting.billsPage;
  const tsl = t.accounting.statusLabels.bill as Record<string, string>;

  // The server filters on an `is` status; an `is not` one narrows the rows it sent.
  const loaded = applyExclusions((data?.rows ?? []) as unknown as BillRow[], activeFilters, { status: (bill) => bill.status });
  // Open and due leave out drafts, paid and cancelled bills (due: only overdue or due within a week). The server
  // has no such filter, so the rows loaded so far are narrowed and pages keep loading until the view has enough.
  const narrowed = show === 'open' || show === 'due';
  const bills = !narrowed
    ? loaded
    : loaded.filter((bill) => (show === 'due' ? isBillDue(bill, today()) : isOpenBill(bill)));
  useFillFilteredList({
    active: narrowed,
    shown: bills.length,
    hasMore: hasNextPage,
    isLoadingMore: isFetchingNextPage,
    loadMore: () => void fetchNextPage(),
  });
  const filterConfigs: FilterConfig[] = [
    { field: 'status', label: tbp.colStatus, options: BILL_STATUSES.map((value) => ({ value, label: tsl[value] ?? value })) },
    {
      field: 'show',
      label: tv.filterLabel,
      options: [
        { value: 'open', label: tv.open },
        { value: 'due', label: tv.dueSoon },
      ],
    },
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
      width: 'hidden shrink-0 @lg/list:flex w-[220px]',
      render: (bill) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusChip status={bill.status}>{tsl[bill.status] ?? bill.status}</StatusChip>
          <PaymentPendingChip billId={bill.id} status={bill.status} />
        </span>
      ),
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
      onFiltersChange={onFiltersChange}
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
