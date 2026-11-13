/**
 * personal-api client for consumer WeldMail (no workspace required).
 *
 * Mirrors `services/app-api.ts`: a module-level token getter is wired from
 * `app/_layout.tsx` via the session credentials. The base URL comes from the
 * booted server runtime (`personalApiOrigin()`), so the client is built on first
 * use after boot rather than at import time, and rebuilt if the origin changes.
 */

import { PersonalApiClient } from '@weldsuite/personal-api-client';
import { lazyClient, personalApiOrigin } from '@weldsuite/mobile-platform/api';

let tokenGetter: () => Promise<string | null> = () => Promise.resolve(null);

/** Wire the session token getter. Called from `app/_layout.tsx`. */
export function setPersonalApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (() => Promise.resolve(null));
}

export const personalApi: PersonalApiClient = lazyClient(personalApiOrigin, (origin) => new PersonalApiClient(origin, () => tokenGetter()));

export default personalApi;
