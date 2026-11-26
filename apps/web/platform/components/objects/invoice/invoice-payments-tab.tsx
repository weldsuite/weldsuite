/**
 * Payments tab of the invoice panel: the payments (and, on a credit note, the
 * refunds) recorded against it, newest first as the server returns them.
 * Where the edition offers it (`books-bank-links`), a bank transaction can be
 * linked from here, and each payment's row menu undoes its bank match or
 * deletes a payment no bank transaction confirms.
 */

import type { ReactNode } from 'react';
import { Banknote } from 'lucide-react';
import { usePaymentBankActions } from '@/components/accounting/payment-bank-actions';
import { TabEmptyIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

type InvoicePayment = InvoiceWithTax['payments'][number];

function PaymentRow({
  payment,
  currency,
  methodLabels,
  bankLabel,
  menuLabel,
  menu,
}: Readonly<{
  payment: InvoicePayment;
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
        {formatMoney(payment.amount, currency)}
      </span>
    </TabListRow>
  );
}

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
  const tl = t.accounting.bankLinks;
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
