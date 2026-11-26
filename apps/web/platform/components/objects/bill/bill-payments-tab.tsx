/**
 * Payments tab of the bill panel: the payments made against the bill, newest
 * first as the server returns them, and the record-payment action while the
 * bill still has a balance due. Where the edition offers it
 * (`books-bank-links`), a bank transaction can be linked from here, and each
 * payment's row menu undoes its bank match or deletes a payment no bank
 * transaction confirms.
 */

import type { ReactNode } from 'react';
import { Banknote } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePaymentBankActions } from '@/components/accounting/payment-bank-actions';
import { TabEmptyIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import type { BillWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { canRecordBillPayment } from './bill-capabilities';

type BillPayment = NonNullable<BillWithTax['payments']>[number];

function PaymentRow({
  payment,
  currency,
  methodLabels,
  bankLabel,
  menuLabel,
  menu,
}: Readonly<{
  payment: BillPayment;
  currency: string | null;
  methodLabels: Record<string, string>;
  /** Shown when a bank transaction confirms the payment. */
  bankLabel: string;
  menuLabel: string;
  menu?: ReactNode;
}>) {
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const method = payment.paymentMethod ? (methodLabels[payment.paymentMethod] ?? payment.paymentMethod) : '—';
  const detail = [payment.checkNumber, payment.reference, payment.bankTransactionId ? bankLabel : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <TabListRow label={method} menu={menu} menuLabel={menuLabel}>
      <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-sm tabular-nums">
        {formatDate(payment.date)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{method}</div>
        {detail ? <div className="truncate text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">
        {formatMoney(payment.allocatedAmount ?? payment.amount, currency)}
      </span>
    </TabListRow>
  );
}

export function BillPaymentsTab({
  bill,
  onRecordPayment,
}: Readonly<{
  bill: BillWithTax;
  /** Set while the bill can take a payment now. */
  onRecordPayment?: () => void;
}>) {
  const { t } = useI18n();
  const tl = t.accounting.bankLinks;
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
            methodLabels={t.accounting.paymentMethods as Record<string, string>}
            bankLabel={tl.matchedToBank}
            menuLabel={tl.rowMenu}
            menu={bank.menuFor(payment)}
          />
        ))}
      </div>
      {bank.dialogs}
    </TabListScope>
  );
}
