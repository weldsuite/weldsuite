/**
 * The pieces of the quote panel: the title with its status, the Details tab
 * (figures, who, validity, the timeline and the invoices made from the quote)
 * and the Lines tab.
 */

import {
  Banknote,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  Eye,
  FilePlus2,
  Mail,
  Receipt,
  ScrollText,
  StickyNote,
  User,
} from 'lucide-react';
import { ActivityTimeline, type ActivityTimelineItem } from '@weldsuite/ui/components/activity-timeline';
import { CopyButton } from '@weldsuite/ui/components/copy-button';
import { StatusChip } from '@/components/accounting/weldbooks-row-cells';
import { RecordLink } from '@/components/object-panel/record-link';
import { PanelRow, PanelSection } from '@/components/objects/_shared/record-panel-parts';
import { usePublicLink } from '@/hooks/queries/use-weldbooks-contact-page-queries';
import type { QuoteDetail } from '@/lib/api/domains/weldbooks-sales';
import { useI18n } from '@/lib/i18n/provider';
import { quoteTone } from '@/lib/weldbooks/quote-status';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

export function useQuoteStatusLabel(): (status: string) => string {
  const { t } = useI18n();
  const labels = t.weldbooksSales.quotes.status as Readonly<Record<string, string>>;
  return (status) => labels[status] ?? status;
}

export function QuoteStatusChip({ status }: Readonly<{ status: string }>) {
  const label = useQuoteStatusLabel();
  return <StatusChip tone={quoteTone(status)}>{label(status)}</StatusChip>;
}

export function QuoteTitle({ quote }: Readonly<{ quote?: QuoteDetail }>) {
  const { t } = useI18n();
  if (!quote) return <div className="h-4 w-32 animate-pulse rounded bg-muted" />;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="relative top-px truncate text-[15px] font-medium text-foreground">
        {quote.quoteNumber ?? quote.name ?? t.weldbooksSales.quotes.fallbackName}
      </span>
      <span className="flex-shrink-0">
        <QuoteStatusChip status={quote.status} />
      </span>
    </div>
  );
}

function useQuoteTimeline(quote: QuoteDetail): ActivityTimelineItem[] {
  const { t } = useI18n();
  const copy = t.weldbooksSales.quotes.timeline;
  const { formatDateTime } = useWeldbooksFormat();
  const events: Array<{ at: string; item: ActivityTimelineItem }> = [];
  const add = (at: string | null | undefined, item: Omit<ActivityTimelineItem, 'time' | 'dateTime'>) => {
    if (at) events.push({ at, item: { ...item, time: formatDateTime(at), dateTime: at } });
  };
  add(quote.createdAt, { id: 'created', icon: FilePlus2, title: copy.created });
  add(quote.sentAt, { id: 'sent', icon: Mail, tone: 'info', title: copy.sent });
  add(quote.viewedAt, { id: 'viewed', icon: Eye, tone: 'info', title: copy.viewed });
  add(quote.acceptedAt ?? quote.signedAt, {
    id: 'accepted',
    icon: CheckCircle2,
    tone: 'success',
    title: quote.signedBy ? copy.acceptedBy.replace('{name}', quote.signedBy) : copy.accepted,
  });
  for (const invoice of quote.invoices) {
    add(invoice.issueDate, {
      id: `invoice-${invoice.id}`,
      icon: Receipt,
      title: copy.invoiceMade.replace('{number}', invoice.invoiceNumber ?? t.weldbooksSales.quotes.draftInvoice),
    });
  }
  return events.sort((a, b) => a.at.localeCompare(b.at)).map((event) => event.item);
}

/**
 * The quote's online link, read from the server (`GET /accounting-quotes/:id/public-link`) so "Copy link" works any
 * time and in any browser, not only after a send in this one.
 */
function QuoteOnlineLink({ quoteId, sent }: Readonly<{ quoteId: string; sent: boolean }>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage.link;
  const query = usePublicLink('quote', quoteId, { enabled: sent });
  const url = query.data ?? null;
  return (
    <PanelSection title={copy.quoteTitle}>
      <div className="space-y-2" data-testid="quote-online-link">
        <p className="text-[13px] text-muted-foreground">{url ? copy.quoteActive : copy.quoteNone}</p>
        {url ? <CopyButton value={url} label={copy.copy} showLabel copiedLabel={copy.copied} failedLabel={copy.copyFailed} /> : null}
      </div>
    </PanelSection>
  );
}

function invoiceTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'paid') return 'success';
  return status === 'overdue' ? 'warning' : 'neutral';
}

export function QuoteDetailsTab({ quote }: Readonly<{ quote: QuoteDetail }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.quotes;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const timeline = useQuoteTimeline(quote);
  const invoiceStatus = t.accounting.statusLabels.invoice as Readonly<Record<string, string>>;
  return (
    <div className="space-y-5 p-4">
      <div className="space-y-1">
        <PanelRow icon={Banknote} label={copy.total} value={formatMoney(quote.total, quote.currency)} />
        <PanelRow
          icon={User}
          label={copy.contact}
          value={quote.contactName}
          renderValue={(name) =>
            quote.contactId ? <RecordLink type="weldbooks_contact" id={quote.contactId} label={name ?? ''} /> : <span>{name}</span>
          }
        />
        <PanelRow icon={CalendarClock} label={copy.validUntil} value={quote.validUntil ? formatDate(quote.validUntil) : null} tabular />
        <PanelRow icon={CalendarDays} label={copy.paymentTerms} value={quote.paymentTerms} />
        {quote.notes ? <PanelRow icon={StickyNote} label={copy.notes} value={quote.notes} /> : null}
        {quote.termsAndConditions ? <PanelRow icon={ScrollText} label={copy.terms} value={quote.termsAndConditions} /> : null}
      </div>

      {quote.invoices.length > 0 ? (
        <PanelSection title={copy.invoicesMade}>
          <div className="flex flex-wrap gap-1.5" data-testid="quote-invoices">
            {quote.invoices.map((invoice) => (
              <RecordLink
                key={invoice.id}
                type="invoice"
                id={invoice.id}
                label={invoice.invoiceNumber ?? copy.draftInvoice}
                secondary={formatMoney(invoice.total, invoice.currency)}
                statusLabel={invoiceStatus[invoice.status] ?? invoice.status}
                tone={invoiceTone(invoice.status)}
              />
            ))}
          </div>
        </PanelSection>
      ) : null}

      <QuoteOnlineLink quoteId={quote.id} sent={Boolean(quote.sentAt)} />

      <PanelSection title={copy.timeline.title}>
        <ActivityTimeline label={copy.timeline.title} items={timeline} />
      </PanelSection>
    </div>
  );
}

export function QuoteLinesTab({ quote }: Readonly<{ quote: QuoteDetail }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.quotes;
  const { formatMoney, formatNumber } = useWeldbooksFormat();
  if (quote.lines.length === 0) return <p className="p-6 text-center text-sm text-muted-foreground">{copy.noLines}</p>;
  return (
    <div className="space-y-4 p-4">
      <ul className="m-0 list-none divide-y divide-border p-0" aria-label={copy.lines}>
        {quote.lines.map((line, index) => (
          <li key={line.id ?? index} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-pretty">{line.description}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatNumber(line.quantity ?? 1)} × {formatMoney(line.unitPrice, quote.currency)}
                {Number(line.discountPercent ?? 0) > 0 ? ` · −${formatNumber(line.discountPercent)}%` : ''}
                {Number(line.taxRate ?? 0) > 0 ? ` · ${formatNumber(line.taxRate)}%` : ''}
              </p>
            </div>
            <span className="shrink-0 text-sm tabular-nums">{formatMoney(line.lineTotal ?? 0, quote.currency)}</span>
          </li>
        ))}
      </ul>
      <dl className="ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm tabular-nums">
        <dt className="text-muted-foreground">{copy.subtotal}</dt>
        <dd className="text-right">{formatMoney(quote.subtotal, quote.currency)}</dd>
        {Number(quote.discount ?? 0) > 0 ? (
          <>
            <dt className="text-muted-foreground">{copy.discount}</dt>
            <dd className="text-right">−{formatMoney(quote.discount, quote.currency)}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{copy.tax}</dt>
        <dd className="text-right">{formatMoney(quote.tax, quote.currency)}</dd>
        <dt className="font-semibold">{copy.total}</dt>
        <dd className="text-right font-semibold">{formatMoney(quote.total, quote.currency)}</dd>
      </dl>
    </div>
  );
}
