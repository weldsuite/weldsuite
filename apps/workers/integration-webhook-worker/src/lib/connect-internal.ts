/**
 * Calls to connect-api's internal integration routes.
 *
 * Preferred path: the `CONNECT_INTERNAL` service binding to connect-api's
 * `ConnectInternal` entrypoint. A named entrypoint is only reachable over a
 * binding, so it is trusted by topology and no secret is sent.
 *
 * Fallback (binding not configured, or the entrypoint not deployed yet): the
 * old path through app-api's forwarder with `X-Internal-Secret`. It goes once
 * every environment has the binding (docs/plans/app-api-module-split.md,
 * rollout item 7).
 */

export interface ConnectInternalEnv {
  /** connect-api `ConnectInternal` entrypoint (service binding). */
  CONNECT_INTERNAL?: Fetcher;
  /** app-api service binding — fallback path only. */
  APP_API?: Fetcher;
  /** Fallback path only; must match app-api / connect-api's secret. */
  INTERNAL_API_SECRET?: string;
}

/** True when at least one path to connect-api's internal routes is bound. */
export function hasConnectInternal(env: ConnectInternalEnv): boolean {
  return Boolean(env.CONNECT_INTERNAL || env.APP_API);
}

/** A named entrypoint that is not exported (yet) fails the call before any handler runs. */
function isMissingEntrypoint(err: unknown): boolean {
  return err instanceof Error && /entrypoint/i.test(err.message);
}

export async function fetchConnectInternal(
  env: ConnectInternalEnv,
  path: string,
  init: { method: string; headers: HeadersInit; body?: string },
): Promise<Response> {
  const url = `https://internal${path}`;

  if (env.CONNECT_INTERNAL) {
    try {
      return await env.CONNECT_INTERNAL.fetch(url, init);
    } catch (err) {
      if (!isMissingEntrypoint(err)) throw err;
      console.warn('[ConnectInternal] entrypoint unavailable, falling back to app-api:', err);
    }
  }

  if (!env.APP_API) throw new Error('No binding to connect-api internal routes (CONNECT_INTERNAL / APP_API)');
  const headers = new Headers(init.headers);
  headers.set('X-Internal-Secret', env.INTERNAL_API_SECRET || '');
  return env.APP_API.fetch(url, { ...init, headers });
}
