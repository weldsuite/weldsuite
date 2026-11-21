import { isStorefrontError, type StorefrontErrorCode } from '@weldsuite/commerce-sdk';

/*
 * What to tell the shopper when the storefront API says no. English only:
 * translate these when you add languages.
 */
const MESSAGES: Partial<Record<StorefrontErrorCode, string>> = {
  RATE_LIMITED: 'Too many requests right now. Wait a moment and try again.',
  WORKSPACE_MOVING: 'The shop is being updated. Try again in a minute.',
  CHANNEL_INACTIVE: 'The shop is closed at the moment.',
  CART_NOT_FOUND: 'Your cart has expired. Add the items again.',
  CART_NOT_OPEN: 'This cart has already been checked out. Start a new one.',
  CART_TOO_LARGE: 'Your cart has too many lines.',
  NOT_SELLABLE: 'This product is not for sale right now.',
  COUNTRY_NOT_SOLD: 'We do not ship to that country.',
  RATE_NOT_AVAILABLE: 'That shipping method is not available for your address.',
  TAX_ENGINE_UNAVAILABLE: 'We could not work out the VAT just now. Try again in a moment.',
  SELLER_ENTITY_REQUIRED: 'The shop is not ready to sell yet.',
  SELLER_ENTITY_NOT_EU: 'The shop is not ready to sell yet.',
  CART_NOT_READY: 'Some details are still missing.',
  OUT_OF_STOCK: 'Some items are no longer in stock. Check your cart.',
  PRICE_CHANGED: 'The total has changed. Check your order and try again.',
  PAYMENT_METHOD_NOT_ENABLED: 'That payment method is not available.',
  GUEST_CHECKOUT_DISABLED: 'Sign in to check out.',
  IDEMPOTENCY_KEY_REUSED: 'Reload the page and try again.',
  PAYMENT_PROVIDER_NOT_CONNECTED: 'Online payment is not available at the moment.',
  PAYMENTS_UNAVAILABLE: 'Online payment is not available at the moment.',
  REDIRECT_NOT_ALLOWED: 'Online payment is not set up for this address of the shop.',
  ORDER_URL_NOT_ALLOWED: 'Online payment is not set up for this address of the shop.',
  PROVIDER_ERROR: 'The payment could not be started. Try again.',
  COMPANY_REQUIRED: 'Choose the company you are buying for in your account first.',
  NO_PAYMENT_TERMS: 'Your company cannot pay on invoice. Choose another payment method.',
  CREDIT_LIMIT_EXCEEDED: "This order is over your company's credit limit.",
  ALREADY_PAID: 'This order is already paid.',
  ORDER_NOT_PAYABLE: 'This order can no longer be paid online.',
  INVALID_CODE: 'That code is not right. Check the email and try again.',
  CODE_EXPIRED: 'That code has expired. Ask for a new one.',
  NOT_A_BUYER: 'You cannot buy for that company.',
  NOT_AN_APPROVER: 'Only approvers can decide on orders.',
  NOT_PENDING: 'This order has already been decided.',
  NETWORK_ERROR: 'We could not reach the shop. Check your connection and try again.',
};

const DISCOUNT_REASONS: Record<string, string> = {
  NOT_FOUND: 'That discount code does not exist.',
  NOT_ACTIVE: 'That discount code is not active.',
  NOT_STARTED: 'That discount code is not valid yet.',
  EXPIRED: 'That discount code has expired.',
  USAGE_LIMIT: 'That discount code has been used up.',
  CUSTOMER_LIMIT: 'You have already used that discount code.',
  MINIMUM_SUBTOTAL: 'Your order is below the minimum for that discount code.',
  MINIMUM_QUANTITY: 'Add more items to use that discount code.',
  CURRENCY: 'That discount code is not valid in this currency.',
  NOT_ELIGIBLE: 'That discount code does not apply to these items.',
};

export function discountReason(reason: string | null | undefined): string {
  return (reason && DISCOUNT_REASONS[reason]) || 'That discount code does not apply.';
}

/** A sentence for the shopper. Unknown failures get a generic one (and are logged). */
export function describeError(error: unknown): string {
  if (isStorefrontError(error, 'DISCOUNT_NOT_APPLICABLE')) return discountReason(error.details?.reason);
  if (isStorefrontError(error)) {
    const known = MESSAGES[error.code as StorefrontErrorCode];
    if (known) return known;
    if (error.code === 'VALIDATION_ERROR') return 'Check the highlighted fields.';
  }
  console.error('[storefront]', error);
  return 'Something went wrong. Try again.';
}

/** A sentence for an error code passed along in a URL (`?error=CODE`). */
export function messageForCode(code: string): string {
  return MESSAGES[code as StorefrontErrorCode] ?? 'Something went wrong. Try again.';
}

/** The field messages of a VALIDATION_ERROR, keyed by the API's field path. */
export function fieldErrors(error: unknown): Record<string, string> {
  return isStorefrontError(error, 'VALIDATION_ERROR') ? (error.details?.fields ?? {}) : {};
}
