import type { CartMissing, DiscountProblem } from './types.ts';

/**
 * Every error code the storefront API documents. A newer server may send
 * others, so `StorefrontError.code` is typed as this union plus `string`.
 */
export type StorefrontErrorCode =
  // Keys, origins and limits (any route)
  | 'INVALID_KEY'
  | 'ORIGIN_NOT_ALLOWED'
  | 'CHANNEL_INACTIVE'
  | 'RATE_LIMITED'
  | 'WORKSPACE_MOVING'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  // Carts
  | 'CART_NOT_FOUND'
  | 'CART_NOT_OPEN'
  | 'CART_TOO_LARGE'
  | 'NOT_SELLABLE'
  | 'COUNTRY_NOT_SOLD'
  | 'RATE_NOT_AVAILABLE'
  | 'DISCOUNT_NOT_APPLICABLE'
  | 'TAX_ENGINE_UNAVAILABLE'
  | 'SELLER_ENTITY_REQUIRED'
  | 'SELLER_ENTITY_NOT_EU'
  // Checkout
  | 'CART_NOT_READY'
  | 'OUT_OF_STOCK'
  | 'PRICE_CHANGED'
  | 'PAYMENT_METHOD_NOT_ENABLED'
  | 'GUEST_CHECKOUT_DISABLED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'PAYMENT_PROVIDER_NOT_CONNECTED'
  | 'PAYMENTS_UNAVAILABLE'
  | 'REDIRECT_NOT_ALLOWED'
  | 'ORDER_URL_NOT_ALLOWED'
  | 'PROVIDER_ERROR'
  | 'COMPANY_REQUIRED'
  | 'NO_PAYMENT_TERMS'
  | 'CREDIT_LIMIT_EXCEEDED'
  // Payments
  | 'ALREADY_PAID'
  | 'ORDER_NOT_PAYABLE'
  // Shopper sign-in and accounts
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'NOT_A_BUYER'
  // B2B approvals and buyers
  | 'NOT_AN_APPROVER'
  | 'NOT_PENDING'
  | 'LAST_ADMIN'
  // Raised by this SDK, not the server
  | 'NETWORK_ERROR'
  | 'UNEXPECTED_RESPONSE';

/** The `details` that come with a code, where the API documents them. */
export interface StorefrontErrorDetails {
  VALIDATION_ERROR: { fields: Record<string, string> };
  CART_NOT_OPEN: { status: string };
  COUNTRY_NOT_SOLD: { country: string };
  DISCOUNT_NOT_APPLICABLE: { reason: DiscountProblem };
  SELLER_ENTITY_NOT_EU: { country: string };
  CART_NOT_READY: { missing: CartMissing[]; lines: Array<{ lineId: string; problem: string }> };
  OUT_OF_STOCK: { lines: Array<{ lineId: string; available: number | null }> };
  PRICE_CHANGED: { total: string };
  PROVIDER_ERROR: { orderId: string };
  PAYMENT_PROVIDER_NOT_CONNECTED: { orderId: string } | undefined;
  ALREADY_PAID: { orderId: string } | undefined;
  ORDER_NOT_PAYABLE: { orderId: string } | undefined;
  INVALID_CODE: { attemptsLeft: number };
  CREDIT_LIMIT_EXCEEDED: { available: string };
}

/** The details type of `code`: documented ones are typed, the rest `unknown`. */
export type DetailsOf<C extends string> = C extends keyof StorefrontErrorDetails
  ? StorefrontErrorDetails[C]
  : unknown;

/**
 * A refusal from the storefront API (`{ error: { code, message, details? } }`),
 * or a request that never got an answer (`NETWORK_ERROR`, status 0).
 */
export class StorefrontError<C extends string = StorefrontErrorCode | (string & Record<never, never>)> extends Error {
  override readonly name = 'StorefrontError';
  /** The HTTP status; 0 when no response arrived. */
  readonly status: number;
  readonly code: C;
  readonly details: DetailsOf<C>;
  /**
   * Seconds to wait before trying again, from `Retry-After` (sent with 429
   * `RATE_LIMITED` and 503 `WORKSPACE_MOVING`); `null` without one.
   */
  readonly retryAfter: number | null;

  constructor(init: {
    status: number;
    code: C;
    message: string;
    details?: unknown;
    retryAfter?: number | null;
    cause?: unknown;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.status = init.status;
    this.code = init.code;
    this.details = init.details as DetailsOf<C>;
    this.retryAfter = init.retryAfter ?? null;
  }
}

/**
 * Whether `error` is a `StorefrontError`, optionally with one of `codes`.
 * Narrows `details` to the documented shape:
 *
 * ```ts
 * if (isStorefrontError(error, 'OUT_OF_STOCK')) error.details.lines;
 * ```
 */
export function isStorefrontError<C extends StorefrontErrorCode>(
  error: unknown,
  ...codes: C[]
): error is StorefrontError<C> {
  if (!(error instanceof StorefrontError)) return false;
  return codes.length === 0 || (codes as string[]).includes(error.code);
}

/** `Retry-After` in seconds: a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}
