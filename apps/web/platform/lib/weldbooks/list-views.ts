import { useEffect } from 'react';

/**
 * The views the Invoices and Bills lists open in from the owner's shortcuts
 * (To process, the overview tiles): `?show=open`, `?show=overdue`,
 * `?show=due` and, for invoices, `?show=credit_notes` and `?show=undelivered` (the last e-mail bounced,
 * edition feature `books-invoice-email`).
 *
 * A server filter narrows what it can (credit notes by type, overdue invoices
 * by `overdue=true`); the rest narrows the rows loaded so far with the
 * predicates below, and `useFillFilteredList` keeps loading pages until the
 * view has rows to show.
 */

/** The views of the Invoices list, in the order the Show filter offers them. */
export const INVOICE_VIEWS = ['open', 'overdue', 'credit_notes', 'undelivered'] as const;
export type InvoiceView = (typeof INVOICE_VIEWS)[number];

/** The views of the Bills list. */
export const BILL_VIEWS = ['open', 'due'] as const;
export type BillView = (typeof BILL_VIEWS)[number];

/** Statuses of an invoice that still waits for its money. */
const OPEN_INVOICE_STATUSES: ReadonlySet<string> = new Set(['finalized', 'sent', 'partial', 'overdue']);

/** Statuses of a bill that still waits to be paid. */
const OPEN_BILL_STATUSES: ReadonlySet<string> = new Set(['approved', 'partial', 'overdue']);

/** How many days ahead "due" looks: a bill due within a week counts, like the To process list. */
export const BILL_DUE_DAYS = 7;

export function isOpenInvoice(invoice: { status: string }): boolean {
  return OPEN_INVOICE_STATUSES.has(invoice.status);
}

export function isOpenBill(bill: { status: string }): boolean {
  return OPEN_BILL_STATUSES.has(bill.status);
}

/** `YYYY-MM-DD` of the day `days` after `today` (`YYYY-MM-DD`), in UTC arithmetic. */
function addDays(today: string, days: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** An open bill that is overdue or falls due within the next week. */
export function isBillDue(bill: { status: string; dueDate: string | null }, today: string): boolean {
  if (!isOpenBill(bill)) return false;
  if (bill.status === 'overdue') return true;
  if (!bill.dueDate) return false;
  return bill.dueDate.slice(0, 10) <= addDays(today, BILL_DUE_DAYS);
}

/** Rows a page of the list holds before the next one is asked for. */
const FILL_TARGET = 25;

/**
 * A view that narrows rows on the client can leave a loaded page nearly empty.
 * While it is active and shows fewer than a page of rows, ask for the next
 * page, one at a time, until it has enough or the list ends.
 */
export function useFillFilteredList(options: {
  active: boolean;
  shown: number;
  hasMore: boolean | undefined;
  isLoadingMore: boolean;
  loadMore: () => void;
}): void {
  const { active, shown, hasMore, isLoadingMore, loadMore } = options;
  useEffect(() => {
    if (active && hasMore && !isLoadingMore && shown < FILL_TARGET) loadMore();
  }, [active, hasMore, isLoadingMore, shown, loadMore]);
}
