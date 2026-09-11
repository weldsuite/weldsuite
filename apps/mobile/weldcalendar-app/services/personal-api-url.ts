/**
 * Pick the personal-api host that matches app-api (and therefore the Clerk
 * instance). A test Clerk JWT against production personal-api fails
 * `verifyToken`.
 */

const PERSONAL_API_BY_APP_API: Record<string, string> = {
  'https://app-api-test.weldsuite.org': 'https://personal-api-test.weldsuite.org',
  'https://app-api.weldsuite.org': 'https://personal-api.weldsuite.org',
};

export function resolvePersonalApiUrl(
  personalUrl = process.env.EXPO_PUBLIC_PERSONAL_API_URL,
  appApiUrl = process.env.EXPO_PUBLIC_APP_API_URL,
): string {
  const appApi = (appApiUrl || '').replace(/\/$/, '');
  const paired = PERSONAL_API_BY_APP_API[appApi];
  if (paired) return paired;
  return personalUrl || 'http://localhost:8787';
}
