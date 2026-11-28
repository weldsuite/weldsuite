/**
 * "Add a receipt" where the edition books documents (`books-receipts`): the
 * document becomes a receipt paid with this bank line, from what the scan read
 * and the supplier's history. Pure, so the one-step booking is tested without
 * rendering the form.
 */
import { fromCents, toCents } from '@/lib/weldbooks/bank-link-math';
import type { BookDocumentInput, DocumentPrefill } from '@/lib/api/domains/weldbooks-receipts';

export type ReceiptBookingResult =
  | { ok: true; input: BookDocumentInput }
  | { ok: false; problem: 'noSupplier' | 'noLines' };

/** The readable lines of the document, else one line for its total, else none. */
function bookableLines(prefill: DocumentPrefill) {
  const readable = prefill.lines.filter((line) => Number.isFinite(line.amount) && line.amount > 0);
  if (readable.length > 0) return readable;
  if (prefill.total && prefill.total > 0) {
    return [{ description: prefill.contactName ?? '', amount: prefill.total, taxRate: null, taxRateId: null, accountId: null, projectId: null }];
  }
  return [];
}

/**
 * The `book` request for a document paid by `bankTransactionId`. A receipt with
 * no readable lines but a total becomes one line for the total (the supplier's
 * usual category applies); with neither, or without a supplier, the document
 * has to be opened in the inbox.
 */
export function receiptBookInput(
  prefill: DocumentPrefill,
  bankTransactionId: string,
  fallbackDate: string,
): ReceiptBookingResult {
  if (!prefill.contactId) return { ok: false, problem: 'noSupplier' };

  const lines = bookableLines(prefill);
  if (lines.length === 0) return { ok: false, problem: 'noLines' };

  const input: BookDocumentInput = {
    kind: 'receipt',
    contactId: prefill.contactId,
    date: prefill.date ?? fallbackDate,
    lines: lines.map((line, index) => ({
      description: line.description?.trim() || prefill.contactName || `${index + 1}`,
      amount: Number(fromCents(toCents(line.amount))),
      ...(line.accountId ? { accountId: line.accountId } : {}),
      ...(line.taxRateId ? { taxRateId: line.taxRateId } : {}),
      ...(line.projectId ? { projectId: line.projectId } : {}),
    })),
    paidWith: { type: 'bank_transaction', bankTransactionId },
  };
  if (prefill.invoiceNumber) input.invoiceNumber = prefill.invoiceNumber;
  if (prefill.currency) input.currency = prefill.currency;
  return { ok: true, input };
}
