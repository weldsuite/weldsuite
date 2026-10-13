import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';

/** Statuses after which the invoice can no longer be cancelled or written off. */
const CLOSED_STATUSES = new Set(['cancelled', 'paid', 'uncollectible']);
const OPEN_BALANCE_STATUSES = new Set(['sent', 'partial', 'overdue', 'finalized']);
/** Statuses in which a payment can be recorded straight away. */
const PAYABLE_STATUSES = new Set(['finalized', 'sent', 'partial', 'overdue']);

const isPositive = (value: unknown) => Number(value ?? 0) > 0;

/** What a written-off invoice still has written off: it can be paid after all (the write-off is taken back). */
function writtenOffBalanceOf(invoice: InvoiceWithTax): number {
  if (invoice.status !== 'uncollectible') return 0;
  return Math.max(0, Number(invoice.total ?? 0) - Number(invoice.amountPaid ?? 0));
}

/** Which actions the invoice's status, type and the member's permissions allow. */
export function getInvoiceCapabilities(invoice: InvoiceWithTax, canUpdate: boolean, canCreate: boolean) {
  const isDraft = invoice.status === 'draft';
  const isCreditMemo = invoice.type === 'credit_note';
  const writtenOffBalance = writtenOffBalanceOf(invoice);
  const open = !CLOSED_STATUSES.has(invoice.status);
  return {
    isDraft,
    isCreditMemo,
    writtenOffBalance,
    // A finalized invoice still has to be sent, and a sent one can be sent again.
    canSend: open,
    canRecordPayment:
      PAYABLE_STATUSES.has(invoice.status) ||
      (invoice.status === 'uncollectible' && !isCreditMemo && writtenOffBalance > 0),
    canCancel: canUpdate && open,
    // A credit note is owed to the customer: it is applied to an invoice or refunded, never written off.
    canWriteOff:
      canUpdate && !isCreditMemo && OPEN_BALANCE_STATUSES.has(invoice.status) && isPositive(invoice.balanceDue),
    canApplyCredit:
      canUpdate && isCreditMemo && !isDraft && Boolean(invoice.creditNoteForInvoiceId) && isPositive(invoice.balanceDue),
    canCreateCreditMemo: canCreate && !isDraft && !isCreditMemo && invoice.status !== 'cancelled',
  };
}

export type InvoiceCapabilities = ReturnType<typeof getInvoiceCapabilities>;
