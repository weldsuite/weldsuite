/**
 * The shopper's cookies (lib/cookies.ts lists them), read and written inside
 * server functions and loaders. No token ever reaches page script.
 */

import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server';
import { COOKIE, DAY, shopCookie } from '../cookies';

function options(https: boolean, lifetime: { maxAge?: number; expires?: Date } = {}) {
  const { httpOnly, secure, path, maxAge, expires } = shopCookie(https, lifetime);
  return { httpOnly, secure, path, sameSite: 'lax' as const, ...(maxAge !== undefined ? { maxAge } : {}), ...(expires ? { expires } : {}) };
}

export function getCartToken(): string | undefined {
  return getCookie(COOKIE.cart) || undefined;
}

/** Carts expire 30 days after their last change. */
export function setCartToken(token: string, https: boolean): void {
  setCookie(COOKIE.cart, token, options(https, { maxAge: 30 * DAY }));
}

export function clearCartToken(https: boolean): void {
  deleteCookie(COOKIE.cart, options(https));
}

export function getShopperToken(): string | undefined {
  return getCookie(COOKIE.session) || undefined;
}

export function setShopperToken(token: string, expiresAt: string, https: boolean): void {
  const expires = new Date(expiresAt);
  setCookie(COOKIE.session, token, options(https, Number.isNaN(expires.getTime()) ? { maxAge: 30 * DAY } : { expires }));
}

export function clearShopperToken(https: boolean): void {
  deleteCookie(COOKIE.session, options(https));
}

/** The email a sign-in code went to, between "send me a code" and "sign in" (15 minutes). */
export function getPendingSignIn(): string | undefined {
  return getCookie(COOKIE.signIn) || undefined;
}

export function setPendingSignIn(email: string, https: boolean): void {
  setCookie(COOKIE.signIn, email, options(https, { maxAge: 15 * 60 }));
}

export function clearPendingSignIn(https: boolean): void {
  deleteCookie(COOKIE.signIn, options(https));
}

/**
 * The last checkout. Mollie's return URL carries the order and payment ids;
 * this keeps what it doesn't: a guest's order token and how the order is paid.
 */
export interface CheckoutState {
  orderId: string;
  orderNumber: string;
  paymentMethod: 'mollie' | 'invoice';
  paymentId: string | null;
  orderToken: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function getCheckoutState(): CheckoutState | undefined {
  const raw = getCookie(COOKIE.checkout);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<CheckoutState>;
    if (typeof value.orderId !== 'string') return undefined;
    return {
      orderId: value.orderId,
      orderNumber: text(value.orderNumber) ?? '',
      paymentMethod: value.paymentMethod === 'invoice' ? 'invoice' : 'mollie',
      paymentId: text(value.paymentId),
      orderToken: text(value.orderToken),
    };
  } catch {
    return undefined;
  }
}

export function setCheckoutState(state: CheckoutState, https: boolean): void {
  setCookie(COOKIE.checkout, JSON.stringify(state), options(https, { maxAge: 2 * DAY }));
}

/** The shopper's analytics choice, when they made one. */
export function getConsent(): 'granted' | 'denied' | null {
  const value = getCookie(COOKIE.consent);
  return value === 'granted' || value === 'denied' ? value : null;
}
