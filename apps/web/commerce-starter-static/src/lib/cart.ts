import { isStorefrontError, type Cart, type CartItemInput } from '@weldsuite/commerce-sdk';

import { storefront } from './client';
import { getCartToken, setCartToken } from './storage';

/** Adds `item` to the shopper's cart, or starts a cart with it (none yet, or the old one was checked out or expired). */
export async function addToCart(item: CartItemInput): Promise<Cart> {
  const token = getCartToken();
  if (token) {
    try {
      return await storefront().cart.addItem(token, item);
    } catch (error) {
      if (!isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) throw error;
    }
  }
  const created = await storefront().cart.create({ items: [item] });
  setCartToken(created.cartToken);
  return created.cart;
}

/** A form's text field, trimmed. */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** A whole number between min and max, or null. */
export function wholeNumber(form: FormData, name: string, min: number, max: number): number | null {
  const raw = field(form, name);
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}
