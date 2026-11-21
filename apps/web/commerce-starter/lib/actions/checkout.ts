'use server';

import {
  createIdempotencyKey,
  isStorefrontError,
  type Address,
  type CheckoutInput,
  type CheckoutResult,
  type PaymentMethod,
  type UpdateCartInput,
} from '@weldsuite/commerce-sdk';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requestOptions, shopUrl, storefront } from '../commerce';
import { getSessionToken } from '../data';
import { describeError, fieldErrors } from '../errors';
import { clearCartToken, getCartToken, getCheckoutState, setCheckoutState } from '../session';
import { text, type FormState } from './state';

async function cartOptions() {
  return { ...(await requestOptions()), shopperToken: await getSessionToken() };
}

const ADDRESS_FIELDS = ['name', 'company', 'line1', 'line2', 'postalCode', 'city', 'region', 'country', 'phone'] as const;
const REQUIRED: Array<(typeof ADDRESS_FIELDS)[number]> = ['name', 'line1', 'postalCode', 'city', 'country'];

/** The address whose fields are named `<prefix>.<field>` (the API's field paths). */
function addressFrom(form: FormData, prefix: 'shippingAddress' | 'billingAddress'): Address {
  const address: Address = {};
  for (const field of ADDRESS_FIELDS) address[field] = text(form, `${prefix}.${field}`) || null;
  return address;
}

function missingFields(address: Address, prefix: string): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of REQUIRED) if (!address[field]) errors[`${prefix}.${field}`] = 'Required';
  return errors;
}

/** Checkout step 1: contact details and addresses. */
export async function saveDetailsAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = await getCartToken();
  if (!token) return { status: 'error', message: 'Your cart is empty.' };
  const email = text(form, 'email');
  const shippingAddress = addressFrom(form, 'shippingAddress');
  const sameBilling = form.get('billingSame') === 'on';
  const billingAddress = sameBilling ? null : addressFrom(form, 'billingAddress');
  const errors: Record<string, string> = {
    ...(email ? {} : { email: 'Required' }),
    ...missingFields(shippingAddress, 'shippingAddress'),
    ...(billingAddress ? missingFields(billingAddress, 'billingAddress') : {}),
  };
  if (Object.keys(errors).length > 0) {
    return { status: 'error', message: 'Fill in the highlighted fields.', fieldErrors: errors };
  }
  const input: UpdateCartInput = { email, shippingAddress, billingAddress, note: text(form, 'note') || null };
  if (form.has('buyerVatNumber')) input.buyerVatNumber = text(form, 'buyerVatNumber') || null;
  if (form.has('customerReference')) input.customerReference = text(form, 'customerReference') || null;
  try {
    const cart = await storefront().cart.update(token, input, await cartOptions());
    revalidatePath('/checkout');
    return {
      status: 'success',
      message: cart.shippingRate ? 'Details saved.' : 'Details saved. Now choose how to ship your order.',
    };
  } catch (error) {
    return { status: 'error', message: describeError(error), fieldErrors: fieldErrors(error) };
  }
}

/** Checkout step 2: the shipping method. */
export async function chooseShippingAction(_prev: FormState, form: FormData): Promise<FormState> {
  const token = await getCartToken();
  const rateId = text(form, 'shippingRateId');
  if (!token) return { status: 'error', message: 'Your cart is empty.' };
  if (!rateId) return { status: 'error', message: 'Choose a shipping method.' };
  try {
    await storefront().cart.setShippingRate(token, rateId, await cartOptions());
    revalidatePath('/checkout');
    return { status: 'success', message: 'Shipping method saved.' };
  } catch (error) {
    return { status: 'error', message: describeError(error) };
  }
}

export interface PlaceOrderState extends FormState {
  /** The key the next attempt sends: the same one when the outcome is unknown. */
  idempotencyKey?: string;
}

/** Whether a failed checkout may have placed the order (retry with the same key). */
function outcomeUnknown(error: unknown): boolean {
  if (!isStorefrontError(error)) return true;
  return error.code === 'PROVIDER_ERROR' || error.code === 'NETWORK_ERROR' || error.status >= 500;
}

/** Checkout step 3: place the order, then pay with Mollie or on invoice. */
export async function placeOrderAction(_prev: PlaceOrderState, form: FormData): Promise<PlaceOrderState> {
  const token = await getCartToken();
  const paymentMethod = text(form, 'paymentMethod') as PaymentMethod;
  const idempotencyKey = text(form, 'idempotencyKey') || createIdempotencyKey();
  if (!token) return { status: 'error', message: 'Your cart is empty.' };
  if (paymentMethod !== 'mollie' && paymentMethod !== 'invoice') {
    return { status: 'error', message: 'Choose how you want to pay.', idempotencyKey };
  }
  const base = await shopUrl();
  const secure = base.startsWith('https://');
  const input: CheckoutInput = { paymentMethod, expectedTotal: text(form, 'expectedTotal') || undefined };
  if (secure) input.orderUrl = `${base}/orders/{orderId}?token={token}`;
  if (paymentMethod === 'mollie') {
    if (!secure) {
      return {
        status: 'error',
        message: 'Online payment needs the shop on an https address. Set SHOP_URL.',
        idempotencyKey,
      };
    }
    input.redirectUrl = `${base}/checkout/return`;
  }

  let result: CheckoutResult;
  try {
    result = await storefront().cart.checkout(token, input, { ...(await cartOptions()), idempotencyKey });
  } catch (error) {
    revalidatePath('/checkout');
    if (isStorefrontError(error, 'PRICE_CHANGED')) {
      return {
        status: 'error',
        message: 'The total has changed. Check the new total below and place your order again.',
        idempotencyKey: createIdempotencyKey(),
      };
    }
    return {
      status: 'error',
      message: describeError(error),
      idempotencyKey: outcomeUnknown(error) ? idempotencyKey : createIdempotencyKey(),
    };
  }

  await clearCartToken();
  await setCheckoutState({
    orderId: result.order.id,
    orderNumber: result.order.orderNumber,
    paymentMethod,
    paymentId: result.payment?.id ?? null,
    orderToken: result.orderToken,
  });
  revalidatePath('/', 'layout');
  // Mollie sends the shopper back with ?order=…&payment=…. A Mollie order
  // that waits for approval has no payment yet: straight to the return page.
  if (result.payment?.checkoutUrl) redirect(result.payment.checkoutUrl);
  redirect(returnPath(result.order.id, result.payment?.id ?? null));
}

/** The return page of an order (and its payment). */
function returnPath(orderId: string, paymentId: string | null, error?: string): string {
  const query = new URLSearchParams({ order: orderId });
  if (paymentId) query.set('payment', paymentId);
  if (error) query.set('error', error);
  return `/checkout/return?${query.toString()}`;
}

/** Return page: a new Mollie payment after a failed, cancelled or expired one. */
export async function retryPaymentAction(form: FormData): Promise<void> {
  const orderId = text(form, 'orderId');
  const paymentId = text(form, 'paymentId');
  if (!orderId || !paymentId) redirect('/');
  let checkoutUrl: string | null = null;
  try {
    const payment = await storefront().payments.retry(paymentId, await requestOptions());
    // Keep the fallback cookie in step when it is this checkout's.
    const state = await getCheckoutState();
    if (state?.orderId === orderId) await setCheckoutState({ ...state, paymentId: payment.id });
    checkoutUrl = payment.checkoutUrl;
  } catch (error) {
    const code = isStorefrontError(error) ? error.code : 'UNKNOWN';
    if (!isStorefrontError(error)) console.error('[checkout]', error);
    redirect(returnPath(orderId, paymentId, code));
  }
  redirect(checkoutUrl ?? returnPath(orderId, paymentId));
}
