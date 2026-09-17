/**
 * Resolve app-api / developer-portal / external-api hosts for login + API calls.
 */

const PROD_EXTERNAL = 'https://api.weldsuite.org';
const TEST_EXTERNAL = 'https://api-test.weldsuite.org';
const PROD_APP_API = 'https://app-api.weldsuite.org';
const TEST_APP_API = 'https://app-api-test.weldsuite.org';
const PROD_LOGIN = 'https://developer.weldsuite.org';
const TEST_LOGIN = 'https://developer-test.weldsuite.org';

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function looksLikeTest(url: string): boolean {
  return /api-test\.weldsuite\.org|app-api-test\.weldsuite\.org|developer-test\.weldsuite\.org|-test\./.test(
    url,
  );
}

export function defaultExternalApiUrl(): string {
  return trimSlash(process.env.WELD_API_URL ?? PROD_EXTERNAL);
}

export function resolveAppApiUrl(externalApiUrl?: string): string {
  if (process.env.WELD_APP_API_URL) return trimSlash(process.env.WELD_APP_API_URL);
  const external = externalApiUrl ?? defaultExternalApiUrl();
  return looksLikeTest(external) ? TEST_APP_API : PROD_APP_API;
}

export function resolveLoginUrl(externalApiUrl?: string): string {
  if (process.env.WELD_LOGIN_URL) return trimSlash(process.env.WELD_LOGIN_URL);
  const external = externalApiUrl ?? defaultExternalApiUrl();
  return looksLikeTest(external) ? TEST_LOGIN : PROD_LOGIN;
}

export { PROD_EXTERNAL, TEST_EXTERNAL, PROD_APP_API, TEST_APP_API, PROD_LOGIN, TEST_LOGIN };
