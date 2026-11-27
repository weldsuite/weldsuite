/**
 * Payments tab of the invoice panel: the payments (and, on a credit note, the
 * refunds) recorded against it, newest first as the server returns them.
 * Where the edition offers it (`books-bank-links`), a bank transaction can be
 * linked from here, and each payment's row menu undoes its bank match or
 * deletes a payment no bank transaction confirms.
 */

import { Banknote } from 'lucide-react';
import { usePaymentBankActions } from '@/components/accounting/payment-bank-actions';
import { PaymentRow } from '@/components/accounting/payment-row';
import { TabEmptyIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListScope } from '@/components/objects/_shared/tab-list-row';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';

export function InvoicePaymentsTab({
  invoice,
  recordLabel,
  onRecordPayment,
}: Readonly<{
  invoice: InvoiceWithTax;
  /** The label of the record-payment action, when the invoice can take one now. */
  recordLabel: string | null;
  onRecordPayment: () => void;
}>) {
  const { t } = useI18n();
  const tp = t.accounting.invoiceDetail.panel;
  const payments = invoice.payments ?? [];
  const bank = usePaymentBankActions(
    {
      kind: invoice.type === 'credit_note' ? 'credit_note' : 'invoice',
      id: invoice.id,
      openAmount: invoice.balanceDue ?? '0',
      currency: invoice.currency,
    },
    recordLabel !== null && Number(invoice.balanceDue ?? 0) > 0,
  );
  const toolbar = bank.linkButton ? <div className="flex justify-end px-4 pt-3">{bank.linkButton}</div> : null;

  if (payments.length === 0) {
    return (
      <>
        {toolbar}
        <TabEmptyState
          bare
          illustration={
            <TabEmptyIllustration>
              <Banknote className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </TabEmptyIllustration>
          }
          title={tp.noPayments}
          description={tp.noPaymentsDescription}
          action={recordLabel ? { label: recordLabel, onClick: onRecordPayment } : undefined}
        />
        {bank.dialogs}
      </>
    );
  }

  return (
    <TabListScope>
      {toolbar ? <div className="pb-3">{toolbar}</div> : null}
      <div className="border-t border-gray-200/70 dark:border-border">
        {payments.map((payment) => (
          <PaymentRow
            key={payment.id}
            payment={payment}
            currency={invoice.currency}
            menu={bank.menuFor(payment)}
          />
        ))}
      </div>
      {bank.dialogs}
    </TabListScope>
  );
}
