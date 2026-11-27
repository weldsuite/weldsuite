import { useState } from 'react';
import { useInfiniteAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import { ReceiptText } from 'lucide-react';
import { useRouter } from '@/lib/router';
import { EmptyStateIllustration, type ColumnDef, type FilterConfig, type GroupConfig } from '@/components/entity-list';
import { useObjectPanel, useObjectPanelUrlSync } from '@/components/object-panel';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { ContactCell, RowAmount, RowDate, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { applyExclusions, pillValue } from '@/lib/weldbooks/list-filters';
import { INVOICE_VIEWS, isOpenInvoice, useFillFilteredList } from '@/lib/weldbooks/list-views';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useUrlPillFilters } from '@/lib/weldbooks/use-url-pill-filters';

/** The statuses the Status filter offers, in the order an invoice moves through them. */
const INVOICE_STATUSES = ['draft', 'finalized', 'sent', 'partial', 'overdue', 'paid', 'cancelled', 'uncollectible'] as const;

/** The filters the address carries: `?status=overdue`, `?show=open`. */
const URL_FILTER_FIELDS = ['status', 'show'] as const;
const URL_FILTER_VALUES = { status: INVOICE_STATUSES, show: INVOICE_VIEWS };

interface InvoiceRow {
  id: string;
  invoiceNumber: string | null;
  contactName: string | null;
  contactId?: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  total?: string | number | null;
  currency?: string | null;
  status: string;
}

export default function InvoicesPage() {
  const [search, setSearch] = useState('');
  // The Status and Show filters live in the address, so a link from To process or the
  // overview opens the list already filtered and the filter survives navigation.
  const { activeFilters, onFiltersChange } = useUrlPillFilters(URL_FILTER_FIELDS, URL_FILTER_VALUES);
  const show = pillValue(activeFilters, 'show');
  const router = useRouter();
  // A new invoice is written on its own page, next to a live preview of the PDF.
  const newInvoice = () => router.push('/weldbooks/invoices/add');
  // `type=invoice` is every invoice that is not a credit note; Show → Credit notes lists those instead.
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteAccountingInvoices({
    type: show === 'credit_notes' ? 'credit_note' : 'invoice',
    search,
    status: pillValue(activeFilters, 'status'),
    overdue: show === 'overdue' ? 'true' : undefined,
  });
  // Each invoice opens in the shared object panel (type 'invoice'), the same
  // panel/fullscreen shell as WeldCRM companies, synced to `?stack=`.
  const { open: openPanel } = useObjectPanel();
  useObjectPanelUrlSync('/weldbooks/invoices');
  const { t } = useI18n();
  const st = useTranslations();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const tip = t.accounting.invoicesPage;
  const tsl = t.accounting.statusLabels.invoice;
  const tv = t.weldbooksConnected.listViews;
  const { labels } = useJurisdictionLabels();

  // The server filters on an `is` status; an `is not` one narrows the rows it sent.
  const loaded = applyExclusions((data?.rows ?? []) as unknown as InvoiceRow[], activeFilters, { status: (inv) => inv.status });
  // Open and overdue leave out drafts, paid and cancelled invoices: the server has no such filter, so the
  // rows loaded so far are narrowed and pages keep loading until the view has enough.
  const narrowed = show === 'open' || show === 'overdue';
  const invoices = narrowed ? loaded.filter(isOpenInvoice) : loaded;
  useFillFilteredList({
    active: narrowed,
    shown: invoices.length,
    hasMore: hasNextPage,
    isLoadingMore: isFetchingNextPage,
    loadMore: () => void fetchNextPage(),
  });
  const filterConfigs: FilterConfig[] = [
    { field: 'status', label: tip.colStatus, options: INVOICE_STATUSES.map((value) => ({ value, label: tsl[value] })) },
    {
      field: 'show',
      label: tv.filterLabel,
      options: [
        { value: 'open', label: tv.open },
        { value: 'overdue', label: tv.overdue },
        { value: 'credit_notes', label: labels.creditNotes },
      ],
    },
  ];

  // Group by lifecycle status, most-urgent first. The trailing "other" group is
  // an explicit catch-all: EntityList drops items matching no group, so any
  // status outside the known set (e.g. cancelled/void) stays visible here.
  const knownStatuses = new Set(['overdue', 'finalized', 'sent', 'partial', 'draft', 'paid']);
  const groups: GroupConfig<InvoiceRow>[] = [
    { id: 'overdue', label: tip.groupOverdue, sortOrder: 1, filter: (i) => i.status === 'overdue' },
    { id: 'finalized', label: tip.groupFinalized, sortOrder: 2, filter: (i) => i.status === 'finalized' },
    { id: 'sent', label: tip.groupSent, sortOrder: 2, filter: (i) => i.status === 'sent' },
    {
      id: 'partial',
      label: st('sweep.weldbooks.records.groupPartiallyPaid'),
      sortOrder: 3,
      filter: (i) => i.status === 'partial',
    },
    { id: 'draft', label: tip.groupDraft, sortOrder: 4, filter: (i) => i.status === 'draft' },
    { id: 'paid', label: tip.groupPaid, sortOrder: 5, filter: (i) => i.status === 'paid' },
    { id: 'other', label: tip.groupOther, sortOrder: 6, filter: (i) => !knownStatuses.has(i.status) },
  ];

  const columns: ColumnDef<InvoiceRow>[] = [
    {
      id: 'number',
      header: tip.colNumber,
      width: 'min-w-0 flex-1 gap-2 @2xl/list:min-w-[200px]',
      render: (inv) => <RowTitle>{inv.invoiceNumber ?? '—'}</RowTitle>,
    },
    {
      id: 'contact',
      header: tip.colContact,
      width: 'hidden shrink-0 @4xl/list:flex w-[200px]',
      render: (inv) => <ContactCell name={inv.contactName} contactId={inv.contactId} />,
    },
    {
      id: 'issueDate',
      header: tip.colDate,
      width: 'hidden shrink-0 @4xl/list:flex w-[120px]',
      render: (inv) => <RowDate>{formatDate(inv.issueDate)}</RowDate>,
    },
    {
      id: 'dueDate',
      header: tip.colDueDate,
      width: 'hidden shrink-0 @6xl/list:flex w-[120px]',
      render: (inv) => <RowDate>{formatDate(inv.dueDate)}</RowDate>,
    },
    {
      id: 'total',
      header: tip.colTotal,
      width: 'shrink-0 w-[130px]',
      render: (inv) => <RowAmount>{formatMoney(inv.total ?? inv.totalAmount, inv.currency)}</RowAmount>,
    },
    {
      id: 'status',
      header: tip.colStatus,
      width: 'shrink-0 w-[110px]',
      render: (inv) => <StatusChip status={inv.status}>{tsl[inv.status as keyof typeof tsl] ?? inv.status}</StatusChip>,
    },
  ];

  return (
    <WeldbooksEntityList<InvoiceRow>
      items={invoices}
      isLoading={isLoading}
      columns={columns}
      groups={groups}
      hasMore={hasNextPage}
      isLoadingMore={isFetchingNextPage}
      onLoadMore={() => void fetchNextPage()}
      onRowClick={(inv) => openPanel({ type: 'invoice', id: inv.id })}
      getRowLabel={(inv) => inv.invoiceNumber ?? tip.colNumber}
      filters={filterConfigs}
      activeFilters={activeFilters}
      onFiltersChange={onFiltersChange}
      searchQuery={search}
      onSearchChange={setSearch}
      searchPlaceholder={tip.searchPlaceholder}
      createButton={{
        label: tip.newInvoice,
        onClick: newInvoice,
      }}
      emptyState={{
        icon: (
          <EmptyStateIllustration>
            <ReceiptText className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
          </EmptyStateIllustration>
        ),
        title: tip.noInvoices,
        description: tip.emptyDescription,
        action: {
          label: tip.newInvoice,
          onClick: newInvoice,
        },
      }}
    />
  );
}
