/**
 * Invoices and Bills tabs of the contact panel: the contact's documents, newest first, a page at a
 * time. A row opens that invoice or bill as a stacked object panel (the back arrow returns here).
 *
 * With the contact page (edition feature `books-contact-page`) the two tabs read the contact's own
 * paged routes (`/accounting-contacts/:id/invoices|bills?page&pageSize`) and offer the views the
 * page's tiles open: all, open and overdue. Without it they read the lists filtered by contact.
 */

import { useMemo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { SegmentedControl } from '@weldsuite/ui/components/segmented-control';
import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useObjectPanel } from '@/components/object-panel';
import { useInfiniteAccountingBills, useInfiniteAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import { useInfiniteQuotes } from '@/hooks/queries/use-weldbooks-sales-queries';
import {
  isContactPageAvailable,
  useContactBillsPaged,
  useContactInvoicesPaged,
} from '@/hooks/queries/use-weldbooks-contact-page-queries';
import { QuoteStatusChip } from '@/components/objects/quote/quote-parts';
import { useI18n } from '@/lib/i18n/provider';
import { daysOverdue } from '@/lib/weldbooks/invoice-activity';
import { isOpenBill, isOpenInvoice, useFillFilteredList } from '@/lib/weldbooks/list-views';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** The part of an invoice or a bill a row shows. */
interface DocumentRow {
  id: string;
  /** Invoice or bill number; none while it is a draft without one. */
  number: string | null;
  status: string;
  issueDate: string;
  total: string | null;
  currency: string | null;
  balanceDue: string | null;
  dueDate: string | null;
  creditNote: boolean;
}

/** The views of the Invoices and Bills tabs; the contact page's tiles open them. */
export type ContactDocumentView = 'all' | 'open' | 'overdue';

/** Whether a row belongs to a view: open waits for money, overdue is open and past its due date. */
function inView(kind: 'invoice' | 'bill', row: DocumentRow, view: ContactDocumentView): boolean {
  if (view === 'all') return true;
  const open = (kind === 'invoice' ? isOpenInvoice(row) : isOpenBill(row)) && !row.creditNote;
  if (view === 'open') return open;
  return open && daysOverdue({ status: row.status, balanceDue: row.balanceDue, dueDate: row.dueDate ?? '' }) > 0;
}

function DocumentViewControl({
  kind,
  view,
  onChange,
}: Readonly<{ kind: 'invoice' | 'bill'; view: ContactDocumentView; onChange: (view: ContactDocumentView) => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.documents;
  const options = [
    { value: 'all' as const, label: copy.filterAll },
    { value: 'open' as const, label: copy.filterOpen },
    // A bill that is overdue is shown with the open ones: only invoices have the extra view.
    ...(kind === 'invoice' ? [{ value: 'overdue' as const, label: copy.filterOverdue }] : []),
  ];
  return (
    <div className="flex items-center gap-2 px-4 pb-2 pt-3">
      <span className="text-xs text-muted-foreground">{copy.filterLabel}</span>
      <SegmentedControl options={options} value={view} onChange={onChange} ariaLabel={copy.filterLabel} />
    </div>
  );
}

function DocumentList({
  kind,
  rows,
  statusLabels,
  isLoading,
  isError,
  hasMore,
  isLoadingMore,
  onLoadMore,
  view,
  onViewChange,
  totalCount,
}: Readonly<{
  kind: 'invoice' | 'bill';
  rows: DocumentRow[];
  statusLabels: Record<string, string>;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  /** The views shown above the rows (the contact page); left out, there are none. */
  view?: ContactDocumentView;
  onViewChange?: (view: ContactDocumentView) => void;
  /** How many documents the contact has in all, when the list knows. */
  totalCount?: number;
}>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts.connected;
  const tp = t.weldbooksContactPage.documents;
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const { open: openPanel } = useObjectPanel();

  if (isError && rows.length === 0) {
    return <div className="p-4 text-sm text-destructive">{tc.loadFailed}</div>;
  }
  if (isLoading) {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-9 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }
  const control =
    view && onViewChange ? <DocumentViewControl kind={kind} view={view} onChange={onViewChange} /> : null;
  if (rows.length === 0 && !hasMore) {
    return (
      <>
        {control}
        <p className="p-6 text-center text-sm text-muted-foreground">
          {kind === 'invoice' ? tc.noInvoices : tc.noBills}
        </p>
      </>
    );
  }

  return (
    <TabListScope>
      {control}
      <div className="border-t border-gray-200/70 dark:border-border">
        {rows.map((row) => {
          const number = row.number ?? '—';
          return (
            <TabListRow
              key={row.id}
              label={number}
              onOpen={() => openPanel({ type: kind, id: row.id, stack: true })}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-sm font-medium">{number}</span>
                {row.creditNote ? (
                  <span className="flex-shrink-0 text-xs text-muted-foreground">{tc.creditNote}</span>
                ) : null}
                <span className="flex-shrink-0">
                  <StatusChip status={row.status}>{statusLabels[row.status] ?? row.status}</StatusChip>
                </span>
              </div>
              <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-sm tabular-nums @max-[440px]:hidden">
                {formatDate(row.issueDate)}
              </span>
              <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">
                {row.creditNote ? '-' : ''}
                {formatMoney(row.total ?? '0', row.currency)}
              </span>
            </TabListRow>
          );
        })}
      </div>
      {hasMore || totalCount !== undefined ? (
        <div className="flex flex-col items-center gap-1 p-3">
          {totalCount !== undefined ? (
            <p className="text-xs text-muted-foreground">
              {tp.showingOf.replace('{shown}', String(rows.length)).replace('{total}', String(totalCount))}
            </p>
          ) : null}
          {hasMore ? (
            <Button variant="outline" size="sm" onClick={onLoadMore} disabled={isLoadingMore}>
              {isLoadingMore ? t.accounting.contacts.pickerSearching : tc.loadMore}
            </Button>
          ) : null}
        </div>
      ) : null}
    </TabListScope>
  );
}

interface DocumentsTabProps {
  contactId: string;
  view?: ContactDocumentView;
  onViewChange?: (view: ContactDocumentView) => void;
}

export function ContactInvoicesTab({ contactId, view = 'all', onViewChange }: Readonly<DocumentsTabProps>) {
  const { t } = useI18n();
  const paged = isContactPageAvailable();
  const old = useInfiniteAccountingInvoices({ contactId }, { enabled: !paged });
  const next = useContactInvoicesPaged(contactId, { enabled: paged });
  const query = paged ? next : old;
  const activeView = paged ? view : 'all';
  const rows = useMemo(
    () =>
      (query.data?.rows ?? [])
        .map(
          (invoice): DocumentRow => ({
            id: invoice.id,
            number: invoice.invoiceNumber,
            status: invoice.status,
            issueDate: invoice.issueDate,
            total: invoice.total,
            currency: invoice.currency,
            balanceDue: invoice.balanceDue,
            dueDate: invoice.dueDate,
            creditNote: invoice.type === 'credit_note',
          }),
        )
        .filter((row) => inView('invoice', row, activeView)),
    [query.data?.rows, activeView],
  );
  // A narrowed view can leave a loaded page nearly empty: load on until it has rows or the list ends.
  useFillFilteredList({
    active: activeView !== 'all',
    shown: rows.length,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  });
  return (
    <DocumentList
      kind="invoice"
      rows={rows}
      statusLabels={t.accounting.statusLabels.invoice as Record<string, string>}
      isLoading={query.isLoading}
      isError={query.isError}
      hasMore={query.hasNextPage}
      isLoadingMore={query.isFetchingNextPage}
      onLoadMore={() => void query.fetchNextPage()}
      view={paged ? activeView : undefined}
      onViewChange={paged ? onViewChange : undefined}
      totalCount={paged && activeView === 'all' ? query.data?.totalCount : undefined}
    />
  );
}

export function ContactBillsTab({ contactId, view = 'all', onViewChange }: Readonly<DocumentsTabProps>) {
  const { t } = useI18n();
  const paged = isContactPageAvailable();
  const old = useInfiniteAccountingBills({ contactId }, { enabled: !paged });
  const next = useContactBillsPaged(contactId, { enabled: paged });
  const query = paged ? next : old;
  const activeView = paged ? view : 'all';
  const rows = useMemo(
    () =>
      (query.data?.rows ?? [])
        .map(
          (bill): DocumentRow => ({
            id: bill.id,
            number: bill.billNumber,
            status: bill.status,
            issueDate: bill.issueDate,
            total: bill.total,
            currency: bill.currency,
            balanceDue: bill.balanceDue,
            dueDate: bill.dueDate,
            creditNote: bill.type === 'credit_note',
          }),
        )
        .filter((row) => inView('bill', row, activeView)),
    [query.data?.rows, activeView],
  );
  useFillFilteredList({
    active: activeView !== 'all',
    shown: rows.length,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  });
  return (
    <DocumentList
      kind="bill"
      rows={rows}
      statusLabels={t.accounting.statusLabels.bill as Record<string, string>}
      isLoading={query.isLoading}
      isError={query.isError}
      hasMore={query.hasNextPage}
      isLoadingMore={query.isFetchingNextPage}
      onLoadMore={() => void query.fetchNextPage()}
      view={paged ? activeView : undefined}
      onViewChange={paged ? onViewChange : undefined}
      totalCount={paged && activeView === 'all' ? query.data?.totalCount : undefined}
    />
  );
}

/** The contact's quotes (edition feature `books-quotes`), newest first, a page at a time. A row opens the quote panel. */
export function ContactQuotesTab({ contactId }: Readonly<{ contactId: string }>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts.connected;
  const copy = t.weldbooksSales.quotes;
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const { open: openPanel } = useObjectPanel();
  const query = useInfiniteQuotes({ contactId });
  const rows = query.data?.rows ?? [];

  if (query.isError && rows.length === 0) return <div className="p-4 text-sm text-destructive">{copy.loadFailed}</div>;
  if (query.isLoading) {
    return (
      <div className="space-y-2 p-4" aria-busy="true">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-9 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) return <p className="p-6 text-center text-sm text-muted-foreground">{copy.contactEmpty}</p>;

  return (
    <TabListScope>
      <div className="border-t border-gray-200/70 dark:border-border">
        {rows.map((row) => {
          const label = row.quoteNumber ?? row.name ?? copy.fallbackName;
          return (
            <TabListRow key={row.id} label={label} onOpen={() => openPanel({ type: 'quote', id: row.id, stack: true })}>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-sm font-medium">{label}</span>
                <span className="flex-shrink-0">
                  <QuoteStatusChip status={row.status} />
                </span>
              </div>
              <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-sm tabular-nums @max-[440px]:hidden">
                {formatDate(row.validUntil)}
              </span>
              <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">{formatMoney(row.total ?? '0', row.currency)}</span>
            </TabListRow>
          );
        })}
      </div>
      {query.hasNextPage ? (
        <div className="flex justify-center p-3">
          <Button variant="outline" size="sm" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage ? t.accounting.contacts.pickerSearching : tc.loadMore}
          </Button>
        </div>
      ) : null}
    </TabListScope>
  );
}
