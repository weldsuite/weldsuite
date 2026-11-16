/**
 * Payments tab of the bill panel: the payments made against the bill, newest
 * first as the server returns them, and the record-payment action while the
 * bill still has a balance due.
 */

import { Banknote } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { TabEmptyIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import type { BillWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

type BillPayment = NonNullable<BillWithTax['payments']>[number];

function PaymentRow({
  payment,
  currency,
  methodLabels,
}: Readonly<{ payment: BillPayment; currency: string | null; methodLabels: Record<string, string> }>) {
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const method = payment.paymentMethod ? (methodLabels[payment.paymentMethod] ?? payment.paymentMethod) : '—';
  const detail = [payment.checkNumber, payment.reference].filter(Boolean).join(' · ');
  return (
    <TabListRow label={method}>
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
  const st = useTranslations();
  const payments = bill.payments ?? [];

  if (payments.length === 0) {
    return (
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
    );
  }

  return (
    <TabListScope>
      <div className="border-t border-gray-200/70 dark:border-border">
        {payments.map((payment) => (
          <PaymentRow
            key={payment.id}
            payment={payment}
            currency={bill.currency}
            methodLabels={t.accounting.paymentMethods as Record<string, string>}
          />
        ))}
      </div>
    </TabListScope>
  );
}
