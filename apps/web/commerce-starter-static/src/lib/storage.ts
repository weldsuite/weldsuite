/**
 * The cart token and the last checkout, kept in localStorage. Storage can be
 * missing or throw (private windows, blocked site data), so every access is
 * guarded and falls back to memory for this page's lifetime.
 */

import type { PaymentMethod } from '@weldsuite/commerce-sdk';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CART = 'weldcommerce.cart';
const CHECKOUT = 'weldcommerce.checkout';

/** localStorage when it works, else a store in memory. */
export function safeStore(get: () => KeyValueStore | undefined): KeyValueStore {
  const memory = new Map<string, string>();
  const attempt = <T>(apply: (store: KeyValueStore) => T, fallback: () => T): T => {
    try {
      const store = get();
      if (store) return apply(store);
    } catch {
      // Storage refused: keep the value in memory instead.
    }
    return fallback();
  };
  return {
    getItem: (key) => attempt((store) => store.getItem(key), () => memory.get(key) ?? null),
    setItem: (key, value) => attempt((store) => store.setItem(key, value), () => void memory.set(key, value)),
    removeItem: (key) => attempt((store) => store.removeItem(key), () => void memory.delete(key)),
  };
}

const browserStore = safeStore(() => (typeof window === 'undefined' ? undefined : window.localStorage));

/** Cart tokens look like `wct_…`; anything else in storage is ignored. */
export function getCartToken(store: KeyValueStore = browserStore): string | undefined {
  const token = store.getItem(CART);
  return token && /^wct_[A-Za-z0-9_-]{8,200}$/.test(token) ? token : undefined;
}

export function setCartToken(token: string, store: KeyValueStore = browserStore): void {
  store.setItem(CART, token);
}

export function clearCartToken(store: KeyValueStore = browserStore): void {
  store.removeItem(CART);
}

/**
 * The last checkout: what Mollie's return URL doesn't carry (a guest's order
 * token, how the order is paid).
 */
export interface CheckoutState {
  orderId: string;
  orderNumber: string;
  paymentMethod: PaymentMethod;
  paymentId: string | null;
  orderToken: string | null;
}

export function getCheckoutState(store: KeyValueStore = browserStore): CheckoutState | undefined {
  const raw = store.getItem(CHECKOUT);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<CheckoutState>;
    if (typeof value.orderId !== 'string') return undefined;
    const text = (v: unknown) => (typeof v === 'string' ? v : null);
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

export function setCheckoutState(state: CheckoutState, store: KeyValueStore = browserStore): void {
  store.setItem(CHECKOUT, JSON.stringify(state));
}
