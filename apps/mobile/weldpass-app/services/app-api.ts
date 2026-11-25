/**
 * The API client for WeldPass mobile: the server's `/api/weldpass/*` routes
 * (WeldSuite EU, or a self-hosted server), the same endpoints the platform
 * and the browser extension use.
 *
 * Every request names the client (`X-WeldPass-Client: mobile`), which the
 * server records with each reveal in the vault's trail.
 *
 * The host is read per request, so nothing here may read the runtime at
 * import time. A module-level token getter is wired from `app/_layout.tsx`
 * (`setAppApiTokenGetter`); the client re-reads it on every request.
 *
 * Domain clients return `{ data }` / `{ data, pagination }` and throw on
 * non-2xx (`ApiError`, or `NetworkError` when the server can't be reached).
 */

import { createMobileApiClient } from '@weldsuite/mobile-platform/api';
import { createWorkspacesApi } from '@weldsuite/app-api-client/domains/workspaces';
import { createMeApi } from '@weldsuite/app-api-client/domains/me';
import { createWeldPassPasswordsApi } from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { createWeldPassDevicesApi } from '@weldsuite/app-api-client/domains/weldpass-devices';

import { APP } from '@/lib/server';

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

/** Wire the session token getter. Called from `app/_layout.tsx`. */
export function setAppApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (() => Promise.resolve(null));
}

/** Recorded by the server on reveals (`Caller.client` in rust/modules/pass). */
export const CLIENT_HEADERS = { 'X-WeldPass-Client': 'mobile' } as const;

const { client } = createMobileApiClient({
  appCode: APP.code,
  getToken: () => tokenGetter(),
  getExtraHeaders: () => ({ ...CLIENT_HEADERS }),
});

export const appApi = {
  workspaces: createWorkspacesApi(client),
  me: createMeApi(client),
  passwords: createWeldPassPasswordsApi(client),
  /** Devices and the offline copy (ADR PASS-010): Rust servers only. */
  devices: createWeldPassDevicesApi(client),
};

export { client as appApiClient };

export default appApi;
