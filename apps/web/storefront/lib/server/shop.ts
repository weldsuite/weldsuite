/**
 * Everything a server function needs about the request it serves: the shop
 * host and site, the storefront client, the shopper's IP, and the shopper
 * and cart behind the cookies (each read once per request).
 */

import { isStorefrontError, type Cart, type RequestOptions, type Shopper, type ShopperCompany, type StorefrontClient } from '@weldsuite/commerce-sdk';
import { getRequest } from '@tanstack/react-start/server';
import type { PublishedDocument } from '@weldsuite/storefront-theme';
import { COOKIE, readCookie } from '../cookies';
import { edgeVersion, isHttps, shopHost, shopperIp } from '../forwarded';
import { storefrontFor } from './commerce';
import { getCartToken, getShopperToken } from './session';
import { loadSite, type SiteResponse } from './site';

export interface ShopRequest {
  request: Request;
  host: string;
  https: boolean;
  site: SiteResponse;
  doc: PublishedDocument;
  client: StorefrontClient;
  /** The shopper's IP for every API call (`X-Shopper-Ip`). */
  options: RequestOptions;
}

/** The request's preview token (the `wsf_preview` cookie). */
export function previewToken(request: Request): string | undefined {
  return readCookie(request.headers.get('cookie'), COOKIE.preview);
}

const contexts = new WeakMap<Request, Promise<ShopRequest>>();

/** The shop of the current request. */
export function shopRequest(): Promise<ShopRequest> {
  const request = getRequest();
  const known = contexts.get(request);
  if (known) return known;
  const created = (async () => {
    const headers = request.headers;
    const host = shopHost(headers);
    const site = await loadSite({ host, previewToken: previewToken(request), versionHint: edgeVersion(headers) });
    const ip = shopperIp(headers);
    return {
      request,
      host,
      https: isHttps(headers),
      site,
      doc: site.version.document,
      client: storefrontFor(host),
      options: ip ? { shopperIp: ip } : {},
    };
  })();
  contexts.set(request, created);
  return created;
}

const shoppers = new WeakMap<Request, Promise<Shopper | null>>();

/**
 * The signed-in shopper, or null (no session, or it expired). Only a live
 * session is sent with other calls (`sessionToken`), so a stale cookie never
 * turns a guest's cart call into a 401.
 */
export function currentShopper(shop: ShopRequest): Promise<Shopper | null> {
  const known = shoppers.get(shop.request);
  if (known) return known;
  const token = getShopperToken();
  const loaded = token
    ? shop.client.account.get(token, shop.options).catch((error: unknown) => {
        if (isStorefrontError(error, 'SESSION_EXPIRED', 'SESSION_REQUIRED')) return null;
        throw error;
      })
    : Promise.resolve(null);
  shoppers.set(shop.request, loaded);
  return loaded;
}

/** The session token while the session is good. */
export async function sessionToken(shop: ShopRequest): Promise<string | undefined> {
  return (await currentShopper(shop)) ? getShopperToken() : undefined;
}

/** The company the shopper buys for, with their role in it. */
export function activeCompany(shopper: Shopper | null): ShopperCompany | null {
  if (!shopper?.activeCompanyId) return null;
  return shopper.companies.find((company) => company.id === shopper.activeCompanyId) ?? null;
}

const carts = new WeakMap<Request, Promise<Cart | null>>();

/** The shopper's open cart, or null (none, checked out or expired). */
export function currentCart(shop: ShopRequest): Promise<Cart | null> {
  const known = carts.get(shop.request);
  if (known) return known;
  const token = getCartToken();
  const loaded = token
    ? (async () => {
        try {
          const cart = await shop.client.cart.get(token, { ...shop.options, shopperToken: await sessionToken(shop) });
          return cart.status === 'open' || cart.status === 'checkout' ? cart : null;
        } catch (error) {
          if (isStorefrontError(error, 'CART_NOT_FOUND', 'CART_NOT_OPEN')) return null;
          throw error;
        }
      })()
    : Promise.resolve(null);
  carts.set(shop.request, loaded);
  return loaded;
}

/** Options for a cart call: the shopper's IP and live session. */
export async function cartOptions(shop: ShopRequest): Promise<RequestOptions & { shopperToken?: string }> {
  return { ...shop.options, shopperToken: await sessionToken(shop) };
}
