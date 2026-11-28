/**
 * The Overview tab of the contact page (edition feature `books-contact-page`): what is open with
 * the contact right now (invoices, sent quotes, bills, hours not invoiced), then everything that
 * happened with them by date, a page at a time. Every item is a link that stacks that record's
 * panel; an inbox document opens the inbox on it.
 */

import { useMemo, type ComponentType, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  Banknote,
  BellRing,
  Eye,
  FileMinus,
  FileSearch,
  FileText,
  Receipt,
  ReceiptText,
  ScrollText,
  Send,
  MailWarning,
  Hourglass,
} from 'lucide-react';
import { ActivityTimeline, type ActivityTimelineItem } from '@weldsuite/ui/components/activity-timeline';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Link } from '@/lib/router';
import { RecordLink } from '@/components/object-panel/record-link';
import { useI18n } from '@/lib/i18n/provider';
import { useInfiniteQuotes } from '@/hooks/queries/use-weldbooks-sales-queries';
import {
  useContactBillsPaged,
  useContactInvoicesPaged,
  useContactSummary,
  useContactTimeline,
} from '@/hooks/queries/use-weldbooks-contact-page-queries';
import type { TimelineItem, TimelineType } from '@/lib/api/domains/weldbooks-contact-page';
import { reminderLevel, timelineTone } from '@/lib/weldbooks/contact-page';
import { isOpenBill, isOpenInvoice } from '@/lib/weldbooks/list-views';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { isQuotesAvailable } from '@/hooks/queries/use-weldbooks-sales-queries';

const TYPE_ICONS: Record<TimelineType, ComponentType<{ className?: string }>> = {
  quote: ScrollText,
  invoice: FileText,
  credit_note: FileMinus,
  bill: Receipt,
  receipt: ReceiptText,
  payment: Banknote,
  bank_line: ArrowLeftRight,
  document: FileSearch,
  email_sent: Send,
  email_viewed: Eye,
  reminder: BellRing,
  email_bounced: MailWarning,
};

/** How many open items of a kind the "Open now" list shows before the tab for it takes over. */
const OPEN_LIMIT = 5;

// ─── Open now ──────────────────────────────────────────────────────────────

function OpenRow({ chip, detail, amount }: Readonly<{ chip: ReactNode; detail?: string; amount?: string }>) {
  return (
    <li className="flex items-center gap-3 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2">{chip}</div>
        {detail ? <p className="mt-0.5 text-[13px] text-muted-foreground">{detail}</p> : null}
      </div>
      {amount ? <span className="flex-shrink-0 text-sm font-medium tabular-nums">{amount}</span> : null}
    </li>
  );
}

function OpenNow({
  contactId,
  showReceivable,
  showPayable,
  canSeeTime,
}: Readonly<{ contactId: string; showReceivable: boolean; showPayable: boolean; canSeeTime: boolean }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.overview;
  const { formatDate, formatMoney, formatNumber } = useWeldbooksFormat();
  const invoices = useContactInvoicesPaged(contactId, { enabled: showReceivable });
  const bills = useContactBillsPaged(contactId, { enabled: showPayable });
  const quotes = useInfiniteQuotes({ contactId, status: 'sent' }, { enabled: showReceivable });
  const summary = useContactSummary(contactId, { enabled: showReceivable && canSeeTime });

  const openInvoices = useMemo(
    () =>
      (invoices.data?.rows ?? [])
        .filter((invoice) => isOpenInvoice(invoice) && invoice.type !== 'credit_note')
        .slice(0, OPEN_LIMIT),
    [invoices.data?.rows],
  );
  const openBills = useMemo(
    () => (bills.data?.rows ?? []).filter((bill) => isOpenBill(bill) && bill.type !== 'credit_note').slice(0, OPEN_LIMIT),
    [bills.data?.rows],
  );
  const sentQuotes = useMemo(
    () => (isQuotesAvailable() ? (quotes.data?.rows ?? []).slice(0, OPEN_LIMIT) : []),
    [quotes.data?.rows],
  );
  const unbilled = summary.data?.unbilledHours;
  const hasUnbilled = Boolean(unbilled) && Number(unbilled?.hours) > 0;
  const loading = invoices.isLoading || bills.isLoading || quotes.isLoading;
  const empty = !loading && openInvoices.length + openBills.length + sentQuotes.length === 0 && !hasUnbilled;

  return (
    <section aria-labelledby="contact-open-now" className="px-4 pt-2">
      <h3 id="contact-open-now" className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {copy.openNow}
      </h3>
      {loading ? (
        <InlineSpinner className="py-4" />
      ) : empty ? (
        <p className="py-2 text-sm text-muted-foreground">{copy.nothingOpen}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {openInvoices.map((invoice) => (
            <OpenRow
              key={invoice.id}
              chip={
                <RecordLink
                  type="invoice"
                  id={invoice.id}
                  label={copy.invoiceTitle.replace('{number}', invoice.invoiceNumber ?? copy.noNumber)}
                  tone={invoice.status === 'overdue' ? 'danger' : 'neutral'}
                  statusLabel={(t.accounting.statusLabels.invoice as Record<string, string>)[invoice.status]}
                />
              }
              detail={copy.invoiceDue.replace('{date}', formatDate(invoice.dueDate))}
              amount={formatMoney(invoice.balanceDue ?? invoice.total ?? '0', invoice.currency)}
            />
          ))}
          {sentQuotes.map((quote) => (
            <OpenRow
              key={quote.id}
              chip={
                <RecordLink
                  type="quote"
                  id={quote.id}
                  label={copy.quoteTitle.replace('{number}', quote.quoteNumber ?? quote.name ?? copy.noNumber)}
                />
              }
              detail={[
                quote.sentAt ? copy.quoteSent.replace('{date}', formatDate(quote.sentAt)) : null,
                quote.validUntil ? copy.quoteValidUntil.replace('{date}', formatDate(quote.validUntil)) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              amount={formatMoney(quote.total ?? '0', quote.currency)}
            />
          ))}
          {openBills.map((bill) => (
            <OpenRow
              key={bill.id}
              chip={
                <RecordLink
                  type="bill"
                  id={bill.id}
                  label={copy.billFromThem.replace('{number}', bill.billNumber ?? copy.noNumber)}
                  tone={bill.status === 'overdue' ? 'danger' : 'neutral'}
                  statusLabel={(t.accounting.statusLabels.bill as Record<string, string>)[bill.status]}
                />
              }
              detail={copy.invoiceDue.replace('{date}', formatDate(bill.dueDate))}
              amount={formatMoney(bill.balanceDue ?? bill.total ?? '0', bill.currency)}
            />
          ))}
          {hasUnbilled && unbilled ? (
            <OpenRow
              chip={
                <>
                  <Hourglass className="size-4 text-muted-foreground" aria-hidden="true" />
                  <span className="text-sm font-medium">
                    {copy.unbilledTitle.replace('{hours}', formatNumber(unbilled.hours))}
                  </span>
                  <Link
                    href={`/weldbooks/time/unbilled?customerId=${encodeURIComponent(contactId)}`}
                    className="text-sm text-primary underline-offset-2 hover:underline"
                  >
                    {copy.createInvoice}
                  </Link>
                </>
              }
              amount={formatMoney(unbilled.amount, unbilled.currency)}
            />
          ) : null}
        </ul>
      )}
    </section>
  );
}

// ─── Timeline ──────────────────────────────────────────────────────────────

/** The words after the title: the subtitle, what the hint says, and the amount. */
function useTimelineWords() {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.timeline;
  const { formatMoney } = useWeldbooksFormat();
  return (item: TimelineItem): string => {
    const level = reminderLevel(item.hint);
    const hints = copy.hints as Record<string, string>;
    const documentTypes = copy.documentTypes as Record<string, string>;
    let hint: string | null = null;
    if (level !== null) hint = copy.hints.level.replace('{level}', String(level));
    else if (item.hint && hints[item.hint]) hint = hints[item.hint] ?? null;
    else if (item.hint && documentTypes[item.hint]) hint = documentTypes[item.hint] ?? null;
    const amount = item.amount ? formatMoney(item.amount, item.currency) : null;
    return [item.subtitle, hint, amount].filter(Boolean).join(' · ');
  };
}

function TimelineTitle({ item }: Readonly<{ item: TimelineItem }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.timeline;
  const typeLabel = copy.types[item.type];
  const label = item.title ?? typeLabel;
  let target: ReactNode = <span>{label}</span>;
  if (item.objectType === 'quote' || item.objectType === 'invoice' || item.objectType === 'bill') {
    target = <RecordLink type={item.objectType} id={item.objectId} label={label} />;
  } else if (item.objectType === 'bank_transaction') {
    target = <RecordLink type="bank_transaction" id={item.objectId} label={label} />;
  } else if (item.objectType === 'document') {
    target = (
      <Link
        href={`/weldbooks/documents?document=${encodeURIComponent(item.objectId)}`}
        className="text-primary underline-offset-2 hover:underline"
      >
        {label}
      </Link>
    );
  }
  // A payment has no page of its own: it reads as text and is on the document it settled.
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span>{typeLabel}</span>
      {target}
    </span>
  );
}

function ContactTimeline({ contactId, contactName }: Readonly<{ contactId: string; contactName: string }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.overview;
  const { formatDate } = useWeldbooksFormat();
  const words = useTimelineWords();
  const query = useContactTimeline(contactId);
  const entries = query.data?.items;

  const items = useMemo<ActivityTimelineItem[]>(
    () =>
      (entries ?? []).map((item) => ({
        id: `${item.type}:${item.objectId}:${item.date}`,
        title: <TimelineTitle item={item} />,
        description: words(item) || undefined,
        time: formatDate(item.date),
        dateTime: item.date,
        icon: TYPE_ICONS[item.type],
        tone: timelineTone(item),
      })),
    // `words` and `formatDate` change with the language and the formats, which is when the texts must be rebuilt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, t, formatDate],
  );

  return (
    <section aria-labelledby="contact-timeline" className="px-4 pb-6 pt-5">
      <h3 id="contact-timeline" className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {copy.everything.replace('{name}', contactName)}
      </h3>
      {query.isLoading ? (
        <InlineSpinner className="py-6" />
      ) : query.isError ? (
        <ErrorState message={copy.timelineFailed} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.timelineEmpty}</p>
      ) : (
        <>
          <ActivityTimeline items={items} label={copy.timelineLabel} />
          {query.hasNextPage ? (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void query.fetchNextPage()}
                disabled={query.isFetchingNextPage}
              >
                {query.isFetchingNextPage ? copy.loadingMore : copy.loadMore}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export function ContactOverviewTab({
  contactId,
  contactName,
  showReceivable,
  showPayable,
  canSeeTime,
}: Readonly<{
  contactId: string;
  contactName: string;
  showReceivable: boolean;
  showPayable: boolean;
  canSeeTime: boolean;
}>) {
  return (
    <div>
      <OpenNow
        contactId={contactId}
        showReceivable={showReceivable}
        showPayable={showPayable}
        canSeeTime={canSeeTime}
      />
      <ContactTimeline contactId={contactId} contactName={contactName} />
    </div>
  );
}
