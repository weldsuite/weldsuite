/**
 * personal-api client for consumer WeldCalendar (no workspace required).
 * Same pairing rules as WeldMail mobile.
 */

import { PersonalApiClient } from '@weldsuite/personal-api-client';
import { resolvePersonalApiUrl } from '@/services/personal-api-url';

export { resolvePersonalApiUrl };

export const PERSONAL_API_URL = resolvePersonalApiUrl();

let tokenGetter: () => Promise<string | null> = async () => null;

export function setPersonalApiTokenGetter(fn: (() => Promise<string | null>) | null) {
  tokenGetter = fn ?? (async () => null);
}

export const personalApi = new PersonalApiClient(PERSONAL_API_URL, () => tokenGetter());

export default personalApi;
