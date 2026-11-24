import type { ShopAccess } from '@weldsuite/storefront-theme';

/**
 * B2B gating (`settings.access`): `prices_signed_in` hides prices and add to
 * cart from guests; `signed_in` sends guests to `/account` from every
 * catalogue page. Content pages (legal ones included), sign-in, a guest's
 * order link and the Mollie return page stay open.
 */
export function showsPrices(access: ShopAccess, signedIn: boolean): boolean {
  return signedIn || access === 'public';
}

export function catalogueClosed(access: ShopAccess, signedIn: boolean): boolean {
  return access === 'signed_in' && !signedIn;
}

/** Buying (cart, checkout, quick order) needs prices. */
export function buyingClosed(access: ShopAccess, signedIn: boolean): boolean {
  return !showsPrices(access, signedIn);
}
