/**
 * One payment in the Payments tab of an invoice or a bill: date, method,
 * check number and reference, and the amount. A payment that a bank
 * transaction confirms shows a chip to that line (it stacks the bank
 * transaction panel) instead of saying so in words.
 */

import type { ReactNode } from 'react';
import { TabListRow } from '@/components/objects/_shared/tab-list-row';
import { RecordLink } from '@/components/object-panel/record-link';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

export interface PaymentRowData {
  id: string;
  date: string;
  paymentMethod: string | null;
  checkNumber?: string | null;
  reference: string | null;
  amount: string;
  /** What this payment settled of the document, when it settled several (a bill's payment). */
  allocatedAmount?: string | null;
  /** The bank line that confirms the payment, if any. */
  bankTransactionId?: string | null;
}

export function PaymentRow({
  payment,
  currency,
  menu,
}: Readonly<{
  payment: PaymentRowData;
  currency: string | null;
  /** `DropdownMenuItem`s of the row menu. */
  menu?: ReactNode;
}>) {
  const { t } = useI18n();
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const methodLabels = t.accounting.paymentMethods as Record<string, string>;
  const method = payment.paymentMethod ? (methodLabels[payment.paymentMethod] ?? payment.paymentMethod) : '—';
  const detail = [payment.checkNumber, payment.reference].filter(Boolean).join(' · ');
  return (
    <TabListRow label={method} menu={menu} menuLabel={t.accounting.bankLinks.rowMenu}>
      <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-sm tabular-nums">
        {formatDate(payment.date)}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="truncate text-sm">{method}</div>
        {detail ? <div className="truncate text-xs text-muted-foreground">{detail}</div> : null}
        {payment.bankTransactionId ? (
          <div className="relative z-[1] min-w-0">
            <RecordLink
              type="bank_transaction"
              id={payment.bankTransactionId}
              label={t.accounting.recordLinks.paymentBankLine}
            />
          </div>
        ) : null}
      </div>
      <span className="flex-shrink-0 text-right text-sm font-medium tabular-nums">
        {formatMoney(payment.allocatedAmount ?? payment.amount, currency)}
      </span>
    </TabListRow>
  );
}
