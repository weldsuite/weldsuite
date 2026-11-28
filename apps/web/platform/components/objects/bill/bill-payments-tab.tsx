/**
 * Payments tab of the bill panel: the payments made against the bill, newest
 * first as the server returns them, and the record-payment action while the
 * bill still has a balance due. Where the edition offers it
 * (`books-bank-links`), a bank transaction can be linked from here, and each
 * payment's row menu undoes its bank match or deletes a payment no bank
 * transaction confirms.
 */

import { Banknote } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePaymentBankActions } from '@/components/accounting/payment-bank-actions';
import { PaymentRow } from '@/components/accounting/payment-row';
import { TabEmptyIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListScope } from '@/components/objects/_shared/tab-list-row';
import type { BillWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { canRecordBillPayment } from './bill-capabilities';

export function BillPaymentsTab({
  bill,
  onRecordPayment,
}: Readonly<{
  bill: BillWithTax;
  /** Set while the bill can take a payment now. */
  onRecordPayment?: () => void;
}>) {
  const st = useTranslations();
  const payments = bill.payments ?? [];
  const bank = usePaymentBankActions(
    { kind: 'bill', id: bill.id, openAmount: bill.balanceDue ?? '0', currency: bill.currency },
    canRecordBillPayment(bill),
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
          title={st('sweep.weldbooks.records.noBillPayments')}
          description={st('sweep.weldbooks.records.noBillPaymentsDescription')}
          action={
            onRecordPayment ? { label: st('sweep.weldbooks.records.recordPayment'), onClick: onRecordPayment } : undefined
          }
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
            currency={bill.currency}
            menu={bank.menuFor(payment)}
          />
        ))}
      </div>
      {bank.dialogs}
    </TabListScope>
  );
}
