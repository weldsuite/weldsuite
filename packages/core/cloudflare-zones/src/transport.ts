/**
 * The `fetch` the zones SDK client uses. Unset means the SDK's own (real
 * api.cloudflare.com). Tests stub it; the test environment's DNS sandbox
 * (`./sandbox`) overlays it. Module state, so it applies per isolate.
 */

import type { ClientOptions } from 'cloudflare/client';

/** The SDK's `fetch` signature. */
export type ZonesFetch = NonNullable<ClientOptions['fetch']>;

let transport: ZonesFetch | undefined;

export function getZonesTransport(): ZonesFetch | undefined {
  return transport;
}

/** @internal Set by tests and by `configureZonesSandbox`. `undefined` restores the real transport. */
export function setZonesTransport(fetch: ZonesFetch | undefined): void {
  transport = fetch;
}
