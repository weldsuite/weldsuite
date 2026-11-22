/**
 * Shared bits of the WeldCommerce payment screens (phase 5): badges and
 * labels for the connection, payments and refunds, what an order may do next,
 * the refundable remainder in cents, and the payment errors in words.
 */

import type { SoftTone } from '@weldsuite/ui/components/soft-badge';
import type { Order } from '@/hooks/queries/use-commerce-orders-queries';
import type {
  OrderPaymentStatus,
  OrderRefundStatus,
  PaymentConnectionStatus,
} from '@/hooks/queries/use-commerce-payments-queries';
import { getTranslations } from '@/lib/i18n';
import { apiErrorInfo, money, orderErrorMessage } from '@/app/weldcommerce/lib/orders';
import { fill } from '@/app/weldcommerce/lib/text';

/** Where Mollie is connected: the Payments tab of the WeldCommerce settings. */
export const PAYMENTS_SETTINGS_PATH = '/settings/apps/weldcommerce';

const CONNECTION_TONES: Record<PaymentConnectionStatus, SoftTone> = {
  connected: 'success',
  needs_reauth: 'warning',
  disconnected: 'neutral',
};

const PAYMENT_TONES: Record<OrderPaymentStatus, SoftTone> = {
  open: 'neutral',
  pending: 'warning',
  authorized: 'warning',
  paid: 'success',
  failed: 'danger',
  canceled: 'neutral',
  expired: 'neutral',
};

const REFUND_TONES: Record<OrderRefundStatus, SoftTone> = {
  pending: 'warning',
  queued: 'warning',
  processing: 'warning',
  refunded: 'success',
  failed: 'danger',
  canceled: 'neutral',
};

export function connectionStatusTone(status: PaymentConnectionStatus): SoftTone {
  return CONNECTION_TONES[status] ?? 'neutral';
}

export function paymentTone(status: OrderPaymentStatus): SoftTone {
  return PAYMENT_TONES[status] ?? 'neutral';
}

export function refundTone(status: OrderRefundStatus): SoftTone {
  return REFUND_TONES[status] ?? 'neutral';
}

/** A status in the UI language; one this version doesn't know, as stored. */
function label(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value.replace(/_/g, ' ');
}

export function connectionStatusLabel(status: PaymentConnectionStatus): string {
  return label(getTranslations('commerce').payments.status, status);
}

export function paymentLabel(status: OrderPaymentStatus): string {
  return label(getTranslations('commerce').orders.payments.paymentStatus, status);
}

export function refundLabel(status: OrderRefundStatus): string {
  return label(getTranslations('commerce').orders.payments.refundStatus, status);
}

/** Mollie's method id in words (`ideal` → iDEAL); an unknown one as stored. */
export function paymentMethodName(method: string | null): string | null {
  if (!method) return null;
  return label(getTranslations('commerce').orders.payments.methods, method);
}

// ---------------------------------------------------------------------------
// Money in cents (the API sends decimal strings with two decimals)
// ---------------------------------------------------------------------------

/** "12.5" and "12.50" as 1250; NaN for anything that is not a plain decimal. */
export function toCents(amount: string | null | undefined): number {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec((amount ?? '').trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export function fromCents(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = String(Math.abs(cents % 100)).padStart(2, '0');
  return `${whole}.${rest}`;
}

/** What the customer still owes on the order, as a decimal string ("0.00" when nothing). */
export function outstandingAmount(order: Pick<Order, 'total' | 'amountPaid'>): string {
  const total = toCents(order.total);
  const paid = toCents(order.amountPaid);
  if (Number.isNaN(total)) return '0.00';
  return fromCents(Math.max(0, total - (Number.isNaN(paid) ? 0 : paid)));
}

/** What can still be refunded on the order, as a decimal string ("0.00" when nothing). */
export function refundableAmount(order: Pick<Order, 'amountPaid' | 'amountRefunded'>): string {
  const paid = toCents(order.amountPaid);
  const refunded = toCents(order.amountRefunded);
  if (Number.isNaN(paid)) return '0.00';
  return fromCents(Math.max(0, paid - (Number.isNaN(refunded) ? 0 : refunded)));
}

/** An https address as a string, or null for anything else (a `javascript:` link, a malformed value). */
export function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// What an order may do
// ---------------------------------------------------------------------------

/** A payment link is for an order still owing money: not cancelled, not on invoice, not paid. */
export function canCreatePaymentLink(order: Pick<Order, 'status' | 'paymentStatus'>): boolean {
  return order.status !== 'cancelled' && ['pending', 'failed'].includes(order.paymentStatus);
}

export function canRefund(order: Pick<Order, 'amountPaid' | 'amountRefunded'>): boolean {
  return toCents(refundableAmount(order)) > 0;
}

/** The message of the failed WeldBooks invoice (`metadata.invoiceError`), or null when there is none. */
export function orderInvoiceError(order: Pick<Order, 'metadata'>): string | null {
  const value = order.metadata?.invoiceError;
  if (typeof value === 'string' && value.trim()) return value.trim();
  return value ? getTranslations('commerce').orders.payments.invoiceErrorUnknown : null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A failed payment or connection call in words: the known codes in the UI
 * language (`REFUND_TOO_LARGE` with the refundable amount from `details`),
 * anything else through the order messages.
 */
export function paymentErrorMessage(err: unknown, fallback: string, currency?: string | null): string {
  const t = getTranslations('commerce').payments.errors;
  const { code, message, details } = apiErrorInfo(err);
  switch (code) {
    case 'PAYMENT_PROVIDER_NOT_CONNECTED':
      return t.notConnected;
    case 'NOTHING_TO_REFUND':
      return t.nothingToRefund;
    case 'REFUND_TOO_LARGE': {
      const refundable = typeof details?.refundable === 'string' ? details.refundable : null;
      return refundable ? fill(t.refundTooLarge, { refundable: money(refundable, currency) }) : t.refundTooLargeUnknown;
    }
    case 'ORDER_NOT_PAYABLE':
      return t.orderNotPayable;
    case 'PROVIDER_ERROR':
      return message ? fill(t.providerError, { message }) : t.providerErrorUnknown;
    case 'MOLLIE_CONNECT_NOT_CONFIGURED':
      return t.connectNotConfigured;
    case 'MOLLIE_KEY_INVALID':
      return t.keyInvalid;
    case 'TESTMODE_FIXED':
      return t.testmodeFixed;
    default:
      return orderErrorMessage(err, fallback);
  }
}
