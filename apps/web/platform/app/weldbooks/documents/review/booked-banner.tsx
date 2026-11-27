/**
 * The line that says what "Save and next" just booked, with chips to the bill,
 * the payment and the bank line. It carries over to the next document's screen
 * (the screen moves on at once), so the person sees the result and keeps going.
 */

import { atom } from 'jotai';
import { ArrowLeftRight, Banknote, Receipt, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { RecordLink } from '@/components/object-panel/record-link';
import type { BookDocumentResult, BookKind } from '@/lib/api/domains/weldbooks-receipts';
import { useI18n } from '@/lib/i18n/provider';

export interface BookedSummary {
  kind: BookKind;
  billId: string;
  billNumber: string | null;
  paymentId: string | null;
  bankTransactionId: string | null;
  paid: boolean;
  autoLinked: boolean;
}

/** The last booking of this visit, shown on the screen it moved to. */
export const lastBookedAtom = atom<BookedSummary | null>(null);

export function summarizeBooking(kind: BookKind, result: BookDocumentResult): BookedSummary {
  const paid = Boolean(result.payment) || result.bill.status === 'paid';
  return {
    kind,
    billId: result.bill.id,
    billNumber: result.bill.billNumber ?? null,
    paymentId: result.payment?.id ?? null,
    bankTransactionId: result.bankTransactionId ?? null,
    paid,
    autoLinked: Boolean(result.autoLinked),
  };
}

export function BookedBanner({ summary, onDismiss }: Readonly<{ summary: BookedSummary; onDismiss?: () => void }>) {
  const { t } = useI18n();
  const td = t.weldbooksReceipts.review.done;
  const text = `${td[summary.kind === 'purchase_invoice' ? 'bill' : summary.kind]}${summary.paid ? td.paid : ''}${summary.autoLinked ? td.autoLinked : ''}`;
  return (
    <div data-testid="booked-banner">
      <InfoBanner
        variant="success"
        action={
          onDismiss ? (
            <Button type="button" variant="ghost" size="icon" className="size-7" onClick={onDismiss} aria-label={t.common.actions.close}>
              <X className="size-4" aria-hidden />
            </Button>
          ) : undefined
        }
      >
        <p role="status">{text}</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          <li className="min-w-0">
            <RecordLink
              type="bill"
              id={summary.billId}
              icon={Receipt}
              label={summary.billNumber ? td.chipBill.replace('{number}', summary.billNumber) : td.chipBillFallback}
            />
          </li>
          {summary.paymentId ? (
            <li className="min-w-0">
              <RecordLink type="payment" id={summary.paymentId} icon={Banknote} label={td.chipPayment} />
            </li>
          ) : null}
          {summary.bankTransactionId ? (
            <li className="min-w-0">
              <RecordLink type="bank_transaction" id={summary.bankTransactionId} icon={ArrowLeftRight} label={td.chipBankLine} />
            </li>
          ) : null}
        </ul>
      </InfoBanner>
    </div>
  );
}
