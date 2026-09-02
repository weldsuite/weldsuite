/**
 * personal-api client for consumer WeldMail (no workspace required).
 *
 * Mirrors `services/app-api.ts`: a module-level token getter is wired from
 * `app/_layout.tsx` via Clerk credentials.
 */

import { PersonalApiClient } from '@weldsuite/personal-api-client';

const PERSONAL_API_BY_APP_API: Record<string, string> = {
  'https://app-api-test.weldsuite.org': 'https://personal-api-test.weldsuite.org',
  'https://app-api.weldsuite.org': 'https://personal-api.weldsuite.org',
};

/**
 * Pick the personal-api host that matches app-api (and therefore the Clerk
 * instance). A test Clerk JWT against production personal-api fails
 * `verifyToken` and leaves Create address disabled.
 */
export function resolvePersonalApiUrl(
  personalUrl = process.env.EXPO_PUBLIC_PERSONAL_API_URL,
  appApiUrl = process.env.EXPO_PUBLIC_APP_API_URL,
): string {
  const appApi = (appApiUrl || '').replace(/\/$/, '');
  const paired = PERSONAL_API_BY_APP_API[appApi];
  if (paired) return paired;
  return personalUrl || 'http://localhost:8787';
}

/** personal-api base URL. Paired with app-api when that host is known. */
export const PERSONAL_API_URL = resolvePersonalApiUrl();

let tokenGetter: () => Promise<string | null> = async () => null;

/** Wire the Clerk token getter. Called from `app/_layout.tsx`. */
export function setPersonalApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

export const personalApi = new PersonalApiClient(PERSONAL_API_URL, () => tokenGetter());

export default personalApi;
