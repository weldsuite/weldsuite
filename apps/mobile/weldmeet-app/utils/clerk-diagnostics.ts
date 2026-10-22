/**
 * Connectivity probe for the boot screen.
 *
 * `@clerk/react` swallows a failed headless `clerk.load()` (it only flips its
 * status to "error"), so when the sign-in service cannot be reached the app
 * used to stay blank with nothing in the log. The boot screen runs this probe
 * once it gives up waiting, so the failure shows up as a line of text (host and
 * HTTP status, or the network error) instead of nothing.
 */

/** `pk_test_<base64(frontendApi + "$")>`; null when the key is missing or malformed. */
export function frontendApiFromPublishableKey(publishableKey: string | undefined): string | null {
  const encoded = publishableKey?.split('_').slice(2).join('_');
  if (!encoded) return null;
  try {
    // atob is installed by polyfills.ts (and by Hermes itself on current React Native).
    const host = globalThis.atob(encoded).replace(/\$$/, '');
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ status: number }>;

/**
 * One GET of Clerk's public `/v1/environment` endpoint, summarised as a short
 * line for the boot screen. Never throws.
 */
export async function probeClerkFrontendApi(
  publishableKey: string | undefined,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 8000,
): Promise<string> {
  const host = frontendApiFromPublishableKey(publishableKey);
  if (!host) return 'Missing or invalid EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://${host}/v1/environment?_is_native=1`, {
      signal: controller.signal,
      headers: { 'x-mobile': '1' },
    });
    return `${host}: HTTP ${response.status}`;
  } catch (error) {
    let reason = String(error);
    if (controller.signal.aborted) reason = `no response after ${Math.round(timeoutMs / 1000)}s`;
    else if (error instanceof Error) reason = error.message;
    return `${host}: ${reason}`;
  } finally {
    clearTimeout(timer);
  }
}
