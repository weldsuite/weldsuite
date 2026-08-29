import { PersonalApiClient } from '@weldsuite/personal-api-client';

export const PERSONAL_API_URL =
  (import.meta.env.VITE_PERSONAL_API_URL as string | undefined) ||
  'http://localhost:8787';

let tokenGetter: () => Promise<string | null> = async () => null;

/** Wire Clerk `getToken` from a signed-in tree. */
export function setPersonalApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

export const personalApi = new PersonalApiClient(PERSONAL_API_URL, () => tokenGetter());
