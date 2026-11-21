/**
 * Shared bits of the WeldCommerce order and discount screens: status badges,
 * addresses, money, and reading the API's error body.
 */

import type { SoftTone } from '@weldsuite/ui/components/soft-badge';
import { formatPanelMoney } from '@/components/objects/_shared/simple-object-panel';
import type {
  ApprovalStatus,
  FulfillmentStatus,
  OrderAddress,
  OrderStatus,
  PaymentStatus,
} from '@/hooks/queries/use-commerce-orders-queries';
import { getTranslations } from '@/lib/i18n';

export const ORDER_STATUSES: readonly OrderStatus[] = ['pending', 'confirmed', 'processing', 'completed', 'cancelled'];
export const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'pending',
  'paid',
  'on_invoice',
  'partially_refunded',
  'refunded',
  'failed',
];
export const FULFILLMENT_STATUSES: readonly FulfillmentStatus[] = ['unfulfilled', 'partial', 'fulfilled'];

const ORDER_TONES: Record<OrderStatus, SoftTone> = {
  pending: 'warning',
  confirmed: 'neutral',
  processing: 'neutral',
  completed: 'success',
  cancelled: 'danger',
};

const PAYMENT_TONES: Record<PaymentStatus, SoftTone> = {
  pending: 'warning',
  paid: 'success',
  on_invoice: 'neutral',
  partially_refunded: 'warning',
  refunded: 'neutral',
  failed: 'danger',
};

const FULFILLMENT_TONES: Record<FulfillmentStatus, SoftTone> = {
  unfulfilled: 'warning',
  partial: 'neutral',
  fulfilled: 'success',
};

export function orderStatusTone(status: OrderStatus): SoftTone {
  return ORDER_TONES[status] ?? 'neutral';
}

export function paymentStatusTone(status: PaymentStatus): SoftTone {
  return PAYMENT_TONES[status] ?? 'neutral';
}

export function fulfillmentStatusTone(status: FulfillmentStatus): SoftTone {
  return FULFILLMENT_TONES[status] ?? 'neutral';
}

/** A status in the UI language; one this version doesn't know, as stored. */
function label(labels: Record<string, string>, value: string): string {
  return labels[value] ?? value.replace(/_/g, ' ');
}

export function orderStatusLabel(status: OrderStatus): string {
  return label(getTranslations('commerce').orders.status, status);
}

export function paymentStatusLabel(status: PaymentStatus): string {
  return label(getTranslations('commerce').orders.paymentStatus, status);
}

export function fulfillmentStatusLabel(status: FulfillmentStatus): string {
  return label(getTranslations('commerce').orders.fulfillmentStatus, status);
}

export function approvalStatusLabel(status: ApprovalStatus): string {
  return label(getTranslations('commerce').orders.approvalStatus, status);
}

/** Where an order came from: `manual`, `shopify`, … in words; an unknown channel as stored. */
export function sourceLabel(source: string): string {
  return label(getTranslations('commerce').orders.source, source);
}

/** The step an order takes next, or null at the end (or when cancelled). */
export function nextOrderStatus(status: OrderStatus): 'confirmed' | 'processing' | 'completed' | null {
  switch (status) {
    case 'pending':
      return 'confirmed';
    case 'confirmed':
      return 'processing';
    case 'processing':
      return 'completed';
    default:
      return null;
  }
}

/** Money for display; a dash when there is no amount. */
export function money(amount: string | number | null | undefined, currency: string | null | undefined): string {
  return formatPanelMoney(amount, currency) ?? '—';
}

const ADDRESS_FIELDS = ['name', 'company', 'line1', 'line2', 'postalCode', 'city', 'region', 'country', 'phone', 'email'] as const;

export function isAddressBlank(address: OrderAddress | null | undefined): boolean {
  return !address || ADDRESS_FIELDS.every((field) => !address[field]?.trim());
}

/** An address as the lines of a postal label, blanks left out. */
export function addressLines(address: OrderAddress | null | undefined): string[] {
  if (!address) return [];
  const cityLine = [address.postalCode, address.city].filter((part) => part?.trim()).join(' ');
  return [address.name, address.company, address.line1, address.line2, cityLine, address.region, address.country]
    .map((line) => line?.trim() ?? '')
    .filter((line) => line.length > 0);
}

export interface ApiErrorInfo {
  status?: number;
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * The `{ error: { code, message, details } }` of a failed call, whatever
 * threw it. The api client keeps the parsed body on `ApiError.body`.
 */
export function apiErrorInfo(err: unknown): ApiErrorInfo {
  if (typeof err !== 'object' || err === null) return {};
  const status = (err as { status?: unknown }).status;
  const body = (err as { body?: unknown }).body;
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  const info: ApiErrorInfo = { status: typeof status === 'number' ? status : undefined };
  if (typeof error === 'object' && error !== null) {
    const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof code === 'string') info.code = code;
    if (typeof message === 'string') info.message = message;
    if (typeof details === 'object' && details !== null) info.details = details as Record<string, unknown>;
  }
  return info;
}

/** True when the error is this API error `code` (a 409's `CODE_TAKEN`, say). */
export function hasErrorCode(err: unknown, code: string): boolean {
  return apiErrorInfo(err).code === code;
}

/**
 * A failed order call in words: the known 409s in the UI language, anything
 * else as the server worded it, or `fallback` when it said nothing.
 */
export function orderErrorMessage(err: unknown, fallback: string): string {
  const t = getTranslations('commerce').orders.errors;
  const { code, message } = apiErrorInfo(err);
  switch (code) {
    case 'ORDER_NOT_EDITABLE':
      return t.notEditable;
    case 'ORDER_NOT_CANCELLABLE':
      return t.notCancellable;
    case 'ALREADY_PAID':
      return t.alreadyPaid;
    case 'DISCOUNT_NOT_APPLICABLE':
      return t.discountNotApplicable;
    default:
      return message ?? (err instanceof Error && err.message ? err.message : fallback);
  }
}
