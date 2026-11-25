/**
 * The renderer calls the storefront API as the *hosted* principal (ADR
 * COM-018): no channel key, but the install's renderer secret and the shop
 * host, which the API resolves to the host's channel. `@weldsuite/commerce-sdk`
 * only knows keys, so the client is made with the placeholder key
 * `wcs_hosted` and this `fetch`, which swaps the SDK's `Authorization:
 * Bearer wcs_hosted` for `Authorization: Hosted <secret>` and adds
 * `X-Storefront-Host`.
 */

import type { FetchLike } from '@weldsuite/commerce-sdk';

export const HOSTED_KEY = 'wcs_hosted';

export function hostedFetch(secret: string, host: string, base: FetchLike = (input, init) => fetch(input, init)): FetchLike {
  if (!secret) throw new Error('STOREFRONT_RENDERER_SECRET is not set');
  return (input, init) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Hosted ${secret}`);
    headers.set('X-Storefront-Host', host);
    return base(input, { ...init, headers });
  };
}
