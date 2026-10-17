/**
 * Payments tab of the invoice panel: the payments (and, on a credit note, the
 * refunds) recorded against it, newest first as the server returns them.
 */

import { Banknote } from 'lucide-react';
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
}: Readonly<{ payment: InvoicePayment; currency: string | null; methodLabels: Record<string, string> }>) {
  const { formatDate, formatMoney } = useWeldbooksFormat();
  const method = payment.paymentMethod ? (methodLabels[payment.paymentMethod] ?? payment.paymentMethod) : '—';
  const detail = [payment.checkNumber, payment.reference].filter(Boolean).join(' · ');
  return (
    <TabListRow label={method}>
      <span className="w-[92px] flex-shrink-0 whitespace-nowrap text-sm text-muted-foreground tabular-nums">
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
  const payments = invoice.payments ?? [];

  if (payments.length === 0) {
    return (
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
    );
  }

  return (
    <TabListScope>
      <div className="border-t border-gray-200/70 dark:border-border">
        {payments.map((payment) => (
          <PaymentRow
            key={payment.id}
            payment={payment}
            currency={invoice.currency}
            methodLabels={t.accounting.paymentMethods as Record<string, string>}
          />
        ))}
      </div>
    </TabListScope>
  );
}
