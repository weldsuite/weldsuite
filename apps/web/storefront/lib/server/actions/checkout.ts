/** Checkout writes: details, shipping method, placing the order, paying again. */

import { createServerFn } from '@tanstack/react-start';
import { createIdempotencyKey, isStorefrontError, type Address, type CheckoutInput, type CheckoutResult, type UpdateCartInput } from '@weldsuite/commerce-sdk';
import type { ShopStrings } from '@weldsuite/storefront-theme';
import { withQuery } from '../../paths';
import { clearCartToken, getCartToken, getCheckoutState, setCheckoutState } from '../session';
import { cartOptions, shopRequest } from '../shop';
import { failed, failedWith, field, formData, go, stringsFor, succeeded } from './respond';

const ADDRESS_FIELDS = ['name', 'company', 'line1', 'line2', 'postalCode', 'city', 'region', 'country', 'phone'] as const;
const REQUIRED: Array<(typeof ADDRESS_FIELDS)[number]> = ['name', 'line1', 'postalCode', 'city', 'country'];

/** The address whose fields are named `<prefix>.<field>` (the API's field paths). */
export function addressFrom(form: FormData, prefix: 'shippingAddress' | 'billingAddress'): Address {
  const address: Address = {};
  for (const name of ADDRESS_FIELDS) address[name] = field(form, `${prefix}.${name}`) || null;
  return address;
}

function missingFields(address: Address, prefix: string, s: ShopStrings): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const name of REQUIRED) if (!address[name]) errors[`${prefix}.${name}`] = s.errors.local.FIELD_REQUIRED;
  return errors;
}

/** The API's field messages (VALIDATION_ERROR), keyed by its field paths (the form's names). */
function apiFieldErrors(error: unknown): Record<string, string> {
  return isStorefrontError(error, 'VALIDATION_ERROR') ? (error.details?.fields ?? {}) : {};
}

/** Step 1: contact details and addresses. */
export const saveDetails = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const token = getCartToken();
    if (!token) return failed('/cart', 'CART_EMPTY', s.errors.local.CART_EMPTY);
    const email = field(form, 'email');
    const shippingAddress = addressFrom(form, 'shippingAddress');
    const billingAddress = form.get('billingSame') === 'on' ? null : addressFrom(form, 'billingAddress');
    const errors: Record<string, string> = {
      ...(email ? {} : { email: s.errors.local.FIELD_REQUIRED }),
      ...missingFields(shippingAddress, 'shippingAddress', s),
      ...(billingAddress ? missingFields(billingAddress, 'billingAddress', s) : {}),
    };
    if (Object.keys(errors).length > 0) return failed('/checkout', 'FIELDS_MISSING', s.errors.local.FIELDS_MISSING, { fieldErrors: errors });
    const input: UpdateCartInput = { email, shippingAddress, billingAddress, note: field(form, 'note') || null };
    if (form.has('buyerVatNumber')) input.buyerVatNumber = field(form, 'buyerVatNumber') || null;
    if (form.has('customerReference')) input.customerReference = field(form, 'customerReference') || null;
    try {
      const cart = await shop.client.cart.update(token, input, await cartOptions(shop));
      return succeeded('/checkout', { ok: true, message: cart.shippingRate ? s.checkout.detailsSaved : s.checkout.detailsSavedChooseShipping });
    } catch (error) {
      return failedWith('/checkout', s, error, { fieldErrors: apiFieldErrors(error) });
    }
  });

/** Step 2: the shipping method. */
export const chooseShipping = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const token = getCartToken();
    const rateId = field(form, 'shippingRateId');
    if (!token) return failed('/cart', 'CART_EMPTY', s.errors.local.CART_EMPTY);
    if (!rateId) return failed('/checkout', 'CHOOSE_SHIPPING', s.errors.local.CHOOSE_SHIPPING);
    try {
      await shop.client.cart.setShippingRate(token, rateId, await cartOptions(shop));
      return succeeded('/checkout', { ok: true, message: s.checkout.shippingSaved });
    } catch (error) {
      return failedWith('/checkout', s, error);
    }
  });

/** Whether a failed checkout may have placed the order (retry with the same key). */
function outcomeUnknown(error: unknown): boolean {
  if (!isStorefrontError(error)) return true;
  return error.code === 'PROVIDER_ERROR' || error.code === 'NETWORK_ERROR' || error.status >= 500;
}

/** The return page of an order (and its payment). */
export function returnPath(orderId: string, paymentId: string | null, error?: string): string {
  return withQuery('/checkout/return', { order: orderId, payment: paymentId, error });
}

/** Step 3: place the order, then pay with Mollie (off to its page) or on invoice. */
export const placeOrder = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const s = stringsFor(shop.site.locale);
    const token = getCartToken();
    const paymentMethod = field(form, 'paymentMethod');
    const idempotencyKey = field(form, 'idempotencyKey') || createIdempotencyKey();
    if (!token) return failed('/cart', 'CART_EMPTY', s.errors.local.CART_EMPTY);
    if (paymentMethod !== 'mollie' && paymentMethod !== 'invoice') {
      return failed('/checkout', 'CHOOSE_PAYMENT', s.errors.local.CHOOSE_PAYMENT, { idempotencyKey });
    }
    if (form.get('terms') !== 'on') {
      return failed('/checkout', 'TERMS_REQUIRED', s.errors.local.TERMS_REQUIRED, { idempotencyKey, fieldErrors: { terms: s.errors.local.TERMS_REQUIRED } });
    }
    // Payment links and order links point at the shop's primary address (one of the channel's hosts).
    const origin = shop.site.primaryOrigin.replace(/\/+$/, '');
    const input: CheckoutInput = { paymentMethod, expectedTotal: field(form, 'expectedTotal') || undefined };
    if (origin.startsWith('https://')) input.orderUrl = `${origin}/orders/{orderId}?token={token}`;
    if (paymentMethod === 'mollie') input.redirectUrl = `${origin}/checkout/return`;

    let result: CheckoutResult;
    try {
      result = await shop.client.cart.checkout(token, input, { ...(await cartOptions(shop)), idempotencyKey });
    } catch (error) {
      if (isStorefrontError(error, 'PRICE_CHANGED')) {
        return failed('/checkout', 'PRICE_CHANGED', s.checkout.priceChanged, { idempotencyKey: createIdempotencyKey() });
      }
      return failedWith('/checkout', s, error, { idempotencyKey: outcomeUnknown(error) ? idempotencyKey : createIdempotencyKey() });
    }
    clearCartToken(shop.https);
    setCheckoutState(
      {
        orderId: result.order.id,
        orderNumber: result.order.orderNumber,
        paymentMethod,
        paymentId: result.payment?.id ?? null,
        orderToken: result.orderToken,
      },
      shop.https,
    );
    // Mollie sends the shopper back with ?order=…&payment=…; an order waiting
    // for approval has no payment yet, so straight to the return page.
    if (result.payment?.checkoutUrl) return go(result.payment.checkoutUrl);
    return go(returnPath(result.order.id, result.payment?.id ?? null));
  });

/** Return page: a new Mollie payment after a failed, cancelled or expired one. */
export const retryPayment = createServerFn({ method: 'POST' })
  .validator(formData)
  .handler(async ({ data: form }) => {
    const shop = await shopRequest();
    const orderId = field(form, 'orderId');
    const paymentId = field(form, 'paymentId');
    if (!orderId || !paymentId) return go('/');
    let checkoutUrl: string | null = null;
    try {
      const payment = await shop.client.payments.retry(paymentId, shop.options);
      const state = getCheckoutState();
      if (state?.orderId === orderId) setCheckoutState({ ...state, paymentId: payment.id }, shop.https);
      checkoutUrl = payment.checkoutUrl;
    } catch (error) {
      return go(returnPath(orderId, paymentId, isStorefrontError(error) ? error.code : 'UNKNOWN'));
    }
    return go(checkoutUrl ?? returnPath(orderId, paymentId));
  });
