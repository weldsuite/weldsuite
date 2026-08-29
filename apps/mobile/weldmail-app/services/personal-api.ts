/**
 * personal-api client for consumer WeldMail (no workspace required).
 *
 * Mirrors `services/app-api.ts`: a module-level token getter is wired from
 * `app/_layout.tsx` via Clerk credentials.
 */

import { PersonalApiClient } from '@weldsuite/personal-api-client';

/** personal-api base URL. Defaults to the local wrangler dev port. */
export const PERSONAL_API_URL =
  process.env.EXPO_PUBLIC_PERSONAL_API_URL || 'http://localhost:8787';

let tokenGetter: () => Promise<string | null> = async () => null;

/** Wire the Clerk token getter. Called from `app/_layout.tsx`. */
export function setPersonalApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

export const personalApi = new PersonalApiClient(PERSONAL_API_URL, () => tokenGetter());

export default personalApi;
