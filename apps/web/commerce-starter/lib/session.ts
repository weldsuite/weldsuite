import 'server-only';

import { cookies } from 'next/headers';

/*
 * The shop keeps three things in httpOnly cookies, so no token ever reaches
 * browser JavaScript:
 * - the cart token (wct_…), for the shopper's cart;
 * - the shopper's session token (wss_…), once they sign in;
 * - the last checkout (order id, Mollie payment id, a guest's order token),
 *   for the page Mollie sends the shopper back to.
 * Setting or clearing a cookie only works in server actions and route handlers.
 */

const CART = 'wc_cart';
const SESSION = 'wc_session';
const CHECKOUT = 'wc_checkout';

const base = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

const DAY = 24 * 60 * 60;

export async function getCartToken(): Promise<string | undefined> {
  return (await cookies()).get(CART)?.value || undefined;
}

export async function setCartToken(token: string): Promise<void> {
  // Carts expire 30 days after their last change.
  (await cookies()).set(CART, token, { ...base, maxAge: 30 * DAY });
}

export async function clearCartToken(): Promise<void> {
  (await cookies()).delete(CART);
}

export async function getShopperToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION)?.value || undefined;
}

export async function setShopperToken(token: string, expiresAt: string): Promise<void> {
  const expires = new Date(expiresAt);
  (await cookies()).set(SESSION, token, {
    ...base,
    ...(Number.isNaN(expires.getTime()) ? { maxAge: 30 * DAY } : { expires }),
  });
}

export async function clearShopperToken(): Promise<void> {
  (await cookies()).delete(SESSION);
}

export interface CheckoutState {
  orderId: string;
  orderNumber: string;
  paymentId: string | null;
  /** A guest's order token, for the order link. */
  orderToken: string | null;
}

export async function getCheckoutState(): Promise<CheckoutState | undefined> {
  const raw = (await cookies()).get(CHECKOUT)?.value;
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<CheckoutState>;
    if (typeof value.orderId !== 'string') return undefined;
    return {
      orderId: value.orderId,
      orderNumber: typeof value.orderNumber === 'string' ? value.orderNumber : '',
      paymentId: typeof value.paymentId === 'string' ? value.paymentId : null,
      orderToken: typeof value.orderToken === 'string' ? value.orderToken : null,
    };
  } catch {
    return undefined;
  }
}

export async function setCheckoutState(state: CheckoutState): Promise<void> {
  (await cookies()).set(CHECKOUT, JSON.stringify(state), { ...base, maxAge: 2 * DAY });
}
