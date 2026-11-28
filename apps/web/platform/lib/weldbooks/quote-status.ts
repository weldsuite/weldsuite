import type { QuoteDetail, QuoteStatus } from '@/lib/api/domains/weldbooks-sales';
import { QUOTE_STATUSES } from '@/lib/api/domains/weldbooks-sales';
import type { ChipTone } from '@/components/accounting/weldbooks-row-cells';

/** The chip colour of each quote status. */
export const QUOTE_STATUS_TONES: Readonly<Record<QuoteStatus, ChipTone>> = {
  draft: 'gray',
  sent: 'blue',
  accepted: 'green',
  declined: 'red',
  expired: 'amber',
  invoiced: 'purple',
};

export function isQuoteStatus(value: string): value is QuoteStatus {
  return (QUOTE_STATUSES as readonly string[]).includes(value);
}

export function quoteTone(status: string): ChipTone {
  return isQuoteStatus(status) ? QUOTE_STATUS_TONES[status] : 'gray';
}

/** A quote that was accepted or invoiced is a contract: the server refuses an edit (409). */
export function canEditQuote(quote: Pick<QuoteDetail, 'status'>): boolean {
  return quote.status !== 'accepted' && quote.status !== 'invoiced';
}

/** An invoice can be made from a quote the customer has not turned down and that has not run out. */
export function canInvoiceQuote(quote: Pick<QuoteDetail, 'status'>): boolean {
  return quote.status !== 'declined' && quote.status !== 'expired';
}

/** What is left to invoice of a quote, as a percentage, from the invoices already made (their subtotals against the quote's). */
export function shareLeft(quote: Pick<QuoteDetail, 'subtotal' | 'invoices'>): number {
  const total = Number(quote.subtotal ?? 0);
  if (Number.isNaN(total) || total <= 0) return 100;
  const invoiced = quote.invoices
    .filter((invoice) => invoice.type !== 'credit_note' && invoice.status !== 'cancelled')
    .reduce((sum, invoice) => sum + Number(invoice.subtotal ?? 0), 0);
  return Math.max(0, Math.min(100, Math.round((1 - invoiced / total) * 100)));
}
