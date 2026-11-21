import 'server-only';

import { isStorefrontError, type Cart, type Shopper, type ShopperCompany } from '@weldsuite/commerce-sdk';
import { cache } from 'react';

import { requestOptions, storefront } from './commerce';
import { getCartToken, getShopperToken } from './session';

/*
 * Reads for server components. `cache` makes each one run once per request,
 * however many components ask.
 */

export const getChannel = cache(async () => storefront().channel.get(await requestOptions()));

export const getCategories = cache(async () => storefront().categories.list(await requestOptions()));

/** The signed-in shopper, or null (no session, or it expired). */
export const getShopper = cache(async (): Promise<Shopper | null> => {
  const token = await getShopperToken();
  if (!token) return null;
  try {
    return await storefront().account.get(token, await requestOptions());
  } catch (error) {
    if (isStorefrontError(error) && (error.status === 401 || error.status === 403)) return null;
    throw error;
  }
});

/** The shopper's session token when the session is still good. */
export async function getSessionToken(): Promise<string | undefined> {
  return (await getShopper()) ? getShopperToken() : undefined;
}

/** The company the shopper buys for, with their role in it. */
export function activeCompany(shopper: Shopper | null): ShopperCompany | null {
  if (!shopper?.activeCompanyId) return null;
  return shopper.companies.find((c) => c.id === shopper.activeCompanyId) ?? null;
}

/** The shopper's cart, or null when there is none (or it was checked out or expired). */
export const getCart = cache(async (): Promise<Cart | null> => {
  const token = await getCartToken();
  if (!token) return null;
  try {
    const cart = await storefront().cart.get(token, {
      ...(await requestOptions()),
      shopperToken: await getSessionToken(),
    });
    return cart.status === 'open' || cart.status === 'checkout' ? cart : null;
  } catch (error) {
    if (isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) return null;
    throw error;
  }
});
