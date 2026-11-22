/**
 * The Payments section of the order panel (phase 5): what has been paid and
 * refunded, the payment attempts (Mollie) and the refunds with a link to the
 * WeldBooks credit note, and a warning when the WeldBooks invoice of a paid
 * order failed (the "Create invoice" button is in the order's actions).
 * Reading an order's payments makes the server ask Mollie about a payment that
 * is still open, so the section is current when the panel opens.
 */

import { InlineError } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { getTranslations } from '@/lib/i18n';
import { useObjectPanel } from '@/components/object-panel';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';
import {
  useOrderPayments,
  type OrderPayment,
  type OrderRefund,
} from '@/hooks/queries/use-commerce-payments-queries';
import { money } from '@/app/weldcommerce/lib/orders';
import {
  orderInvoiceError,
  paymentLabel,
  paymentMethodName,
  paymentTone,
  refundLabel,
  refundTone,
  refundableAmount,
  toCents,
} from '@/app/weldcommerce/lib/payments';
import { fill } from '@/app/weldcommerce/lib/text';
import { SectionHeader, formatPanelDate } from '@/components/objects/_shared/simple-object-panel';

function PaymentSummary({ order }: Readonly<{ order: Order }>) {
  const t = getTranslations('commerce').orders.payments.summary;
  const rows = [
    { label: t.paid, value: order.amountPaid, show: toCents(order.amountPaid) > 0 },
    { label: t.refunded, value: order.amountRefunded, show: toCents(order.amountRefunded) > 0 },
    { label: t.refundable, value: refundableAmount(order), show: toCents(order.amountRefunded) > 0 && toCents(refundableAmount(order)) > 0 },
  ].filter((row) => row.show);
  if (rows.length === 0) return null;
  return (
    <dl className="space-y-1 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="tabular-nums">{money(row.value, order.currency)}</dd>
        </div>
      ))}
    </dl>
  );
}

function paymentDetails(payment: OrderPayment): string {
  const t = getTranslations('commerce').orders.payments;
  const created = formatPanelDate(payment.createdAt);
  const paid = formatPanelDate(payment.paidAt);
  return [
    created ? fill(t.createdOn, { date: created }) : null,
    paid ? fill(t.paidOn, { date: paid }) : null,
    toCents(payment.amountRefunded) > 0 ? fill(t.refundedOf, { amount: money(payment.amountRefunded, payment.currency) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function PaymentRow({ payment }: Readonly<{ payment: OrderPayment }>) {
  const t = getTranslations('commerce').orders.payments;
  const method = paymentMethodName(payment.method);
  return (
    <li className="space-y-1 rounded-md border p-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium tabular-nums">
          {money(payment.amount, payment.currency)}
          {method && <span className="font-normal text-muted-foreground"> · {method}</span>}
        </span>
        <span className="flex items-center gap-1.5">
          {payment.testmode && <SoftBadge tone="warning">{t.testBadge}</SoftBadge>}
          <SoftBadge tone={paymentTone(payment.status)}>{paymentLabel(payment.status)}</SoftBadge>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{paymentDetails(payment)}</p>
      {payment.failureReason && <p className="text-xs text-destructive">{payment.failureReason}</p>}
    </li>
  );
}

function RefundRow({ refund }: Readonly<{ refund: OrderRefund }>) {
  const t = getTranslations('commerce').orders.payments;
  const { open } = useObjectPanel();
  const refunded = formatPanelDate(refund.refundedAt ?? refund.createdAt);
  return (
    <li className="space-y-1 rounded-md border p-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium tabular-nums">{money(refund.amount, refund.currency)}</span>
        <SoftBadge tone={refundTone(refund.status)}>{refundLabel(refund.status)}</SoftBadge>
      </div>
      <p className="text-xs text-muted-foreground">
        {[refunded && fill(t.refundedOn, { date: refunded }), refund.reason && fill(t.reason, { reason: refund.reason })].filter(Boolean).join(' · ')}
      </p>
      {refund.creditNoteId && (
        <button
          type="button"
          className="rounded-sm text-left text-xs text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          onClick={() => open({ type: 'invoice', id: refund.creditNoteId ?? '', stack: true })}
        >
          {t.openCreditNote}
        </button>
      )}
    </li>
  );
}

function PaymentLists({ payments, refunds }: Readonly<{ payments: OrderPayment[]; refunds: OrderRefund[] }>) {
  const t = getTranslations('commerce').orders.payments;
  if (payments.length === 0 && refunds.length === 0) return <p className="text-sm text-muted-foreground">{t.none}</p>;
  return (
    <>
      {payments.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">{t.attempts}</h4>
          <ul className="space-y-1.5">
            {payments.map((payment) => (
              <PaymentRow key={payment.id} payment={payment} />
            ))}
          </ul>
        </div>
      )}
      {refunds.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">{t.refunds}</h4>
          <ul className="space-y-1.5">
            {refunds.map((refund) => (
              <RefundRow key={refund.id} refund={refund} />
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function PaymentsBody({ orderId }: Readonly<{ orderId: string }>) {
  const t = getTranslations('commerce').orders.payments;
  const result = useOrderPayments(orderId);
  if (result.isPending) return <InlineSpinner className="py-4" />;
  if (result.isError) return <InlineError>{t.loadFailed}</InlineError>;
  return <PaymentLists payments={result.data.data.payments} refunds={result.data.data.refunds} />;
}

export function PaymentsSection({ order }: Readonly<{ order: Order }>) {
  const t = getTranslations('commerce').orders.payments;
  const invoiceError = orderInvoiceError(order);

  return (
    <div className="space-y-2">
      <SectionHeader>{t.title}</SectionHeader>
      <div className="mx-4 space-y-3">
        {invoiceError && (
          <InfoBanner variant="warning" title={t.invoiceErrorTitle}>
            <span className="block break-words">{invoiceError}</span>
            <span className="mt-1 block">{t.invoiceErrorHint}</span>
          </InfoBanner>
        )}
        <PaymentSummary order={order} />
        <PaymentsBody orderId={order.id} />
      </div>
    </div>
  );
}
