/**
 * The Connections strip of the invoice panel: the chain the invoice sits in,
 * quote → this invoice → payments → bank lines. Every step is a record chip:
 * the quote and the bank lines stack their panels, a payment opens the
 * Payments tab. Shown only when there is something to connect.
 */

import { ChevronRight } from 'lucide-react';
import { RecordChip } from '@weldsuite/ui/components/record-chip';
import { RecordLink } from '@/components/object-panel/record-link';
import { isQuotesAvailable, useQuote } from '@/hooks/queries/use-weldbooks-sales-queries';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

/** The number of the quote an invoice was made from, or null while it loads or where quotes are not offered. */
export function useQuoteNumber(quoteId: string | null | undefined): string | null {
  const quote = useQuote(quoteId ?? '');
  return quote.data?.quoteNumber ?? quote.data?.name ?? null;
}

function Arrow() {
  return <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}

function Step({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">{children}</div>
    </li>
  );
}

export function InvoiceConnections({
  invoice,
  onOpenPayments,
}: Readonly<{ invoice: InvoiceWithTax; onOpenPayments: () => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.connections;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const quoteId = isQuotesAvailable() ? invoice.quoteId : null;
  const quoteNumber = useQuoteNumber(quoteId);
  const payments = invoice.payments ?? [];
  const bankLines = payments.filter((payment) => payment.bankTransactionId);

  if (!quoteId && payments.length === 0) return null;

  return (
    <nav aria-label={copy.title} data-testid="invoice-connections">
      <ol className="m-0 flex list-none flex-wrap items-start gap-x-2 gap-y-3 rounded-lg border border-border p-3">
        {quoteId ? (
          <>
            <Step label={copy.quote}>
              <RecordLink type="quote" id={quoteId} label={quoteNumber ?? copy.quoteFallback} />
            </Step>
            <li aria-hidden className="mt-5">
              <Arrow />
            </li>
          </>
        ) : null}
        <Step label={copy.thisInvoice}>
          <span className="inline-flex min-h-6 items-center rounded-md border border-primary/40 bg-primary/5 px-1.5 py-0.5 text-[13px] font-medium" aria-current="true">
            {invoice.invoiceNumber ?? copy.thisInvoice}
          </span>
        </Step>
        {payments.length > 0 ? (
          <>
            <li aria-hidden className="mt-5">
              <Arrow />
            </li>
            <Step label={copy.payments}>
              {payments.map((payment) => (
                <RecordChip
                  key={payment.id}
                  label={formatMoney(payment.amount, invoice.currency)}
                  secondary={formatDate(payment.date)}
                  tone="success"
                  statusLabel={copy.payment}
                  onOpen={onOpenPayments}
                />
              ))}
            </Step>
          </>
        ) : null}
        {bankLines.length > 0 ? (
          <>
            <li aria-hidden className="mt-5">
              <Arrow />
            </li>
            <Step label={copy.bankLine}>
              {bankLines.map((payment) => (
                <RecordLink
                  key={payment.id}
                  type="bank_transaction"
                  id={payment.bankTransactionId ?? ''}
                  label={formatMoney(payment.amount, invoice.currency)}
                  secondary={formatDate(payment.date)}
                />
              ))}
            </Step>
          </>
        ) : null}
      </ol>
    </nav>
  );
}
