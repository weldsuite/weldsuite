/**
 * Invoices and Bills tabs of the contact panel: the contact's documents, newest first, a page at a
 * time. A row opens that invoice or bill as a stacked object panel (the back arrow returns here).
 */

import { Button } from '@weldsuite/ui/components/button';
import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useObjectPanel } from '@/components/object-panel';
import { useInfiniteAccountingBills, useInfiniteAccountingInvoices } from '@/hooks/queries/use-accounting-queries';
import { useInfiniteQuotes } from '@/hooks/queries/use-weldbooks-sales-queries';
import { QuoteStatusChip } from '@/components/objects/quote/quote-parts';
import { useI18n } from '@/lib/i18n/provider';
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
  creditNote: boolean;
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
}: Readonly<{
  kind: 'invoice' | 'bill';
  rows: DocumentRow[];
  statusLabels: Record<string, string>;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts.connected;
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
  if (rows.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        {kind === 'invoice' ? tc.noInvoices : tc.noBills}
      </p>
    );
  }

  return (
    <TabListScope>
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
      {hasMore ? (
        <div className="flex justify-center p-3">
          <Button variant="outline" size="sm" onClick={onLoadMore} disabled={isLoadingMore}>
            {isLoadingMore ? t.accounting.contacts.pickerSearching : tc.loadMore}
          </Button>
        </div>
      ) : null}
    </TabListScope>
  );
}

export function ContactInvoicesTab({ contactId }: Readonly<{ contactId: string }>) {
  const { t } = useI18n();
  const query = useInfiniteAccountingInvoices({ contactId });
  const rows = (query.data?.rows ?? []).map(
    (invoice): DocumentRow => ({
      id: invoice.id,
      number: invoice.invoiceNumber,
      status: invoice.status,
      issueDate: invoice.issueDate,
      total: invoice.total,
      currency: invoice.currency,
      creditNote: invoice.type === 'credit_note',
    }),
  );
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
    />
  );
}

export function ContactBillsTab({ contactId }: Readonly<{ contactId: string }>) {
  const { t } = useI18n();
  const query = useInfiniteAccountingBills({ contactId });
  const rows = (query.data?.rows ?? []).map(
    (bill): DocumentRow => ({
      id: bill.id,
      number: bill.billNumber,
      status: bill.status,
      issueDate: bill.issueDate,
      total: bill.total,
      currency: bill.currency,
      creditNote: bill.type === 'credit_note',
    }),
  );
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
